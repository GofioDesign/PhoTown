import { capture } from './processing.js';
import { renderAdmin } from './admin.js';
import { setupInstall } from './install.js';
import { photoUI } from './photo-ui.js';

const root = document.querySelector('#app');
let stream;
let shot;
let shotUrl;
let busy = false;
let renderVersion = 0;
let authenticated = false;
let groupName = '';
let groupId = '';
let memberGroups = [];
let invitedCode = '';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ui = photoUI({ root, api, shell, navigate, state: () => ({ id: groupId, name: groupName, groups: memberGroups, refresh: refreshSession }), current: version => version === renderVersion, confirmDeletion });

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
  document.body.classList.toggle('immersive', Boolean(root.querySelector('.camera-shell')));
  setupInstall(root);
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
function topbar() {
  return '<header class="capture-header"><a class="brand" href="/wall" data-route="/wall">PHOTOWN</a><button data-route="/wall" aria-label="Volver al muro">×</button></header>';
}
async function refreshSession() {
  const session = await api('/api/session'); authenticated = session.authenticated;
  groupName = session.group?.name || ''; groupId = session.group?.id || '';
  memberGroups = authenticated ? (await api('/api/groups')).groups : [];
}
function entryForm(renew = false) {
  shell(`<section class="entry"><p class="eyebrow">PHOTOWN</p><h2>${renew ? 'Vuelve a entrar.' : 'Fotografía lo que te llame la atención.'}</h2><p>En PhoTown fotografiamos en blanco y negro.<br>Después lo miraremos juntos.</p><form id="entry"><label for="code">Código de invitación</label><input id="code" name="code" type="text" required maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="message"><button class="primary" type="submit">${renew ? 'Continuar con mi fotografía' : 'Entrar en PhoTown'}</button></form><p id="message" class="message" role="alert"></p><p class="note">${renew ? 'Tu captura sigue aquí mientras mantengas esta página abierta.' : 'Solo necesitas tu invitación. No te pedimos nombre ni correo.'}</p></section>`);
  document.querySelector('#code').value = invitedCode;
  if (!renew) {
    const waitlist = document.createElement('section'); waitlist.className = 'waitlist';
    waitlist.innerHTML = '<button class="waitlist-toggle" aria-expanded="false" aria-controls="waitlist-form">Quiero probarlo</button><form id="waitlist-form" hidden novalidate><label for="waitlist-email">Correo electrónico</label><input id="waitlist-email" name="email" type="email" autocomplete="email" maxlength="254" required aria-describedby="waitlist-help waitlist-message"><p class="note" id="waitlist-help">Guardaremos tu email en la lista de espera de PhoTown para poder avisarte cuando haya acceso. Solo podrá consultarlo el equipo administrador. Esta solicitud no da acceso a los grupos.</p><button>Entrar en lista de espera</button><p id="waitlist-message" role="status"></p></form>';
    root.querySelector('.entry').append(waitlist);
    const toggle = waitlist.querySelector('.waitlist-toggle'), form = waitlist.querySelector('form'), input = form.querySelector('input'), report = form.querySelector('[role=status]');
    toggle.onclick = () => { form.hidden = !form.hidden; toggle.setAttribute('aria-expanded', String(!form.hidden)); if (!form.hidden) input.focus(); };
    form.onsubmit = async event => {
      event.preventDefault(); input.removeAttribute('aria-invalid');
      if (!input.value.trim() || !input.validity.valid || !input.value.trim().split('@')[1]?.includes('.')) { input.setAttribute('aria-invalid', 'true'); report.textContent = 'Introduce un correo electrónico válido.'; input.focus(); return; }
      const button = form.querySelector('button'); if (button.disabled) return; button.disabled = true; report.textContent = 'Guardando tu solicitud…';
      try { await api('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: input.value }) }); report.textContent = 'Gracias. Te avisaremos cuando puedas entrar.'; input.value = ''; }
      catch (error) { report.textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  document.querySelector('#entry').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = event.target.querySelector('button');
    button.disabled = true;
    message('Comprobando invitación…');
    try {
      await api('/api/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: event.target.elements.code.value }) });
      await refreshSession();
      authenticated = true;
      invitedCode = '';
      busy = false;
      navigate(shot ? '/preview' : '/wall', true);
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
  shell(`<section class="camera-shell live-camera">${topbar('BLANCO Y NEGRO')}<h1 class="sr-only">Cámara</h1><div class="viewfinder" id="capture-area"><video id="camera" autoplay muted playsinline aria-label="Vista en directo de la cámara en blanco y negro"></video><p id="camera-message" class="camera-message" role="status">Abriendo la cámara…</p></div><div class="controls"><button id="shutter" class="shutter" aria-label="Fotografiar" aria-describedby="capture-help" disabled></button><button id="retry-camera" hidden>Volver a abrir la cámara</button></div><p id="capture-help" class="note">Toca la imagen o pulsa Fotografiar para hacer la foto.</p><p id="message" class="message" role="alert"></p><p id="connection" class="connection" role="status"></p></section>`);
  connection();
  const video = document.querySelector('video');
  const shutter = document.querySelector('#shutter');
  const retry = document.querySelector('#retry-camera');
  root.querySelector('#capture-area').append(root.querySelector('.controls'));
  if (document.fullscreenEnabled) {
    const fullscreen = document.createElement('button'); fullscreen.id = 'fullscreen'; fullscreen.type = 'button'; fullscreen.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
    fullscreen.setAttribute('aria-label', fullscreen.textContent);
    fullscreen.onclick = async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); fullscreen.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa'; }
      catch { message('Puedes instalar PhoTown para abrirla sin la barra del navegador.'); }
    };
    root.querySelector('.controls').append(fullscreen);
  }
  document.querySelector('.camera-shell').addEventListener('click', event => {
    if (event.target.closest('button, a, input, select, textarea, label, nav, header, dialog')) return;
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
      captured.groupId = groupId;
      captured.groupName = groupName;
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
  shell(`<section class="camera-shell capture-preview">${topbar()}<h1 class="sr-only">Vista previa de tu fotografía</h1><div class="viewfinder"><img class="photograph" id="photo" alt="Tu fotografía en blanco y negro"></div><div class="controls"><button id="again">Repetir</button><button class="primary" id="publish">Enviar</button></div><p id="message" class="message" role="status"></p><p id="connection" class="connection" role="status"></p></section>`);
  document.querySelector('#photo').src = shotUrl;
  const destination = document.createElement('p');
  destination.className = 'destination-context';
  destination.textContent = `Grupo de origen: ${shot.groupName || groupName}`;
  root.querySelector('.controls').before(destination);
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
      const result = await api('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/webp', 'Idempotency-Key': shot.id, 'X-Photown-Group': shot.groupId || groupId }, body: shot.blob });
      const pending = result.status === 'pending';
      clearShot();
      busy = false;
      navigate('/wall', true);
      const receipt = document.createElement('p'); receipt.className = 'publication-receipt'; receipt.setAttribute('role', 'status');
      receipt.textContent = pending ? 'Fotografía guardada. Pendiente de revisión.' : 'Fotografía publicada.';
      root.append(receipt);
      setTimeout(() => receipt.remove(), 8000);
    } catch (error) {
      if (error.status === 401) {
        authenticated = false;
        entryForm(true);
      } else {
        message(`${error.message}\nTu fotografía sigue aquí y puedes volver a enviarla al mismo grupo.`);
        document.querySelector('#publish').textContent = 'Reintentar envío';
      }
    } finally { busy = false; buttons.forEach(button => button.disabled = false); }
  });
}
async function confirmDeletion(items = []) {
  const previous = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'delete-title');
  dialog.setAttribute('aria-describedby', 'delete-detail');
  const groups = [...new Set(items.map(photo => photo.group_name).filter(Boolean))];
  dialog.innerHTML = `<h2 id="delete-title">¿Eliminar ${items.length > 1 ? 'estas ' + items.length + ' fotografías' : 'esta foto'}?</h2><p id="delete-detail">Se borrará${items.length > 1 ? 'n' : ''} definitivamente del almacenamiento y del muro${groups.length ? ' de ' + escape(groups.join(', ')) : ' colectivo'}. Las copias de otros grupos que no selecciones se conservan. No podrás recuperarla${items.length > 1 ? 's' : ''}.</p><form method="dialog" class="controls"><button value="cancel" autofocus>Cancelar</button><button value="delete">Eliminar definitivamente</button></form>`;
  root.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { const yes = dialog.returnValue === 'delete'; dialog.remove(); previous?.focus(); resolve(yes); }, { once: true });
    dialog.showModal();
  });
}
function render() {
  const version = ++renderVersion;
  stopCamera();
  const invitationUrl = new URL(location.href);
  if (['/', '/enter'].includes(invitationUrl.pathname) && invitationUrl.searchParams.has('inv')) {
    const code = invitationUrl.searchParams.get('inv');
    invitedCode = code.length <= 256 ? code : '';
    invitationUrl.searchParams.delete('inv');
    invitationUrl.pathname = '/enter';
    history.replaceState({}, '', invitationUrl.pathname + invitationUrl.search + invitationUrl.hash);
  }
  const path = location.pathname;
  if (path === '/') {
    if (authenticated) { navigate(shot ? '/preview' : '/wall', true); return; }
    shell(`<section class="entry"><h1 class="wordmark">PHOTOWN</h1><p class="intro">Un diario fotográfico compartido.</p><button class="primary" id="enter">Entrar</button><button type="button" data-install>Instalar app</button><a class="secondary-link" href="/admin" data-route="/admin">Administración</a></section>`);
    document.querySelector('#enter').addEventListener('click', () => navigate(authenticated ? '/wall' : '/enter'));
  } else if (path === '/enter') entryForm(Boolean(shot));
  else if (path === '/admin/wall') ui.gallery(version, false, new URLSearchParams(location.search).get('group') || 'invalid');
  else if (path === '/admin') renderAdmin({ root, api, shell, current: () => version === renderVersion, confirmDeletion });
  else if (['/camera','/preview','/my-photos','/wall','/settings'].includes(path)) {
    if (!authenticated) { navigate('/enter', true); return; }
    if (path === '/camera') { if (shot) navigate('/preview', true); else camera(version); }
    else if (path === '/preview') preview();
    else if (path === '/settings') ui.settings(version);
    else ui.gallery(version, path === '/my-photos');
  } else shell(`<section class="entry"><h1>Esta página no existe.</h1><a class="button" href="/" data-route="/">Volver a PhoTown</a></section>`);
}
addEventListener('popstate', () => { if (!busy) render(); });
addEventListener('online', connection);
document.addEventListener('fullscreenchange', () => { const button = document.querySelector('#fullscreen'); if (button) { button.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa'; button.setAttribute('aria-label', button.textContent); } });
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
try { await refreshSession(); }
catch { /* Entry remains available if the initial session check has no connection. */ }
render();
