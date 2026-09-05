/**
 * Epic's Fortnite game-client OAuth identities.
 *
 * WHY THIS EXISTS. `identifyVersion` had exactly one signal — the User-Agent — and the brief is
 * explicit that a single fragile heuristic is not enough when others are available. The client id in
 * the Basic auth header of `POST /account/api/oauth/token` is a second, independent one: it is sent
 * by the client itself, on the very first request, and it does not depend on the User-Agent being
 * parseable.
 *
 * WHAT IT DOES AND DOES NOT TELL YOU — and the second half matters more.
 *
 *   IT DOES give you the PLATFORM. All 17 rows below are CONFIRMED from EpicResearch
 *   `docs/auth/auth_clients.md`, which lists 112 clients with their ids and, where known, secrets.
 *
 *   IT DOES NOT give you the era. This was checked properly rather than assumed: the client table is
 *   partitioned by platform and storefront region, never by game version. There is ONE PC game
 *   client id covering everything the corpus knows about, so a 2019 Chapter 1 PC client and a
 *   Chapter 4 PC client are indistinguishable by client id. The words "chapter" and "season" do not
 *   appear anywhere in that corpus.
 *
 * THE ONE WEAK ERA SIGNAL, and it is a floor rather than a fix. Console-generation clients cannot
 * predate their hardware: a request bearing `fortnitePS5EUGameClient` did not come from a 2019
 * build. That is INFERRED from the client NAMES — the corpus does not state it — and it only ever
 * rules eras out. `notBeforeMajor` records it, deliberately conservative, and nothing in the backend
 * is allowed to treat it as a positive identification.
 */

/** How much the id tells us about when the client is from. */
export type EraSignal =
  /** Platform only. The id is era-agnostic — the normal case. */
  | 'NONE'
  /** Hardware did not exist before a point, so it rules earlier eras OUT. Never rules one IN. */
  | 'FLOOR';

export interface FortniteClient {
  /** Epic's own name for it, verbatim from the corpus. */
  name: string;
  clientId: string;
  /** Basic-auth secret where the corpus records one; null where it says "Unknown". */
  secret: string | null;
  platform: 'PC' | 'iOS' | 'Android' | 'Xbox' | 'PlayStation' | 'Switch' | 'China' | 'HongKong' | 'Unknown';
  eraSignal: EraSignal;
  /**
   * The earliest MAJOR this client can plausibly be, when hardware makes that knowable.
   *
   * INFERRED, not documented. PS5 and Xbox Series X launched November 2020, which is Chapter 2
   * Season 4 (major 14). The "New" Switch client is a later re-registration whose date is not
   * recorded anywhere, so it gets no floor rather than a guessed one.
   */
  notBeforeMajor?: number;
  /** Marked deprecated in the corpus. Only one client is, and only in its own name string. */
  deprecated?: boolean;
  /** Test/QA registrations. Never expected from a real player. */
  testClient?: boolean;
}

/**
 * CONFIRMED — transcribed from EpicResearch `docs/auth/auth_clients.md`. Ids and secrets are
 * verbatim; `platform`, `eraSignal` and `notBeforeMajor` are this project's annotations.
 */
export const FORTNITE_CLIENTS: readonly FortniteClient[] = [
  { name: 'fortnitePCGameClient',              clientId: 'ec684b8c687f479fadea3cb2ad83f5c6', secret: 'e1f31c211f28413186262d37a13fc84d', platform: 'PC',          eraSignal: 'NONE' },
  { name: 'fortniteIOSGameClient',             clientId: '3446cd72694c4a4485d81b77adbb2141', secret: '9209d4a5e25a457fb9b07489d313b41a', platform: 'iOS',         eraSignal: 'NONE' },
  { name: 'fortniteAndroidGameClient',         clientId: '3f69e56c7649492c8cc29f1af08a8a12', secret: 'b51ee9cb12234f50a69efa67ef53812e', platform: 'Android',     eraSignal: 'NONE' },
  { name: 'fortniteAndroidGameClient-deprecated', clientId: '72f83226ab664739b635b1e318a635bc', secret: '2f298cd32c6641fab2b0ceaa5bc9c92f', platform: 'Android', eraSignal: 'NONE', deprecated: true },
  { name: 'fortniteCNGameClient',              clientId: 'efe3cbb938804c74b20e109d0efc1548', secret: '6e31bdbae6a44f258474733db74f39ba', platform: 'China',       eraSignal: 'NONE' },
  { name: 'fortniteHKGameClient',              clientId: 'bb69d1e9bedb4c04a9e64a63a40aa2a4', secret: 'f7debd4825cf4929a19e3e4010641ab5', platform: 'HongKong',    eraSignal: 'NONE' },
  { name: 'fortniteValkyrieGameClient',        clientId: '3e13c5c57f594a578abe516eecb673fe', secret: '530e316c337e409893c55ec44f22cd62', platform: 'Unknown',     eraSignal: 'NONE' },
  { name: 'fortniteXboxGameClient',            clientId: 'cfaa14c4bf8744e3a5ef9a5d6c34558d', secret: null, platform: 'Xbox',        eraSignal: 'NONE' },
  // Series X|S launched Nov 2020 = Chapter 2 Season 4 = major 14.
  { name: 'fortniteXSXGameClient',             clientId: 'db84fa58b60e468ba64e3b17209b56e9', secret: null, platform: 'Xbox',        eraSignal: 'FLOOR', notBeforeMajor: 14 },
  { name: 'fortnitePS4EUGameClient',           clientId: '79a931b375334570ac369234f5da05ec', secret: null, platform: 'PlayStation', eraSignal: 'NONE' },
  { name: 'fortnitePS4USGameClient',           clientId: 'd8566f2e7f5c48f89683173eb529fee1', secret: null, platform: 'PlayStation', eraSignal: 'NONE' },
  // PS5 launched Nov 2020, same reasoning as XSX.
  { name: 'fortnitePS5EUGameClient',           clientId: '386cbbc78d57464181005c3f7edfad0d', secret: null, platform: 'PlayStation', eraSignal: 'FLOOR', notBeforeMajor: 14 },
  { name: 'fortnitePS5USGameClient',           clientId: '03f2645147214e1ab368caa78c5fca81', secret: null, platform: 'PlayStation', eraSignal: 'FLOOR', notBeforeMajor: 14 },
  { name: 'fortnitePS5USGameClientTest',       clientId: '3cf19c6ba05a4fa3997957491e15ba1c', secret: null, platform: 'PlayStation', eraSignal: 'FLOOR', notBeforeMajor: 14, testClient: true },
  { name: 'fortniteSwitchGameClient',          clientId: '5229dcd3ac3845208b496649092f251b', secret: 'e3bd2d3e-bf8c-4857-9e7d-f3d947d220c7', platform: 'Switch', eraSignal: 'NONE' },
  // A later re-registration. No date is recorded anywhere, so no floor is claimed.
  { name: 'fortniteNewSwitchGameClient',       clientId: '98f7e42c2e3a4f86a74eb43fbb41ed39', secret: '0a2449a2-001a-451e-afec-3e812901c4d7', platform: 'Switch', eraSignal: 'NONE' },
  { name: 'fortnitePCQAGameClientTest',        clientId: '81ffd992c8a94ccaaaa6bd74c073ce6a', secret: null, platform: 'PC',          eraSignal: 'NONE', testClient: true },
];

const BY_ID = new Map<string, FortniteClient>(FORTNITE_CLIENTS.map((c) => [c.clientId, c]));

/** Look up a client by the id in its Basic auth header. Null for anything not Epic's. */
export function clientById(clientId: string): FortniteClient | null {
  return BY_ID.get((clientId || '').trim()) ?? null;
}

/** The one Nova defaults to when a request carries no usable Basic auth. */
export const DEFAULT_PC_CLIENT_ID = 'ec684b8c687f479fadea3cb2ad83f5c6';

/**
 * Cross-check a parsed build against the client id.
 *
 * Returns a reason string when the two are inconsistent — a PS5 client claiming to be a 2019 build —
 * and null when they agree or when nothing can be said. Used to raise a `VERSION_MISMATCH`
 * diagnostic, never to reject a request: the floor is INFERRED, and refusing service on an inference
 * would be the project's own Rule 5 violation with a 403 attached.
 */
export function eraConflict(clientId: string, major: number): string | null {
  const c = BY_ID.get((clientId || '').trim());
  if (!c || c.eraSignal !== 'FLOOR' || c.notBeforeMajor === undefined) return null;
  if (major >= c.notBeforeMajor) return null;
  return `${c.name} cannot be build ${major}.x — that hardware post-dates it (floor: major ${c.notBeforeMajor})`;
}
