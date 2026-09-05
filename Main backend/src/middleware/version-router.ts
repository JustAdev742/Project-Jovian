import { FastifyRequest, FastifyReply } from 'fastify';
import { Config } from '../config';
import { identifyVersion } from '../version/identify';

/**
 * Attach the client's version to the request.
 *
 * The parsing and the chapter/season lookup live in `src/version/` so they can be tested without a
 * server; this is only the Fastify glue.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A BEHAVIOUR CHANGE FOR 7.40. This used to set `season = major`
 * with the comment "In Ch1, major version = season number" — true, and true only for Chapter 1.
 * `gameVersion` now carries `major`, `minor`, `chapter`, `season` (season WITHIN the chapter),
 * `confidence` and `id`. For every Chapter 1 build the numeric values are identical to before,
 * because there season and major coincide; `version.test.ts` pins that for 7.40 specifically.
 *
 * THE TRAP THIS EXPOSED. Making `season` correct is not automatically safe for its consumers, and
 * one of them would have broken. Epic's timeline uses the CONTINUOUS major for `seasonNumber` and
 * `athenaseason<n>` — Calendar.md shows `seasonNumber: 24` for what the build registry independently
 * places at Chapter 4 Season 2. So the timeline wants `major`; a chapter-relative 2 would have told
 * a Chapter 4 client it was in Chapter 1 Season 2. Consumers that need a wire value read `major`;
 * `season`/`chapter` are for human-facing and per-chapter reasoning. See
 * `calendar.seasonNumber.isMajor` in `src/version/features.ts`.
 */
export async function versionRouter(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  (request as any).gameVersion = identifyVersion(
    request.headers as Record<string, unknown>,
    Config.SEASON_NUMBER,
  );
}
