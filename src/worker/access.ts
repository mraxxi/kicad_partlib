import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Vars } from './env';

/**
 * Cloudflare Access sits in front of the Worker, but the Worker still verifies
 * the JWT Access forwards: a route reachable on a second hostname (workers.dev,
 * a preview) would otherwise bypass it. Fails CLOSED: with no Access config and
 * no explicit dev opt-in, every request is refused, with a sentence saying why.
 *
 * Service tokens (the CLI) arrive as the same header with a `common_name`
 * claim instead of an `email`.
 */
const remote = new Map<string, JWTVerifyGetKey>();

export function accessMiddleware(deps: { jwks?: JWTVerifyGetKey } = {}): MiddlewareHandler<{ Bindings: AppEnv; Variables: Vars }> {
  return async (c, next) => {
    // Accept "team.cloudflareaccess.com" or the pasted "https://team.cloudflareaccess.com/".
    const team = c.env.ACCESS_TEAM_DOMAIN.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const aud = c.env.ACCESS_AUD;
    if (team && aud) {
      const token = c.req.header('cf-access-jwt-assertion');
      if (!token) return c.json({ error: 'Sign in through Cloudflare Access to use this app.' }, 401);
      let keys = deps.jwks;
      if (!keys) {
        keys = remote.get(team) ?? createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
        remote.set(team, keys);
      }
      try {
        const { payload } = await jwtVerify(token, keys, { issuer: `https://${team}`, audience: aud });
        c.set('identity', String(payload['email'] ?? payload['common_name'] ?? payload.sub ?? 'unknown'));
      } catch {
        return c.json({ error: 'Your Cloudflare Access session is not valid; sign in again.' }, 401);
      }
    } else if (c.env.ALLOW_UNAUTHENTICATED === 'true') {
      c.set('identity', 'dev');
    } else {
      return c.json({ error: 'Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN and ACCESS_AUD), so every request is refused.' }, 503);
    }
    await next();
  };
}
