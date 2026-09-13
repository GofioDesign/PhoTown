import { capture } from './processing.js';
import { renderAdmin } from './admin.js';

const root = document.querySelector('#app');
let stream;
let shot;
let shotUrl;
let busy = false;
let renderVersion = 0;
let authenticated = false;
let groupName = '';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabels = { uploading: 'Envío incompleto', pending: 'Pendiente de revisión', published: 'En el muro', hidden: 'Fuera del muro', deleting: 'Borrado pendiente' };

function stopCamera() {
  stream?.getTracks().forEach(track => track.stop());
  stream = undefined;
}
function clearShot() {
  if (shotUrl) URL.revokeObjectURL(shotUrl);
  shot = shotUrl = undefined;
}
function message(text, selector = '#message') {
  const element = document.querySelector(selector);
  if (element) element.textContent = text;
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(path, { ...options, credentials: 'same-origin', signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('PhoTown no ha podido confirmar la operación. Vuelve a intentarlo.'); }
    if (!response.ok) {
      const error = new Error(data.error || 'No se pudo completar la operación. Inténtalo de nuevo.');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') {
      throw new Error('No hemos podido confirmar el envío. Comprueba tu conexión y vuelve a intentarlo.');
    }
    throw error;
  } finally { clearTimeout(timeout); }
}
function navigate(path, replace = false) {
  if (busy) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
function shell(content) {
  root.innerHTML = content;
  root.setAttribute('aria-busy', 'false');
  const heading = root.querySelector('h1, h2');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  root.querySelectorAll('[data-route]').forEach(element => element.addEventListener('click', event => {
    event.preventDefault();
    navigate(element.dataset.route);
  }));
}
function connection() {
  message(navigator.onLine ? '' : 'Sin conexión. Puedes fotografiar y enviar cuando vuelva la conexión.', '#connection');
}
function topbar(label) {
  return `<header class="topbar"><a class="brand" href="/" data-route="/">PHOTOWN</a><span>${label}</span>${authenticated ? '<nav aria-label="Menú de participante"><a href="/camera" data-route="/camera">Cámara</a><a href="/my-photos" data-route="/my-photos">Mis fotos</a><a href="/wall" data-route="/wall">Muro</a><a href="/enter" data-route="/enter">Cambiar de grupo</a></nav>' : ''}</header>`;
}
function entryForm(renew = false) {
  shell(`<section class="entry"><p class="eyebrow">PHOTOWN</p><h2>${renew ? 'Vuelve a entrar.' : 'Fotografía lo que te llame la atención.'}</h2><p>En PhoTown fotografiamos en blanco y negro.<br>Después lo miraremos juntos.</p><form id="entry"><label for="code">Código de invitación</label><input id="code" name="code" type="text" required maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="message"><button class="primary" type="submit">${renew ? 'Continuar con mi fotografía' : 'Entrar en PhoTown'}</button></form><p id="message" class="message" role="alert"></p><p class="note">${renew ? 'Tu captura sigue aquí mientras mantengas esta página abierta.' : 'Solo necesitas tu invitación. No te pedimos nombre ni correo.'}</p></section>`);
  document.querySelector('#entry').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = event.target.querySelector('button');
    button.disabled = true;
    message('Comprobando invitación…');
    try {
      await api('/api/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: event.target.elements.code.value }) });
      groupName = (await api('/api/session')).group?.name || '';
      authenticated = true;
      busy = false;
      navigate(shot ? '/preview' : '/camera', true);
    } catch (error) { message(error.message); }
    finally { busy = false; button.disabled = false; }
  });
}
const cameraErrors = {
  NotAllowedError: 'Permite el acceso a la cámara en los ajustes de este sitio y vuelve a intentar.',
  NotFoundError: 'No encontramos una cámara. Abre PhoTown en un dispositivo con cámara.',
  NotReadableError: 'La cámara está ocupada o no está disponible. Cierra otras aplicaciones que la estén usando y vuelve a intentar.',
  OverconstrainedError: 'No se pudo abrir esta cámara. Vuelve a intentar.',
  SecurityError: 'El navegador ha bloqueado la cámara. Revisa los permisos del sitio.',
  AbortError: 'Se interrumpió la cámara. Vuelve a intentar.'
};
async function camera(version) {
  shell(`<section class="camera-shell">${topbar('BLANCO Y NEGRO')}<h1 class="sr-only">Cámara</h1><div class="viewfinder" id="capture-area"><video id="camera" autoplay muted playsinline aria-label="Vista en directo de la cámara en blanco y negro"></video><p id="camera-message" class="camera-message" role="status">Abriendo la cámara…</p></div><div class="controls"><button id="shutter" class="shutter" aria-label="Fotografiar" aria-describedby="capture-help" disabled></button><button id="retry-camera" hidden>Volver a abrir la cámara</button></div><p id="capture-help" class="note">Toca la imagen o pulsa Fotografiar para hacer la foto.</p><p id="message" class="message" role="alert"></p><p id="connection" class="connection" role="status"></p></section>`);
  connection();
  const video = document.querySelector('video');
  const shutter = document.querySelector('#shutter');
  const retry = document.querySelector('#retry-camera');
  document.querySelector('.camera-shell').addEventListener('click', event => {
    if (event.target.closest('button, a, input, select, textarea, label, nav, header')) return;
    if (!shutter.disabled) shutter.click();
  });
  retry.addEventListener('click', () => render());
  shutter.addEventListener('click', async () => {
    if (busy || !stream || video.readyState < 2) return;
    busy = true;
    shutter.disabled = true;
    message('Preparando fotografía…');
    try {
      const captured = await capture(video);
      if (version !== renderVersion) return;
      clearShot();
      shot = captured;
      shotUrl = URL.createObjectURL(shot.blob);
      busy = false;
      navigate('/preview');
    } catch (error) { message(error.message); }
    finally { busy = false; shutter.disabled = false; }
  });
  try {
    if (!window.isSecureContext) throw new Error('Abre PhoTown con una conexión HTTPS para utilizar la cámara.');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite abrir la cámara. Prueba con una versión reciente de Safari, Chrome o Firefox.');
    const opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } } });
    if (version !== renderVersion || document.hidden) { opened.getTracks().forEach(track => track.stop()); return; }
    stream = opened;
    video.srcObject = stream;
    await video.play();
    if (version !== renderVersion) return;
    message('', '#camera-message');
    shutter.disabled = false;
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
      if (version !== renderVersion) return;
      shutter.disabled = true;
      retry.hidden = false;
      message('La cámara se ha cerrado. Vuelve a abrirla.', '#camera-message');
    });
  } catch (error) {
    if (version !== renderVersion) return;
    stopCamera();
    message(cameraErrors[error.name] || error.message || 'No se pudo abrir la cámara. Vuelve a intentar.', '#camera-message');
    retry.hidden = false;
  }
}
function preview() {
  if (!shot) { navigate('/camera', true); return; }
  shell(`<section class="camera-shell">${topbar('TU FOTOGRAFÍA')}<h1 class="sr-only">Vista previa de tu fotografía</h1><div class="viewfinder"><img class="photograph" id="photo" alt="Tu fotografía en blanco y negro"></div><div class="controls"><button id="again">Repetir</button><button class="primary" id="publish">Enviar</button></div><p id="message" class="message" role="status"></p><p id="connection" class="connection" role="status"></p></section>`);
  document.querySelector('#photo').src = shotUrl;
  connection();
  document.querySelector('#again').addEventListener('click', () => {
    if (busy) return;
    clearShot();
    navigate('/camera', true);
  });
  document.querySelector('#publish').addEventListener('click', async () => {
    if (busy || !shot) return;
    busy = true;
    const buttons = [...root.querySelectorAll('button')];
    buttons.forEach(button => button.disabled = true);
    message('Enviando fotografía…');
    try {
      const result = await api('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/webp', 'Idempotency-Key': shot.id }, body: shot.blob });
      clearShot();
      shell(`<section class="entry"><p class="eyebrow">PHOTOWN</p><h2>Fotografía guardada.</h2><p>${result.status === 'pending' ? 'La persona que coordina el grupo la revisará antes de mostrarla en el muro.' : 'Gracias por compartir tu mirada.'}</p><button id="continue" class="primary">Seguir fotografiando</button><a class="button secondary-link" href="/my-photos" data-route="/my-photos">Ver mis fotos</a></section>`);
      document.querySelector('#continue').addEventListener('click', () => navigate('/camera', true));
    } catch (error) {
      if (error.status === 401) {
        authenticated = false;
        entryForm(true);
      } else {
        message(`${error.message}\nTu fotografía sigue aquí. Puedes volver a enviarla.`);
        document.querySelector('#publish').textContent = 'Reintentar envío';
      }
    } finally { busy = false; buttons.forEach(button => button.disabled = false); }
  });
}
async function confirmDeletion() {
  const previous = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'delete-title');
  dialog.setAttribute('aria-describedby', 'delete-detail');
  dialog.innerHTML = '<h2 id="delete-title">¿Borrar esta fotografía definitivamente?</h2><p id="delete-detail">Se retirará de tus fotos, del muro colectivo y del almacenamiento de PhoTown. No podrás recuperarla.</p><form method="dialog" class="controls"><button value="cancel" autofocus>Conservar fotografía</button><button value="delete">Borrar definitivamente</button></form>';
  root.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { const yes = dialog.returnValue === 'delete'; dialog.remove(); previous?.focus(); resolve(yes); }, { once: true });
    dialog.showModal();
  });
}
async function gallery(version, mine) {
  shell(`<section class="gallery-shell">${topbar(mine ? 'MIS FOTOS' : 'MURO COLECTIVO')}<h1>${mine ? 'Mis fotos' : 'Muro colectivo'}</h1><p class="note">${escape(groupName)}${mine ? ' · Estas fotos pertenecen a tu identidad en este navegador. Si borras sus cookies, perderás el acceso a ellas.' : ''}</p><p id="message" class="message" role="status">Cargando fotografías…</p><div id="photos" class="photo-grid"></div><button id="more" hidden>Cargar más fotografías</button></section>`);
  const container = root.querySelector('#photos'), more = root.querySelector('#more');
  let cursor, loading = false;
  const load = async () => {
    if (loading) return;
    loading = true; more.disabled = true;
    try {
      const page = await api(`${mine ? '/api/my-photos' : '/api/wall'}${cursor ? '?before=' + encodeURIComponent(cursor) : ''}`);
      if (version !== renderVersion) return;
      for (const photo of page.photos) {
        const card = document.createElement('article'); card.className = 'photo-card';
        const unavailable = ['uploading','deleting'].includes(photo.status);
        card.innerHTML = `${unavailable ? '<p>La fotografía no está disponible.</p>' : `<img loading="lazy" src="/api/images/${photo.id}" alt="${escape(photo.description || 'Fotografía en blanco y negro, sin descripción disponible.')}">`}${mine ? `<p class="note">${escape(statusLabels[photo.status])} · ${escape(new Date(photo.created_at).toLocaleDateString('es'))}</p><form class="description-form"><label for="description-${photo.id}">Descripción de la imagen (opcional)</label><textarea id="description-${photo.id}" maxlength="500" rows="3">${escape(photo.description)}</textarea><button type="submit">Guardar descripción</button></form><button class="delete-photo">${photo.status === 'deleting' ? 'Reintentar borrado' : 'Borrar fotografía'}</button><p class="card-message" role="status"></p>` : ''}`;
        if (mine) {
          const status = card.querySelector('.card-message');
          card.querySelector('.description-form').addEventListener('submit', async event => {
            event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
            try { await api(`/api/my-photos/${photo.id}/description`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: event.target.querySelector('textarea').value }) }); status.textContent = 'Descripción guardada.'; const img = card.querySelector('img'); if (img) img.alt = event.target.querySelector('textarea').value || 'Fotografía en blanco y negro, sin descripción disponible.'; }
            catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
          });
          card.querySelector('.delete-photo').addEventListener('click', async event => {
            if (!(await confirmDeletion())) return;
            event.target.disabled = true;
            try { await api(`/api/my-photos/${photo.id}`, { method: 'DELETE' }); card.remove(); message('Fotografía borrada definitivamente.'); root.querySelector('h1').focus(); }
            catch (error) { status.textContent = `${error.message} Puedes reintentar el borrado.`; event.target.disabled = false; }
          });
        }
        container.append(card);
      }
      cursor = page.next; more.hidden = !cursor;
      message(container.children.length ? '' : mine ? 'Todavía no has enviado fotografías a este grupo.' : 'Todavía no hay fotografías aprobadas en este grupo.');
    } catch (error) {
      if (version !== renderVersion) return;
      message(error.message); more.hidden = false; more.textContent = 'Reintentar carga';
      if (error.status === 401) { authenticated = false; navigate('/enter', true); }
    } finally { loading = false; more.disabled = false; }
  };
  more.addEventListener('click', load); await load();
}
function render() {
  const version = ++renderVersion;
  stopCamera();
  const path = location.pathname;
  if (path === '/') {
    shell(`<section class="entry"><h1 class="wordmark">PHOTOWN</h1><p class="intro">Un diario fotográfico compartido.</p><button class="primary" id="enter">Entrar</button><a class="secondary-link" href="/admin" data-route="/admin">Administración</a></section>`);
    document.querySelector('#enter').addEventListener('click', () => navigate(authenticated ? '/camera' : '/enter'));
  } else if (path === '/enter') entryForm(Boolean(shot));
  else if (path === '/admin') renderAdmin({ root, api, shell, current: () => version === renderVersion, confirmDeletion });
  else if (['/camera','/preview','/my-photos','/wall'].includes(path)) {
    if (!authenticated) { navigate('/enter', true); return; }
    if (path === '/camera') camera(version);
    else if (path === '/preview') preview();
    else gallery(version, path === '/my-photos');
  } else shell(`<section class="entry"><h1>Esta página no existe.</h1><a class="button" href="/" data-route="/">Volver a PhoTown</a></section>`);
}
addEventListener('popstate', () => { if (!busy) render(); });
addEventListener('online', connection);
addEventListener('offline', connection);
addEventListener('pagehide', () => { ++renderVersion; stopCamera(); });
addEventListener('pageshow', event => { if (event.persisted) render(); });
document.addEventListener('visibilitychange', () => {
  if (location.pathname !== '/camera') return;
  if (document.hidden) { ++renderVersion; stopCamera(); }
  else if (!busy) render();
});
addEventListener('beforeunload', event => {
  if (shot || busy) { event.preventDefault(); event.returnValue = ''; }
});
try { const session = await api('/api/session'); authenticated = session.authenticated; groupName = session.group?.name || ''; }
catch { /* Entry remains available if the initial session check has no connection. */ }
render();
