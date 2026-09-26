import { capture } from './processing.js';
import { renderAdmin } from './admin.js';
import { setupInstall } from './install.js';
import { photoUI } from './photo-ui.js';
import { communityUI } from './community-ui.js';
import { GRIDS, gridName, gridSVG, fitOverlay } from './grids.js';
import './outbox.js';

const outbox = self.PhotownOutbox;
const root = document.querySelector('#app');
let stream;
let shot;
let shotUrl;
let busy = false;
let renderVersion = 0;
let authenticated = false;
let account = { email: '', unread: 0, digest: true };
let groupName = '';
let groupId = '';
let memberGroups = [];
let challenges = [];
let loginEmail = '';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = () => ({ id: groupId, name: groupName, groups: memberGroups, account, challenges, refresh: refreshSession });
const ui = photoUI({ root, api, shell, navigate, state, current: version => version === renderVersion, confirmDeletion, logout });
const community = communityUI({ root, api, shell, navigate, state, current: version => version === renderVersion, ui });

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
      throw new Error('No hay conexión con PhoTown. Comprueba tu conexión y vuelve a intentarlo.');
    }
    throw error;
  } finally { clearTimeout(timeout); }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  message(navigator.onLine ? '' : 'Sin conexión. Puedes seguir fotografiando: las fotos se enviarán al volver la conexión.', '#connection');
}
function topbar() {
  return '<header class="capture-header"><a class="brand" href="/wall" data-route="/wall">PHOTOWN</a><button data-route="/wall" aria-label="Volver al muro">×</button></header>';
}
async function refreshSession() {
  const session = await api('/api/session'); authenticated = session.authenticated;
  groupName = session.group?.name || ''; groupId = session.group?.id || '';
  account = { email: session.email || '', unread: session.unread || 0, digest: session.digest !== false, identity: session.identity };
  memberGroups = authenticated ? (await api('/api/groups')).groups : [];
  challenges = authenticated && groupId ? (await api('/api/challenges').catch(() => ({ challenges: [] }))).challenges : [];
}
async function logout() {
  await post('/api/logout', {});
  authenticated = false; groupId = groupName = ''; memberGroups = []; challenges = [];
  navigate('/login', true);
}

// Passwordless entry: email → link or 6-digit code.
function loginForm({ renew = false, notice = '' } = {}) {
  shell(`<section class="entry"><p class="eyebrow">PHOTOWN</p><h1 class="entry-title">${renew ? 'Vuelve a entrar.' : 'Entra con tu correo.'}</h1><p>${notice ? escape(notice) : 'Te enviaremos un enlace y un código para entrar. Sin contraseñas.'}</p>
    <form id="login"><label for="email">Correo electrónico</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" aria-describedby="message"><button class="primary" type="submit">Enviarme el acceso</button></form>
    <form id="code-form" hidden><p class="sent-to" role="status"></p><label for="code">Código de 6 números</label><input id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]{6,7}" aria-describedby="message"><button class="primary" type="submit">Entrar</button><button type="button" id="other-email" class="text-button">Usar otro correo</button></form>
    <p id="message" class="message" role="alert"></p><p id="dev-link" class="note" hidden></p>
    <p class="note">${renew ? 'Tus fotos pendientes siguen guardadas en este dispositivo.' : 'Solo pueden entrar personas invitadas. Si aún no lo estás, deja tu correo y te avisaremos.'}</p></section>`);
  const loginFormEl = root.querySelector('#login'), codeForm = root.querySelector('#code-form');
  loginFormEl.elements.email.value = loginEmail;
  const showCode = email => {
    loginEmail = email; loginFormEl.hidden = true; codeForm.hidden = false;
    codeForm.querySelector('.sent-to').textContent = `Si ${email} tiene invitación, acabamos de enviarle un enlace. Ábrelo en este dispositivo o escribe aquí el código del correo.`;
    codeForm.elements.code.focus();
  };
  loginFormEl.onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    const button = loginFormEl.querySelector('button'); button.disabled = true; message('Enviando…');
    try {
      const email = loginFormEl.elements.email.value.trim();
      const result = await post('/api/login', { email });
      message(''); showCode(email);
      if (result.dev_link) { const dev = root.querySelector('#dev-link'); dev.hidden = false; dev.innerHTML = `Modo local: <a href="${escape(result.dev_link)}">enlace de acceso</a> · código ${escape(result.dev_code)}`; }
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  };
  codeForm.onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    const button = codeForm.querySelector('[type=submit]'); button.disabled = true; message('Comprobando…');
    try { await finishLogin({ email: loginEmail, code: codeForm.elements.code.value }); }
    catch (error) { message(error.message); }
    finally { button.disabled = false; }
  };
  root.querySelector('#other-email').onclick = () => { codeForm.hidden = true; loginFormEl.hidden = false; message(''); loginFormEl.elements.email.focus(); };
}
async function finishLogin(body) {
  await post('/api/login/verify', body);
  await refreshSession();
  navigate(shot ? '/preview' : '/wall', true);
  flushOutbox();
}
function confirmLink(token) {
  shell(`<section class="entry"><p class="eyebrow">PHOTOWN</p><h1 class="entry-title">Ya casi estás.</h1><p>Confirma para entrar en PhoTown en este dispositivo.</p><button class="primary" id="confirm">Entrar en PhoTown</button><p id="message" class="message" role="alert"></p><a class="secondary-link" href="/login" data-route="/login">Pedir un enlace nuevo</a></section>`);
  root.querySelector('#confirm').onclick = async event => {
    event.target.disabled = true; message('Entrando…');
    try { await finishLogin({ token }); }
    catch (error) { message(error.message); event.target.disabled = false; }
  };
}

const cameraErrors = {
  NotAllowedError: 'Permite el acceso a la cámara en los ajustes de este sitio y vuelve a intentar.',
  NotFoundError: 'No encontramos una cámara. Abre PhoTown en un dispositivo con cámara.',
  NotReadableError: 'La cámara está ocupada o no está disponible. Cierra otras aplicaciones que la estén usando y vuelve a intentar.',
  OverconstrainedError: 'No se pudo abrir esta cámara. Vuelve a intentar.',
  SecurityError: 'El navegador ha bloqueado la cámara. Revisa los permisos del sitio.',
  AbortError: 'Se interrumpió la cámara. Vuelve a intentar.'
};
const stored = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
async function camera(version) {
  const challenge = challenges.find(item => item.id === new URLSearchParams(location.search).get('challenge') && item.active);
  let grid = challenge && challenge.grid !== 'none' ? challenge.grid : stored('photown-grid', 'none');
  let orientation = Number(stored('photown-spiral', '0')) || 0;
  shell(`<section class="camera-shell live-camera">${topbar()}<h1 class="sr-only">Cámara${challenge ? ', reto ' + escape(challenge.title) : ''}</h1>
    <div class="viewfinder" id="capture-area"><video id="camera" autoplay muted playsinline aria-label="Vista en directo de la cámara en blanco y negro"></video><div class="grid-holder" id="grid-holder"></div><p id="camera-message" class="camera-message" role="status">Abriendo la cámara…</p></div>
    <div class="camera-tools">${challenge ? `<p class="challenge-chip">Reto · ${escape(challenge.title)}</p>` : ''}<button id="grid-button" aria-haspopup="dialog">Guía</button><button id="rotate-grid" hidden>Girar</button></div>
    <div class="controls"><button id="shutter" class="shutter" aria-label="Fotografiar" aria-describedby="capture-help" disabled></button><button id="retry-camera" hidden>Volver a abrir la cámara</button></div><p id="capture-help" class="note">Toca la imagen o pulsa Fotografiar para hacer la foto.</p><p id="message" class="message" role="alert"></p><p id="connection" class="connection" role="status"></p></section>`);
  connection();
  const video = document.querySelector('video');
  const shutter = document.querySelector('#shutter');
  const retry = document.querySelector('#retry-camera');
  const holder = root.querySelector('#grid-holder'), area = root.querySelector('#capture-area');
  const gridButton = root.querySelector('#grid-button'), rotate = root.querySelector('#rotate-grid');
  area.append(root.querySelector('.controls'));
  const drawGrid = () => {
    const shown = fitOverlay(area, video, holder);
    holder.innerHTML = shown ? gridSVG(grid, shown.width, shown.height, orientation) : '';
    gridButton.textContent = `Guía: ${gridName(grid)}`;
    gridButton.setAttribute('aria-label', `Guía de composición: ${gridName(grid)}. Cambiar guía`);
    rotate.hidden = grid !== 'spiral';
  };
  const observer = new ResizeObserver(drawGrid); observer.observe(area);
  video.addEventListener('loadedmetadata', drawGrid);
  addEventListener('pagehide', () => observer.disconnect(), { once: true });
  rotate.onclick = () => { orientation = (orientation + 1) % 4; store('photown-spiral', String(orientation)); drawGrid(); };
  gridButton.onclick = () => {
    const previous = document.activeElement, dialog = document.createElement('dialog');
    dialog.className = 'grid-picker'; dialog.setAttribute('aria-labelledby', 'grid-title');
    dialog.innerHTML = `<h2 id="grid-title">Guía de composición</h2><div class="grid-options"></div><form method="dialog"><button>Cerrar</button></form>`;
    for (const option of GRIDS) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-pressed', String(option.id === grid));
      button.innerHTML = `<span class="grid-option-name"></span><span class="note"></span>`;
      button.querySelector('.grid-option-name').textContent = option.name; button.querySelector('.note').textContent = option.hint;
      button.onclick = () => { grid = option.id; if (!challenge) store('photown-grid', grid); drawGrid(); dialog.close(); };
      dialog.querySelector('.grid-options').append(button);
    }
    dialog.addEventListener('close', () => { dialog.remove(); previous?.focus(); }, { once: true });
    root.append(dialog); dialog.showModal();
  };
  drawGrid();
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
    if (event.target.closest('button, a, input, select, textarea, label, nav, header, dialog, .camera-tools')) return;
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
      shot = { ...captured, cameraUrl: location.pathname + location.search, challenge: challenge?.id || null, challengeGroup: challenge ? groupId : null, challengeTitle: challenge?.title || '' };
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
    drawGrid();
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
function receipt(text) {
  document.querySelector('.publication-receipt')?.remove();
  const note = document.createElement('p'); note.className = 'publication-receipt'; note.setAttribute('role', 'status');
  note.textContent = text; document.body.append(note);
  setTimeout(() => note.remove(), 8000);
}
function preview() {
  if (!shot) { navigate('/camera', true); return; }
  const open = memberGroups.filter(group => group.status !== 'BLOCKED');
  shell(`<section class="camera-shell capture-preview">${topbar()}<h1 class="sr-only">Vista previa de tu fotografía</h1><div class="viewfinder"><img class="photograph" id="photo" alt="Tu fotografía en blanco y negro"></div>
    <div class="preview-options"></div><div class="controls"><button id="again">Repetir</button><button class="primary" id="publish">Enviar</button></div><p id="message" class="message" role="status"></p><p id="connection" class="connection" role="status"></p></section>`);
  document.querySelector('#photo').src = shotUrl;
  const options = root.querySelector('.preview-options');
  if (shot.challenge) {
    const label = document.createElement('label'); label.className = 'challenge-toggle';
    label.innerHTML = '<input type="checkbox" id="for-challenge" checked> <span></span>';
    label.querySelector('span').textContent = `Para el reto «${shot.challengeTitle}»`;
    options.append(label);
  }
  const destinations = document.createElement('fieldset'); destinations.className = 'destinations';
  destinations.innerHTML = '<legend>Publicar en</legend>';
  destinations.hidden = open.length <= 1;
  for (const group of open) {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = group.id;
    input.checked = group.id === (shot.challengeGroup || groupId) || open.length === 1;
    label.append(input, document.createTextNode(group.name)); destinations.append(label);
  }
  options.append(destinations);
  connection();
  document.querySelector('#again').addEventListener('click', () => {
    if (busy) return;
    const back = shot.cameraUrl || '/camera';
    clearShot();
    navigate(back, true);
  });
  document.querySelector('#publish').addEventListener('click', async () => {
    if (busy || !shot) return;
    const selected = [...destinations.querySelectorAll('input:checked')];
    if (!selected.length) { message('Selecciona al menos un grupo.'); return; }
    const forChallenge = shot.challenge && root.querySelector('#for-challenge')?.checked;
    const item = { id: shot.id, created: Date.now(), blob: shot.blob, thumb: shot.thumb, deliveries: selected.map((input, index) => ({
      id: input.value, name: memberGroups.find(group => group.id === input.value)?.name || '', photoId: index === 0 ? shot.id : crypto.randomUUID(),
      challenge: forChallenge && input.value === shot.challengeGroup ? shot.challenge : null, result: null })) };
    busy = true; root.querySelectorAll('button, input').forEach(control => control.disabled = true);
    message('Guardando en este dispositivo…');
    let saved = true;
    try { await outbox.save(item); } catch { saved = false; }
    if (!saved) {
      // Without IndexedDB (some private modes) send from memory and stay here until it is done.
      message('Enviando fotografía…');
      const direct = await outbox.sendNow(shot.pendingItem || (shot.pendingItem = item));
      busy = false; root.querySelectorAll('button, input').forEach(control => control.disabled = false);
      if (!direct.done) { message(`${direct.failed[0]?.error || (direct.auth ? 'Tu sesión ha caducado. Vuelve a entrar para enviarla.' : 'Sin conexión.')} Mantén esta página abierta y vuelve a intentarlo.`); root.querySelector('#publish').textContent = 'Reintentar envío'; return; }
      clearShot(); navigate('/wall', true); receipt('Fotografía enviada.'); return;
    }
    busy = false; clearShot();
    navigate('/wall', true);
    const result = await flushOutbox(true);
    if (result?.auth) receipt('Tu sesión ha caducado. La foto está guardada: entra de nuevo para enviarla.');
    else if (result?.offline) receipt('Sin conexión. La foto está guardada y se enviará sola al volver la conexión.');
    else if (result?.failed.length) receipt(result.failed[0].error);
    else if (result?.sent) receipt(result.published === result.sent ? 'Fotografía publicada.' : 'Fotografía guardada. Pendiente de revisión.');
  });
}
// Sends waiting photographs and refreshes the pending indicator on the wall.
let lastFlush = null;
async function flushOutbox(quiet = false) {
  if (!authenticated) return null;
  try {
    lastFlush = await outbox.flush();
    if (lastFlush.offline) outbox.requestSync();
    if (!quiet && lastFlush.sent && location.pathname === '/wall') render();
    ui.outboxStatus?.(lastFlush);
    return lastFlush;
  } catch { return null; }
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
  const url = new URL(location.href);
  const path = url.pathname;
  if (path === '/login' && url.searchParams.has('token')) {
    const token = url.searchParams.get('token');
    history.replaceState({}, '', '/login');
    if (/^[a-f0-9]{64}$/.test(token)) { confirmLink(token); return; }
  }
  if (path === '/') {
    if (authenticated) { navigate(shot ? '/preview' : '/wall', true); return; }
    shell(`<section class="entry"><h1 class="wordmark">PHOTOWN</h1><p class="intro">Un diario fotográfico compartido.<br>Fotografiamos en blanco y negro y aprendemos mirando juntos.</p><button class="primary" id="enter">Entrar</button><button type="button" data-install>Instalar app</button><a class="secondary-link" href="/admin" data-route="/admin">Administración</a></section>`);
    document.querySelector('#enter').addEventListener('click', () => navigate(authenticated ? '/wall' : '/login'));
  } else if (path === '/login' || path === '/enter') {
    if (authenticated && !shot) { navigate('/wall', true); return; }
    const legacy = url.searchParams.has('inv');
    if (legacy) history.replaceState({}, '', '/login');
    loginForm({ renew: Boolean(shot), notice: legacy ? 'Las invitaciones con código ya no se usan: ahora entras con tu correo. Si no te llega el acceso, pide a quien coordina tu grupo que te invite por correo.' : '' });
  }
  else if (path === '/admin/wall') ui.gallery(version, false, new URLSearchParams(location.search).get('group') || 'invalid');
  else if (path === '/admin') renderAdmin({ root, api, shell, current: () => version === renderVersion, confirmDeletion });
  else if (['/camera','/preview','/my-photos','/wall','/settings','/challenges','/notifications'].includes(path)) {
    if (!authenticated) { navigate('/login', true); return; }
    if (path === '/camera') { if (shot) navigate('/preview', true); else camera(version); }
    else if (path === '/preview') preview();
    else if (path === '/settings') ui.settings(version);
    else if (path === '/challenges') community.challenges(version);
    else if (path === '/notifications') community.notifications(version);
    else ui.gallery(version, path === '/my-photos');
  } else shell(`<section class="entry"><h1>Esta página no existe.</h1><a class="button" href="/" data-route="/">Volver a PhoTown</a></section>`);
}
addEventListener('popstate', () => { if (!busy) render(); });
addEventListener('online', () => { connection(); flushOutbox(); });
document.addEventListener('fullscreenchange', () => { const button = document.querySelector('#fullscreen'); if (button) { button.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa'; button.setAttribute('aria-label', button.textContent); } });
addEventListener('offline', connection);
addEventListener('pagehide', () => { ++renderVersion; stopCamera(); });
addEventListener('pageshow', event => { if (event.persisted) render(); });
navigator.serviceWorker?.addEventListener('message', event => { if (event.data?.type === 'outbox') { lastFlush = event.data.result; ui.outboxStatus?.(lastFlush); } });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) flushOutbox();
  if (location.pathname !== '/camera') return;
  if (document.hidden) { ++renderVersion; stopCamera(); }
  else if (!busy) render();
});
addEventListener('beforeunload', event => {
  if (shot || busy) { event.preventDefault(); event.returnValue = ''; }
});
ui.retryOutbox = () => flushOutbox();
try { await refreshSession(); }
catch { /* Entry remains available if the initial session check has no connection. */ }
render();
flushOutbox();
