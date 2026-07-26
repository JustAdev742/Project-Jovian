import { FastifyRequest, FastifyReply } from 'fastify';
import { Config } from '../config';

/**
 * Version Router Middleware
 *
 * Intercepts the User-Agent header from the Fortnite client to detect the game version.
 * Format: "Fortnite/++Fortnite+Release-X.XX-CL-XXXXXXX Windows/10.0.xxxxx.xxx"
 *
 * This allows us to dynamically adjust responses for S7 vs S8 differences.
 */
export async function versionRouter(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userAgent = request.headers['user-agent'] || '';

  // Parse Fortnite version from User-Agent
  // Example: "Fortnite/++Fortnite+Release-7.40-CL-5046157 Windows/10.0.17763.1.256.64bit"
  const versionMatch = userAgent.match(/Release-(\d+)\.(\d+)/);

  if (versionMatch) {
    const majorVersion = parseInt(versionMatch[1], 10);
    const minorVersion = parseInt(versionMatch[2], 10);

    (request as any).gameVersion = {
      major: majorVersion,
      minor: minorVersion,
      season: majorVersion, // In Ch1, major version = season number
      buildString: userAgent,
    };
  } else {
    // Fall back to the CONFIGURED target season, not a hardcoded 8. Hardcoding it meant that on a
    // 7.40-only install every request with an unparseable UA (proxied/tunnelled traffic, the
    // launcher, tooling) was served the S8 lobby/LTM flag set — and it made the documented
    // `|| Config.SEASON_NUMBER` fallback in social.routes.ts unreachable.
    (request as any).gameVersion = {
      major: Config.SEASON_NUMBER,
      minor: 0,
      season: Config.SEASON_NUMBER,
      buildString: 'unknown',
    };
  }

  // Extract CL (changelist) number if present
  const clMatch = userAgent.match(/CL-(\d+)/);
  if (clMatch) {
    (request as any).gameVersion.changelist = parseInt(clMatch[1], 10);
  }
}
