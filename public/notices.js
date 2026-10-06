// «Avisos»: the same controls in Personalización and in Administración. The preferences
// apply to email and to every device that accepted notifications; changes save at once.
const keyBytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
const installedApp = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;

export async function noticePreferences(target, { load, save, subscribe, unsubscribe, current = () => true }) {
  target.innerHTML = '<h2>Avisos</h2><p role="status">Cargando…</p>';
  let preferences;
  try { preferences = await load(); } catch (error) { if (current()) target.querySelector('[role=status]').textContent = error.message; return; }
  if (!current()) return;
  target.innerHTML = `<h2>Avisos</h2><p class="note notice-email"></p><div class="notice-device"></div><label for="digest-frequency">Resumen de fotos nuevas</label><select id="digest-frequency"><option value="off">No enviarme resúmenes</option><option value="daily">Cada día</option><option value="weekly">Cada semana (lunes)</option></select>${preferences.moderates ? '<label class="check"><input type="checkbox" id="moderation-notice"> Avisarme si hay fotos pendientes de revisar en los grupos que modero</label>' : ''}<p role="status" class="notice-status"></p>`;
  target.querySelector('.notice-email').textContent = preferences.email
    ? `Por correo a ${preferences.email} y en los dispositivos que actives. Solo llegan si hay novedades.`
    : 'Llegan a los dispositivos que actives y solo si hay novedades. Vincula tu correo para recibirlos también por correo.';
  const select = target.querySelector('#digest-frequency'), box = target.querySelector('#moderation-notice'), status = target.querySelector('.notice-status');
  select.value = preferences.digest; if (box) box.checked = preferences.moderation;
  const change = async (data, control) => {
    control.disabled = true; status.textContent = 'Guardando…';
    try { preferences = { ...preferences, ...await save(data) }; status.textContent = 'Preferencia guardada.'; }
    catch (error) { status.textContent = error.message; }
    finally { select.value = preferences.digest; if (box) box.checked = preferences.moderation; control.disabled = false; }
  };
  select.onchange = () => change({ digest: select.value }, select);
  if (box) box.onchange = () => change({ moderation: box.checked }, box);
  deviceToggle(target.querySelector('.notice-device'), preferences.push_key, { subscribe, unsubscribe, status });
}

async function deviceToggle(target, key, { subscribe, unsubscribe, status }) {
  if (!key) return;
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) {
    target.innerHTML = '<p class="note"></p>';
    target.querySelector('p').textContent = /iPhone|iPad|iPod/.test(navigator.userAgent) && !installedApp()
      ? 'Para recibir avisos en el iPhone o iPad, instala PhoTown en la pantalla de inicio y ábrelo desde su icono.'
      : 'Este navegador no permite avisos en el dispositivo.';
    return;
  }
  let registration;
  try { registration = await navigator.serviceWorker.ready; } catch { return; }
  let subscription = await registration.pushManager.getSubscription().catch(() => null);
  target.innerHTML = '<label class="check"><input type="checkbox" id="device-notice"> Recibir avisos en este dispositivo</label>';
  const input = target.querySelector('input');
  input.checked = Boolean(subscription) && Notification.permission === 'granted';
  input.onchange = async () => {
    input.disabled = true; status.textContent = 'Guardando…';
    try {
      if (input.checked) {
        if (await Notification.requestPermission() !== 'granted') throw new Error('El navegador tiene bloqueados los avisos de PhoTown. Permítelos en los ajustes del sitio y vuelve a intentarlo.');
        subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
        await subscribe(subscription.toJSON());
        status.textContent = 'Avisos activados en este dispositivo.';
      } else {
        if (subscription) { await unsubscribe({ endpoint: subscription.endpoint }); await subscription.unsubscribe(); subscription = null; }
        status.textContent = 'Avisos desactivados en este dispositivo.';
      }
    } catch (error) { input.checked = !input.checked; status.textContent = error.message || 'No se pudieron cambiar los avisos.'; }
    finally { input.disabled = false; }
  };
}
