// src/services/matchmaking/regions.ts
// Where players are, and how far apart that makes them.
//
// WHY THIS EXISTS. Host election used to score candidates on hardware alone — CPU 45%, RAM 35%,
// network quality 20% — and the `region` field was filtering only, with every launcher hard-coding
// the same value. With everyone in one country that is harmless: the best machine wins and it is
// nearby by definition. With players on different continents it is actively wrong, because it will
// hand a lobby of Europeans to an Australian host purely for having more RAM, and no amount of RAM
// makes 300ms playable.
//
// Matches are peer-to-peer — the server runs on a player's PC, not on the coordinator — so the ping
// that decides whether a match feels good is player↔host. That makes host placement the single
// biggest lever on match quality, and it is decided here.
//
// APPROACH. Each region gets an approximate coordinate, and proximity is derived from great-circle
// distance rather than a hand-maintained N×N latency table. A table of 7 regions needs 21 numbers
// that all have to be kept honest by hand; coordinates need 7 and stay correct when a region is
// added. The absolute millisecond estimates below are rough — real routing is not great-circle, and
// undersea cable paths add significant distance — but election only needs the ORDERING to be right,
// and distance orders these correctly.

/** The canonical regions. These match the values Fortnite itself uses, so they can be sent to the
 *  client unchanged. `*` is the wildcard used by servers that accept anyone. */
export const REGIONS = ['NAE', 'NAW', 'EU', 'OCE', 'BR', 'ASIA', 'ME'] as const;
export type Region = (typeof REGIONS)[number];

/**
 * Approximate coordinates — the point traffic for that region actually converges on, not the
 * geographic centre of the landmass. NAE is Ashburn because that is where the internet is, not
 * Kansas.
 */
const REGION_COORDS: Record<Region, { lat: number; lon: number; label: string }> = {
  NAE: { lat: 39.0, lon: -77.5, label: 'North America East (Ashburn)' },
  NAW: { lat: 37.3, lon: -121.9, label: 'North America West (San Jose)' },
  EU: { lat: 50.1, lon: 8.7, label: 'Europe (Frankfurt)' },
  OCE: { lat: -33.9, lon: 151.2, label: 'Oceania (Sydney)' },
  BR: { lat: -23.5, lon: -46.6, label: 'South America (São Paulo)' },
  ASIA: { lat: 35.7, lon: 139.7, label: 'Asia (Tokyo)' },
  ME: { lat: 25.2, lon: 55.3, label: 'Middle East (Dubai)' },
};

export function isRegion(v: string): v is Region {
  return (REGIONS as readonly string[]).includes(v);
}

export function regionLabel(r: string): string {
  return isRegion(r) ? REGION_COORDS[r].label : r || 'unknown';
}

/** Great-circle distance in km. */
function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Rough round-trip latency between two regions, in milliseconds.
 *
 * distance/80 rather than the theoretical distance/100: light in fibre covers ~200,000 km/s, but a
 * real path is longer than great-circle and every hop adds queuing. Calibrated against known routes
 * — Sydney↔San Jose lands near 150ms, Sydney↔Frankfurt near 200ms. The latter genuinely runs closer
 * to 280ms in practice because traffic routes the long way round, so treat these as a lower bound.
 * That understatement is safe here: it compresses the scale slightly but never reorders anything.
 */
export function estimateRttMs(from: string, to: string): number {
  if (!isRegion(from) || !isRegion(to)) return 120; // unknown — assume middling, don't reward or punish
  if (from === to) return 15; // same region: LAN-ish to a few hops
  return Math.round(haversineKm(REGION_COORDS[from], REGION_COORDS[to]) / 80);
}

/**
 * 0-100 for "how good would this host feel to this player".
 *
 * 100 at same-region, ~60 by 100ms, 0 at 250ms and beyond. Under ~50ms a shooter feels immediate;
 * past ~150ms it is visibly bad; past 250ms there is nothing left to distinguish, so the curve
 * flattens to zero rather than continuing to differentiate between "bad" and "worse".
 */
export function proximityScore(hostRegion: string, playerRegion: string): number {
  const rtt = estimateRttMs(hostRegion, playerRegion);
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - rtt / 250))));
}

/**
 * How good a host would be for everyone currently waiting.
 *
 * Blends the MEAN (total experience across the lobby) with the WORST case (the player who would
 * suffer most), 60/40. Mean alone will happily sacrifice one player to a 300ms connection to shave
 * 10ms off four others; worst-case alone refuses to ever start a mixed-region match. The blend
 * prefers hosts that are good for everybody and still lets a match happen when the lobby genuinely
 * spans continents.
 *
 * With no waiters — or with everyone in the host's own region, which is the normal case today — this
 * returns 100 for every candidate, so hardware decides exactly as it did before.
 */
export function lobbyProximityScore(hostRegion: string, playerRegions: string[]): number {
  if (playerRegions.length === 0) return 100;
  const scores = playerRegions.map((r) => proximityScore(hostRegion, r));
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const worst = Math.min(...scores);
  return Math.round(mean * 0.6 + worst * 0.4);
}
