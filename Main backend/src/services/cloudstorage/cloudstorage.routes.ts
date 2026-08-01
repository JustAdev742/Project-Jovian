import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Config } from '../../config';
import { requireAuth } from '../../middleware/auth.middleware';

// Per-account ClientSettings persistence (keybinds, video/audio options, HUD layout). The client
// PUTs ClientSettings.Sav whenever the player changes a setting and GETs it back on login. If we
// only accept-and-discard (the old stub behaviour) the player's settings silently reset on every
// relaunch. Stored on disk keyed by account + season, mirroring LawinServer's ClientSettings-<n>.Sav.
const USER_STORAGE_DIR = path.join(Config.DATA_DIR, 'clientsettings');

/** Resolve the on-disk directory for an account, rejecting anything that could escape the store. */
function safeAccountDir(accountId: string): string | null {
  const clean = String(accountId || '').replace(/[^A-Za-z0-9_.-]/g, '');
  // Refuse if sanitising changed the value (path separators / "..") or emptied it.
  if (!clean || clean !== String(accountId) || clean === '.' || clean === '..') return null;
  return path.join(USER_STORAGE_DIR, clean);
}

/** Season the client is running (set by versionRouter), so S7 and S8 settings don't clobber each other. */
function seasonOf(request: any): number {
  const s = request?.gameVersion?.season;
  return Number.isFinite(s) ? s : Config.SEASON_NUMBER;
}

function clientSettingsFile(accountId: string, season: number): string | null {
  const dir = safeAccountDir(accountId);
  if (!dir) return null;
  return path.join(dir, `ClientSettings-${season}.Sav`);
}

export async function cloudstorageRoutes(fastify: FastifyInstance): Promise<void> {
  // Before serving anything: make sure the hotfix set exists at all. See seedCloudstorageDefaults.
  seedCloudstorageDefaults();

  /** GET /fortnite/api/cloudstorage/system — list hotfix files */
  fastify.get('/fortnite/api/cloudstorage/system', async (request, reply) => {
    const files = getCloudstorageFiles();
    return reply.send(files.map(f => ({
      uniqueFilename: f.name,
      filename: f.name,
      hash: f.hash,
      hash256: f.hash256,
      length: f.length,
      contentType: 'application/octet-stream',
      uploaded: f.uploaded,
      storageType: 'S3',
      doNotCache: false,
    })));
  });

  /** GET /fortnite/api/cloudstorage/system/:filename — serve individual hotfix file */
  fastify.get('/fortnite/api/cloudstorage/system/:filename', async (request, reply) => {
    const { filename } = request.params as { filename: string };
    // Reject anything that isn't a plain filename (no path separators / "..") to prevent traversal.
    const base = path.basename(filename || '');
    if (!base || base !== filename) {
      return reply.status(204).send();
    }
    const resolved = path.resolve(Config.CLOUDSTORAGE_DIR, base);
    if (!resolved.startsWith(path.resolve(Config.CLOUDSTORAGE_DIR) + path.sep)) {
      return reply.status(204).send();
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return reply.status(204).send(); // don't readFile a directory (EISDIR → 500)
      reply.header('Content-Type', 'application/octet-stream');
      return reply.send(await fs.promises.readFile(resolved));
    } catch {
      return reply.status(204).send();
    }
  });

  /** GET /fortnite/api/cloudstorage/user/:accountId — list the player's saved cloud files. */
  // The :accountId segment is decorative — the store is always keyed by the TOKEN's account, never
  // by a path param the caller controls. Trusting the param let anyone read or overwrite another
  // player's ClientSettings.Sav (keybinds, video settings, HUD layout).
  fastify.get('/fortnite/api/cloudstorage/user/:accountId', { preHandler: requireAuth }, async (request, reply) => {
    const accountId = (request as any).accountId as string;
    const file = clientSettingsFile(accountId, seasonOf(request));
    if (file && fs.existsSync(file)) {
      const content = fs.readFileSync(file);
      const stat = fs.statSync(file);
      return reply.send([{
        uniqueFilename: 'ClientSettings.Sav',
        filename: 'ClientSettings.Sav',
        hash: crypto.createHash('sha1').update(content).digest('hex'),
        hash256: crypto.createHash('sha256').update(content).digest('hex'),
        length: content.length,
        contentType: 'application/octet-stream',
        uploaded: stat.mtime,
        storageType: 'S3',
        storageIds: {},
        accountId,
        doNotCache: false,
      }]);
    }
    return reply.send([]);
  });

  /** GET user file — the client fetches ClientSettings.Sav on login to restore settings. */
  fastify.get('/fortnite/api/cloudstorage/user/:accountId/:filename', { preHandler: requireAuth }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const accountId = (request as any).accountId as string;
    // Only ClientSettings.Sav is a real persisted file; anything else is accepted-but-empty.
    if (String(filename).toLowerCase() !== 'clientsettings.sav') return reply.status(204).send();
    const file = clientSettingsFile(accountId, seasonOf(request));
    if (file && fs.existsSync(file)) {
      reply.header('Content-Type', 'application/octet-stream');
      return reply.send(fs.readFileSync(file));
    }
    return reply.status(204).send();
  });

  /** PUT user file — the client saves ClientSettings.Sav whenever the player changes settings. */
  fastify.put('/fortnite/api/cloudstorage/user/:accountId/:filename', { preHandler: requireAuth }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const accountId = (request as any).accountId as string;
    if (String(filename).toLowerCase() !== 'clientsettings.sav') return reply.status(204).send();
    // The '*'/octet-stream parsers give us a Buffer for the real binary .Sav; guard the rare non-Buffer.
    const raw: any = request.body;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw == null ? '' : (typeof raw === 'string' ? raw : JSON.stringify(raw)));
    if (buf.length >= 400000) return reply.status(403).send({ error: 'File size must be less than 400kb.' });
    const dir = safeAccountDir(accountId);
    if (!dir) return reply.status(204).send();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `ClientSettings-${seasonOf(request)}.Sav`), buf);
    } catch (e: any) {
      console.warn(`[CloudStorage] Failed to save ClientSettings for ${accountId}: ${e?.message || e}`);
    }
    return reply.status(204).send();
  });
}

/**
 * The hotfix that decides whether the game can start, written from the port we actually listen on.
 *
 * This is not a convenience default. Fortnite fetches `DefaultEngine.ini` from cloudstorage at login
 * and applies it OVER every local config layer, and it reads the XMPP address lazily at connection
 * time — so whatever is here is what the client uses, and no amount of patching Engine.ini on the
 * player's disk can beat it. Two ways that has already broken a player's game:
 *
 *   • The file said `ws://127.0.0.1:80` (the ws:// default port) for two months. Nothing listens
 *     there, so the XMPP socket died and the client force-logged-out ~400ms after a SUCCESSFUL
 *     login, reporting "Fortnite was not started correctly" — which reads as a launcher fault.
 *   • `data/` is gitignored, and the backend bundled into the installer ships no `data/` at all. An
 *     installed machine therefore served an EMPTY hotfix set, the client kept Fortnite's compiled-in
 *     `wss://xmpp-service-prod.ol.epicgames.com:443`, and failed the same way for a different reason.
 *
 * Seeding removes both failure modes: the file cannot be missing, and it cannot drift from the port
 * because it is generated from it. Existing files are never overwritten — an operator who has edited
 * a hotfix keeps their version.
 */
function seedCloudstorageDefaults(): void {
  const port = Config.HTTP_PORT;
  const defaults: Record<string, string> = {
    'DefaultEngine.ini': `[OnlineSubsystemMcp.Xmpp]
bUseSSL=false
ServerAddr="ws://127.0.0.1:${port}"
ServerPort=${port}

[OnlineSubsystemMcp.Xmpp Prod]
bUseSSL=false
ServerAddr="ws://127.0.0.1:${port}"
ServerPort=${port}

[OnlineSubsystemMcp]
bUsePartySystemV2=false

[OnlineSubsystemMcp.OnlinePartySystemMcpAdapter]
bUsePartySystemV2=false

[XMPP]
bEnableWebsockets=true

[/Script/Engine.NetworkSettings]
n.VerifyPeer=false

[/Script/Qos.QosRegionManager]
NumTestsPerRegion=1
PingTimeout=3.0
`,
    'DefaultGame.ini': `[/Script/FortniteGame.FortGameInstance]
bAllowJoinInProgress=true

[/Script/FortniteGame.FortRuntimeOptions]
bEnableGlobalChat=true
bDisableGifting=false
bDisableGiftingPC=false
bDisableGiftingPS4=false
bDisableGiftingXB=false
`,
  };
  // KEEP THIS SET AS SMALL AS POSSIBLE — it is not tidiness, it is reliability.
  //
  // UE4 discards the ENTIRE hotfix batch if any single file fails to download, and Cobalt's curl
  // hook has a race that intermittently lets one request escape to Epic's real servers, where it
  // 401s. Observed twice: three of four files downloaded fine — including the corrected
  // DefaultEngine.ini — and the one lost request threw all of them away, leaving the client on its
  // built-in XMPP address and producing "Fortnite was not started correctly".
  //
  // Every file served is another chance for that race to fire, so the set is now the two that
  // actually matter. DefaultEngine.ini carries the XMPP address; DefaultGame.ini disables
  // anti-cheat and EOS, skips account linking, and enables Athena gameplay. The old
  // DefaultInput.ini was console keybinds (developer convenience) and DefaultRuntimeOptions.ini
  // was chat/gifting flags, whose section is Game-scoped and now lives in DefaultGame.ini.
  //
  // Going from four files to two halves the odds of losing a batch. It does NOT eliminate them —
  // the real fix is the hook, which needs the true curl_easy_setopt entry address resolved first.
  // Do not add files here casually.

  try {
    fs.mkdirSync(Config.CLOUDSTORAGE_DIR, { recursive: true });
    for (const [name, body] of Object.entries(defaults)) {
      const file = path.join(Config.CLOUDSTORAGE_DIR, name);
      if (fs.existsSync(file)) continue;
      fs.writeFileSync(file, body);
      console.log(`[CloudStorage] seeded missing hotfix ${name}`);
    }
  } catch (e: any) {
    // Not fatal, but say so — an empty hotfix set means every client falls back to Epic's live
    // addresses and cannot start, and that is not obvious from the client's error.
    console.warn(`[CloudStorage] could not seed hotfix defaults (${e?.message || e}) — clients may fail to start`);
  }
}

function getCloudstorageFiles(): { name: string; hash: string; hash256: string; length: number; uploaded: string }[] {
  if (!fs.existsSync(Config.CLOUDSTORAGE_DIR)) return [];
  const files = fs.readdirSync(Config.CLOUDSTORAGE_DIR).filter(f => f.endsWith('.ini'));
  return files.map(name => {
    const content = fs.readFileSync(path.join(Config.CLOUDSTORAGE_DIR, name));
    return {
      name,
      hash: crypto.createHash('sha1').update(content).digest('hex'),
      hash256: crypto.createHash('sha256').update(content).digest('hex'),
      length: content.length,
      uploaded: new Date().toISOString(),
    };
  });
}
