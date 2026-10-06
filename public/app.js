import { capture } from './processing.js';
import { renderAdmin } from './admin.js';
import { setupInstall } from './install.js';
import { photoUI } from './photo-ui.js';
import { GRIDS, gridName, gridSVG, fitOverlay } from './grids.js';
import { clippingOverlay } from './clipping.js';
import { exposurePanel, exposureReport } from './exposure.js';

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
    const headers = new Headers(options.headers || {});
    const adminContext = new URLSearchParams(location.search).get('context');
    if (path.startsWith('/api/admin/') && adminContext && adminContext !== 'superadmin') headers.set('X-Photown-Admin-Group', adminContext);
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin', signal: controller.signal });
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
  shell(`<section class="entry"><p class="eyebrow">PHOTOWN</p><h2>${renew ? 'Vuelve a entrar.' : 'Fotografía lo que te llame la atención.'}</h2><p>En PhoTown fotografiamos en blanco y negro.<br>Después lo miraremos juntos.</p><form id="entry"><label for="code">Código de invitación</label><input id="code" name="code" type="text" required maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="message"><button class="primary" type="submit">${renew ? 'Continuar con mi fotografía' : 'Entrar en PhoTown'}</button></form><p id="message" class="message" role="alert"></p><p class="note">${renew ? 'Tu captura sigue aquí mientras mantengas esta página abierta.' : 'Solo necesitas tu invitación. No te pedimos nombre ni correo.'}</p><a class="secondary-link" href="/login" data-route="/login">Entrar con mi correo</a></section>`);
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
function loginPage() {
  const token = new URLSearchParams(location.search).get('token');
  const finish = async (body, button) => {
    if (busy) return;
    busy = true; button.disabled = true; message('Comprobando…');
    try {
      const result = await api('/api/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await refreshSession();
      busy = false;
      if (result.purpose === 'link') {
        shell(`<section class="entry"><p class="eyebrow">PHOTOWN</p><h1>Correo vinculado</h1><p></p><a class="button" href="/settings" data-route="/settings">Volver a Personalización</a></section>`);
        root.querySelector('section p:not(.eyebrow)').textContent = `Ya puedes entrar desde cualquier dispositivo con ${result.email}.`;
      } else navigate(authenticated ? (shot ? '/preview' : '/wall') : '/enter', true);
    } catch (error) { message(error.message); }
    finally { busy = false; button.disabled = false; }
  };
  if (token) {
    // Keep the one-use token out of the address bar and history.
    history.replaceState({}, '', '/login');
    shell('<section class="entry"><p class="eyebrow">PHOTOWN</p><h1>Confirma tu acceso</h1><p>Pulsa el botón para continuar en este navegador.</p><button class="primary" id="confirm-login">Continuar</button><p id="message" class="message" role="alert"></p></section>');
    root.querySelector('#confirm-login').onclick = event => finish({ token }, event.target);
    return;
  }
  shell('<section class="entry"><p class="eyebrow">PHOTOWN</p><h1>Entrar con tu correo</h1><p>Funciona si ya vinculaste tu correo desde Personalización.</p><form id="login-email"><label for="login-address">Correo electrónico</label><input id="login-address" name="email" type="email" autocomplete="email" maxlength="254" required><button class="primary" type="submit">Enviarme un acceso</button></form><form id="login-code" hidden><label for="login-digits">Código de 6 números</label><input id="login-digits" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required><button class="primary" type="submit">Entrar</button></form><p id="message" class="message" role="status"></p><a class="secondary-link" href="/enter" data-route="/enter">Tengo un código de invitación</a></section>');
  const emailForm = root.querySelector('#login-email'), codeForm = root.querySelector('#login-code');
  emailForm.onsubmit = async event => {
    event.preventDefault(); const button = emailForm.querySelector('button'); button.disabled = true; message('Enviando…');
    try {
      await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailForm.elements.email.value }) });
      message('Si ese correo está vinculado, te hemos enviado un enlace y un código. Revisa tu bandeja de entrada.');
      codeForm.hidden = false; codeForm.elements.code.focus();
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  };
  codeForm.onsubmit = event => {
    event.preventDefault();
    finish({ purpose: 'login', email: emailForm.elements.email.value, code: codeForm.elements.code.value }, codeForm.querySelector('button'));
  };
}
function unsubscribePage() {
  const token = new URLSearchParams(location.search).get('token') || '';
  history.replaceState({}, '', '/unsubscribe');
  shell('<section class="entry"><p class="eyebrow">PHOTOWN</p><h1>Avisos por correo</h1><p>Pulsa el botón para dejar de recibir este tipo de aviso. Puedes volver a activarlo cuando quieras desde Personalización.</p><button class="primary" id="confirm-unsubscribe">Dejar de recibirlos</button><p id="message" class="message" role="alert"></p><a class="secondary-link" href="/" data-route="/">Volver a PhoTown</a></section>');
  const button = root.querySelector('#confirm-unsubscribe');
  button.onclick = async () => {
    button.disabled = true; message('Guardando…');
    try {
      const result = await api('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      button.remove();
      message(result.unsubscribed === 'digest' ? 'Listo. Ya no recibirás resúmenes de fotos nuevas.' : 'Listo. Ya no recibirás avisos de fotos pendientes de revisar.');
    } catch (error) { message(error.message); button.disabled = false; }
  };
}
async function invitePage() {
  const token = new URLSearchParams(location.search).get('token') || sessionStorage.getItem('photown-invite') || '';
  // Keep the one-use token out of the address bar and history, but survive a reload.
  try { if (token) sessionStorage.setItem('photown-invite', token); } catch { /* private mode */ }
  history.replaceState({}, '', '/invite');
  shell('<section class="entry"><p class="eyebrow">PHOTOWN</p><h1>Invitación</h1><p id="invite-detail">Comprobando la invitación…</p><button class="primary" id="accept-invite" hidden>Unirme al grupo</button><p id="message" class="message" role="alert"></p><a class="secondary-link" href="/enter" data-route="/enter">Tengo un código de invitación</a></section>');
  const detail = root.querySelector('#invite-detail'), accept = root.querySelector('#accept-invite');
  try {
    const invitation = await api('/api/invitation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    detail.textContent = `Te han invitado al grupo «${invitation.group}». Al unirte, ${invitation.email} quedará vinculado y podrás entrar desde cualquier dispositivo con «Entrar con mi correo».`;
    accept.hidden = false;
  } catch (error) { detail.textContent = error.message; return; }
  accept.onclick = async () => {
    if (busy) return;
    busy = true; accept.disabled = true; message('Entrando…');
    try {
      await api('/api/invitation/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      try { sessionStorage.removeItem('photown-invite'); } catch { /* private mode */ }
      await refreshSession();
      busy = false;
      navigate('/wall', true);
    } catch (error) { message(error.message); accept.disabled = false; }
    finally { busy = false; }
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
function picker(title, options, choose) {
  const previous = document.activeElement, dialog = document.createElement('dialog');
  dialog.className = 'grid-picker'; dialog.setAttribute('aria-label', title);
  dialog.innerHTML = '<h2></h2><div class="grid-options"></div><form method="dialog"><button>Cerrar</button></form>';
  dialog.querySelector('h2').textContent = title;
  for (const option of options) {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-pressed', String(option.selected));
    button.innerHTML = '<span class="grid-option-name"></span><span class="note"></span>';
    button.querySelector('.grid-option-name').textContent = option.name; button.querySelector('.note').textContent = option.hint || '';
    button.onclick = () => { choose(option.id); dialog.close(); };
    dialog.querySelector('.grid-options').append(button);
  }
  dialog.addEventListener('close', () => { dialog.remove(); previous?.focus(); }, { once: true });
  root.append(dialog); dialog.showModal();
}
async function camera(version) {
  let challenges = [];
  try { challenges = (await api('/api/challenges')).challenges; } catch { /* The camera works without challenges. */ }
  if (version !== renderVersion) return;
  let challenge = challenges.find(item => item.id === new URLSearchParams(location.search).get('challenge'));
  let grid = challenge && challenge.grid !== 'none' ? challenge.grid : stored('photown-grid', 'none');
  let orientation = Number(stored('photown-spiral', '0')) || 0;
  let clipped = stored('photown-clipping', 'on') === 'on';
  shell(`<section class="camera-shell live-camera">${topbar('BLANCO Y NEGRO')}<h1 class="sr-only">Cámara</h1><div class="viewfinder" id="capture-area"><video id="camera" autoplay muted playsinline aria-label="Vista en directo de la cámara en blanco y negro"></video><div class="grid-holder" id="grid-holder"><canvas class="clipping-overlay" aria-hidden="true"></canvas><div class="grid-lines-holder"></div></div><p id="camera-message" class="camera-message" role="status">Abriendo la cámara…</p></div><div class="camera-tools">${challenges.length ? '<button id="challenge-button" aria-haspopup="dialog"></button>' : ''}<button id="grid-button" aria-haspopup="dialog"></button><button id="rotate-grid" hidden>Girar guía</button><button id="clipping-button" aria-pressed="${clipped}">Quemados</button><button id="exposure-button" aria-expanded="false" aria-controls="exposure-panel" hidden>Exposición</button><p class="clipping-legend" ${clipped ? '' : 'hidden'}><span class="swatch white"></span>Blanco 255 <span class="swatch black"></span>Negro 0</p></div><div id="exposure-panel" class="exposure-panel" hidden></div><div class="controls"><button id="shutter" class="shutter" aria-label="Fotografiar" aria-describedby="capture-help" disabled></button><button id="retry-camera" hidden>Volver a abrir la cámara</button></div><p id="capture-help" class="note">Toca la imagen o pulsa Fotografiar para hacer la foto.</p><p id="message" class="message" role="alert"></p><p id="connection" class="connection" role="status"></p></section>`);
  connection();
  const video = document.querySelector('video');
  const shutter = document.querySelector('#shutter');
  const retry = document.querySelector('#retry-camera');
  root.querySelector('#capture-area').append(root.querySelector('.controls'));
  const area = root.querySelector('#capture-area'), holder = root.querySelector('#grid-holder'), lines = holder.querySelector('.grid-lines-holder');
  const gridButton = root.querySelector('#grid-button'), rotate = root.querySelector('#rotate-grid'), challengeButton = root.querySelector('#challenge-button');
  const clippingButton = root.querySelector('#clipping-button'), legend = root.querySelector('.clipping-legend');
  const overlay = clippingOverlay(video, holder.querySelector('canvas'), () => version === renderVersion);
  overlay.enabled = clipped;
  const drawGrid = () => {
    const shown = fitOverlay(area, video, holder);
    lines.innerHTML = shown ? gridSVG(grid, shown.width, shown.height, orientation) : '';
    gridButton.textContent = `Guía: ${gridName(grid)}`;
    gridButton.setAttribute('aria-label', `Guía de composición: ${gridName(grid)}. Cambiar guía`);
    rotate.hidden = grid !== 'spiral';
    if (challengeButton) { challengeButton.textContent = challenge ? `Reto: ${challenge.title}` : 'Sin reto'; challengeButton.setAttribute('aria-label', `${challenge ? 'Reto ' + challenge.title : 'Sin reto'}. Cambiar reto`); }
  };
  const observer = new ResizeObserver(drawGrid); observer.observe(area);
  video.addEventListener('loadedmetadata', drawGrid);
  addEventListener('pagehide', () => observer.disconnect(), { once: true });
  rotate.onclick = () => { orientation = (orientation + 1) % 4; store('photown-spiral', String(orientation)); drawGrid(); };
  gridButton.onclick = () => picker('Guía de composición', GRIDS.map(option => ({ ...option, selected: option.id === grid })), id => { grid = id; if (!challenge) store('photown-grid', grid); drawGrid(); });
  clippingButton.onclick = () => {
    clipped = !clipped; overlay.enabled = clipped; store('photown-clipping', clipped ? 'on' : 'off');
    clippingButton.setAttribute('aria-pressed', String(clipped)); legend.hidden = !clipped;
  };
  if (challengeButton) challengeButton.onclick = () => picker('Reto de composición', [
    { id: '', name: 'Sin reto', hint: 'La foto va al muro sin reto.', selected: !challenge },
    ...challenges.map(item => ({ id: item.id, name: item.title, hint: `${item.prompt ? item.prompt + ' · ' : ''}Guía: ${gridName(item.grid)}`, selected: item.id === challenge?.id }))
  ], id => {
    challenge = challenges.find(item => item.id === id);
    if (challenge && challenge.grid !== 'none') grid = challenge.grid;
    history.replaceState({}, '', challenge ? `/camera?challenge=${challenge.id}` : '/camera');
    drawGrid();
  });
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
    if (event.target.closest('button, a, input, select, textarea, label, nav, header, dialog, .camera-tools, .exposure-panel')) return;
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
      captured.challenge = challenge?.id || null;
      captured.challengeTitle = challenge?.title || '';
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
    setupExposure(stream.getVideoTracks()[0], version);
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
// Chrome on Android fills in the camera's capabilities a moment after the stream starts, so ask again
// for a few seconds and once more whenever the panel is opened.
async function setupExposure(track, version) {
  const button = root.querySelector('#exposure-button'), panel = root.querySelector('#exposure-panel');
  if (!button || !panel || !track) return;
  let ready = false;
  const attempt = () => {
    if (ready || version !== renderVersion || track.readyState !== 'live') return ready;
    ready = Boolean(exposurePanel(track, panel, text => message(text)));
    if (!ready) panel.innerHTML = `<p class="note">Este navegador o este móvil no permite ajustar la velocidad ni el ISO desde una web. Funciona en Chrome para Android cuando la cámara lo permite; en iPhone no es posible. La apertura (F) es fija en los móviles.</p><p class="note">La cámara informa: ${escape(exposureReport(track))}</p>`;
    return ready;
  };
  button.hidden = false;
  button.onclick = () => { attempt(); panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); };
  for (const wait of [0, 500, 1000, 1500, 2000]) {
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (version !== renderVersion || attempt()) return;
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
  if (shot.challenge) {
    const label = document.createElement('label'); label.className = 'challenge-toggle';
    label.innerHTML = '<input type="checkbox" id="for-challenge" checked> <span></span>';
    label.querySelector('span').textContent = `Para el reto «${shot.challengeTitle}»`;
    destination.after(label);
  }
  connection();
  document.querySelector('#again').addEventListener('click', () => {
    if (busy) return;
    const again = shot?.challenge ? `/camera?challenge=${shot.challenge}` : '/camera';
    clearShot();
    navigate(again, true);
  });
  document.querySelector('#publish').addEventListener('click', async () => {
    if (busy || !shot) return;
    busy = true;
    const buttons = [...root.querySelectorAll('button')];
    buttons.forEach(button => button.disabled = true);
    message('Enviando fotografía…');
    try {
      const result = await api('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/webp', 'Idempotency-Key': shot.id, 'X-Photown-Group': shot.groupId || groupId, ...(shot.challenge && root.querySelector('#for-challenge')?.checked ? { 'X-Photown-Challenge': shot.challenge } : {}) }, body: shot.blob });
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
  else if (path === '/login') loginPage();
  else if (path === '/invite') invitePage();
  else if (path === '/unsubscribe') unsubscribePage();
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
