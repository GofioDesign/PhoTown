import { createRemoteJWKSet, jwtVerify } from 'jose';
import { digest, HttpError } from './security.js';
import { cookieValue, cookieHeader, randomToken, signToken, verifyToken } from './tokens.js';
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export const adminEmails = env => (env.ADMIN_EMAILS || '').split(/[;,]/).map(v => v.trim().toLowerCase()).filter(Boolean);
export const googleReady = env => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && adminEmails(env).length);
export async function adminIdentity(request, env) {
  const identity = await verifyToken(env, cookieValue(request, 'photown_admin'), 'admin');
  return identity && typeof identity.email === 'string' && adminEmails(env).includes(identity.email) ? identity : null;
}
export function authorizeGoogleClaims(payload, env, nonce) {
  const email = payload.email?.toLowerCase();
  if (payload.nonce !== nonce || payload.email_verified !== true || !payload.sub || !adminEmails(env).includes(email)) {
    throw new HttpError(403, 'Esta cuenta de Google no tiene acceso a la administración de PhoTown.');
  }
  return { sub: payload.sub, email };
}
export async function googleStart(request, env, db) {
  if (!googleReady(env)) return new Response(null, { status: 302, headers: { Location: '/admin?login=unconfigured' } });
  const state = randomToken(), nonce = randomToken(), verifier = randomToken();
  const expiry = Math.floor(Date.now() / 1000) + 600;
  await db.batch([
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)),
    db.prepare('INSERT INTO oauth_states VALUES (?,?,?,?)').bind(await digest(state), nonce, verifier, expiry)
  ]);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: new URL('/api/admin/google/callback', request.url).href, response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return new Response(null, { status: 302, headers: { Location: url.href, 'Set-Cookie': cookieHeader(request, 'photown_oauth', state, 600, 'Lax') } });
}
export async function googleCallback(request, env, db) {
  const expired = cookieHeader(request, 'photown_oauth', '', 0, 'Lax');
  try {
    const url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code');
    if (!googleReady(env) || !state || state.length !== 64 || cookieValue(request, 'photown_oauth') !== state || !code || code.length > 4096) throw new Error('Invalid OAuth callback');
    // Consume the state atomically: a callback cannot be replayed.
    const saved = await db.prepare('DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING nonce,verifier').bind(await digest(state), Math.floor(Date.now() / 1000)).first();
    if (!saved) throw new Error('Expired OAuth state');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: new URL('/api/admin/google/callback', request.url).href, grant_type: 'authorization_code', code_verifier: saved.verifier })
    });
    if (!response.ok) throw new Error('Google exchange failed');
    const tokens = await response.json();
    const { payload } = await jwtVerify(tokens.id_token, GOOGLE_KEYS, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, algorithms: ['RS256'] });
    const admin = authorizeGoogleClaims(payload, env, saved.nonce);
    const headers = new Headers({ Location: '/admin' });
    headers.append('Set-Cookie', expired);
    headers.append('Set-Cookie', cookieHeader(request, 'photown_admin', await signToken(env, admin, 'admin', 28800), 28800));
    return new Response(null, { status: 302, headers });
  } catch {
    return new Response(null, { status: 302, headers: { Location: '/admin?login=failed', 'Set-Cookie': expired } });
  }
}
