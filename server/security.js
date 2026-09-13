const encoder = new TextEncoder();
const COOKIE = 'photown_access';
const SESSION_SECONDS = 12 * 60 * 60;
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireConfiguration(env) {
  if (!env.INVITE_CODE || env.INVITE_CODE.length < 24 || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new HttpError(503, 'PhoTown todavía no está preparado. Contacta con quien te invitó.');
  }
}
export async function digest(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sameSecret(a, b) {
  // Fixed-length digests avoid an early exit based on the matching prefix.
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
export async function issueSession(env, request) {
  const payload = `${crypto.randomUUID()}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmac(env.SESSION_SECRET), encoder.encode(payload)));
  const hex = [...signature].map(b => b.toString(16).padStart(2, '0')).join('');
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${payload}.${hex}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`;
}
export async function readSession(env, request) {
  const token = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || token.length > 200) return null;
  const match = /^([a-f0-9-]{36})\.(\d{10})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[2]) <= Date.now() / 1000) return null;
  const bytes = Uint8Array.from(match[3].match(/../g), pair => parseInt(pair, 16));
  const valid = await crypto.subtle.verify('HMAC', await hmac(env.SESSION_SECRET), bytes, encoder.encode(`${match[1]}.${match[2]}`));
  return valid ? { id: match[1] } : null;
}
export function requireSameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new HttpError(403, 'Abre PhoTown de nuevo para continuar.');
}
export async function boundedBody(request, maximum) {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new HttpError(413, 'El archivo es demasiado grande.');
  if (!request.body) throw new HttpError(400, 'No se ha recibido ningún contenido.');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new HttpError(413, 'El archivo es demasiado grande.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
