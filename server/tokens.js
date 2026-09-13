import { SignJWT, jwtVerify } from 'jose';
const bytes = new TextEncoder();
export function cookieValue(request, name) {
  return (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function cookieHeader(request, name, value, seconds, sameSite = 'Strict') {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function signToken(env, claims, audience, seconds) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuer('photown').setAudience(audience).setIssuedAt().setExpirationTime(`${seconds}s`).sign(bytes.encode(env.SESSION_SECRET));
}
export async function verifyToken(env, token, audience) {
  try { return (await jwtVerify(token, bytes.encode(env.SESSION_SECRET), { algorithms: ['HS256'], issuer: 'photown', audience })).payload; }
  catch { return null; }
}
