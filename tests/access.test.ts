import { env } from 'cloudflare:workers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/worker/app';
import type { AppEnv } from '../src/worker/env';

const TEAM = 'owner.cloudflareaccess.com';
const AUD = 'aud-123';
const call = (e: Partial<AppEnv>, headers: Record<string, string> = {}, deps = {}) =>
  makeApp(deps).fetch(new Request('https://partlib.test/api/health', { headers }), { ...env, ...e } as AppEnv);

async function signer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, aud = AUD) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(`https://${TEAM}`)
      .setAudience(aud).setExpirationTime('5m').sign(privateKey);
  return { jwks, sign };
}

describe('Cloudflare Access', () => {
  it('refuses everything, saying why, when Access is not configured and dev mode is off', async () => {
    const res = await call({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ALLOW_UNAUTHENTICATED: 'false' });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toMatch(/not configured/);
  });
  it('rejects a request with no Access token', async () => {
    expect((await call({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })).status).toBe(401);
  });
  it('accepts a valid token and reads the email', async () => {
    const { jwks, sign } = await signer();
    const token = await sign({ email: 'me@example.com' });
    const res = await call({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, { 'cf-access-jwt-assertion': token }, { jwks });
    expect(res.status).toBe(200);
    expect((await res.json() as any).identity).toBe('me@example.com');
  });
  it('accepts a service token (no email) and uses its common_name', async () => {
    const { jwks, sign } = await signer();
    const token = await sign({ common_name: 'cli.access' });
    const res = await call({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, { 'cf-access-jwt-assertion': token }, { jwks });
    expect((await res.json() as any).identity).toBe('cli.access');
  });
  it('accepts the team domain pasted with https:// and a trailing slash', async () => {
    const { jwks, sign } = await signer();
    const token = await sign({ email: 'me@example.com' });
    const res = await call({ ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD }, { 'cf-access-jwt-assertion': token }, { jwks });
    expect(res.status).toBe(200);
  });
  it('rejects a token minted for another application', async () => {
    const { jwks, sign } = await signer();
    const token = await sign({ email: 'me@example.com' }, 'some-other-aud');
    const res = await call({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, { 'cf-access-jwt-assertion': token }, { jwks });
    expect(res.status).toBe(401);
  });
});
