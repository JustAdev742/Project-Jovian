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
