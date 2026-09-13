import { HttpError, requireConfiguration, issueSession, readSession, sameSecret, requireSameOrigin, boundedBody, digest } from './security.js';
import { sanitizeWebP } from './webp.js';
import { communityRoute, cleanupDeleted } from './community.js';

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const MAX_BYTES = 5 * 1024 * 1024;
async function limit(binding, key) {
  if (!binding) throw new HttpError(503, 'PhoTown no está disponible en este momento.');
  if (!(await binding.limit({ key })).success) throw new HttpError(429, 'Espera un minuto antes de volver a intentar.');
}
async function route(request, env) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new HttpError(403, 'Abre PhoTown mediante HTTPS.');
  }
  if (env.DB && (url.pathname.startsWith('/api/') || ['/camera','/preview','/my-photos','/wall','/admin'].includes(url.pathname))) {
    requireConfiguration(env);
    return communityRoute(request, env);
  }
  if (url.pathname.startsWith('/api/')) {
    requireConfiguration(env);
    if (request.method === 'POST') requireSameOrigin(request);
    if (url.pathname === '/api/enter' && request.method === 'POST') {
      await limit(env.ENTRY_LIMITER, await digest(request.headers.get('CF-Connecting-IP') || 'local'));
      if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new HttpError(415, 'No se reconoce la solicitud.');
      let body;
      try { body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'No se reconoce la solicitud.'); }
      if (typeof body?.code !== 'string' || body.code.length > 256 || !(await sameSecret(body.code, env.INVITE_CODE))) throw new HttpError(401, 'El código no es correcto. Comprueba tu invitación.');
      return json({ authenticated: true }, 200, { 'Set-Cookie': await issueSession(env, request) });
    }
    const session = await readSession(env, request);
    if (url.pathname === '/api/session' && request.method === 'GET') return json({ authenticated: Boolean(session) });
    if (!session) throw new HttpError(401, 'Tu acceso ha caducado. Introduce de nuevo tu código de invitación.');
    if (url.pathname === '/api/photos' && request.method === 'POST') {
      await limit(env.UPLOAD_LIMITER, session.id);
      if (!env.PHOTOS) throw new HttpError(503, 'No se puede guardar la fotografía en este momento.');
      const id = request.headers.get('Idempotency-Key');
      if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new HttpError(400, 'No se reconoce el envío. Vuelve a fotografiar.');
      if (request.headers.get('Content-Type') !== 'image/webp') throw new HttpError(415, 'Solo se admiten fotografías WebP de PhoTown.');
      const image = sanitizeWebP(await boundedBody(request, MAX_BYTES));
      const hash = await digest(image.bytes);
      // The random capture id survives retry/session renewal. Conditional creation
      // is atomic in R2, including simultaneous retries from separate Workers.
      const key = `photos/${id}.webp`;
      const existing = await env.PHOTOS.head(key);
      if (existing) {
        if (existing.customMetadata.sha256 !== hash) throw new HttpError(409, 'Este envío corresponde a otra fotografía. Vuelve a fotografiar.');
        return json({ id, status: 'stored' });
      }
      const stored = await env.PHOTOS.put(key, image.bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'image/webp', cacheControl: 'private, no-store' },
        customMetadata: { sha256: hash, created_at: new Date().toISOString(), width: String(image.width), height: String(image.height), stage: 'sprint-1' }
      });
      if (!stored) {
        const winner = await env.PHOTOS.head(key);
        if (winner?.customMetadata.sha256 !== hash) throw new HttpError(409, 'No se pudo confirmar esta fotografía. Vuelve a intentar.');
      }
      return json({ id, status: 'stored' }, stored ? 201 : 200);
    }
    throw new HttpError(404, 'Esta operación no está disponible.');
  }
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Método no permitido.');
  if (['/camera', '/preview'].includes(url.pathname)) {
    requireConfiguration(env);
    if (!(await readSession(env, request))) return new Response(null, { status: 302, headers: { Location: '/enter' } });
  }
  if (['/', '/enter', '/camera', '/preview'].includes(url.pathname)) {
    return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  }
  // No route serves R2 objects, lists photographs, or exposes configuration.
  if (['/app.js', '/admin.js', '/processing.js', '/styles.css', '/robots.txt'].includes(url.pathname)) return env.ASSETS.fetch(request);
  return new Response('Página no encontrada', { status: 404 });
}
export default {
  async scheduled(event, env, context) { context.waitUntil(cleanupDeleted(env)); },
  async fetch(request, env) {
    let response;
    try { response = await route(request, env); }
    catch (error) {
      response = error instanceof HttpError ? json({ error: error.message }, error.status) : json({ error: 'No se pudo guardar la fotografía. Inténtalo de nuevo.' }, 503);
      if (response.status === 429) response.headers.set('Retry-After', '60');
    }
    const secured = new Response(response.body, response);
    secured.headers.set('Cache-Control', 'private, no-store');
    secured.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('Referrer-Policy', 'no-referrer');
    secured.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    secured.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (new URL(request.url).protocol === 'https:') secured.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return secured;
  }
};
