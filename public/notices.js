// «Avisos por correo»: the same controls in Personalización and in Administración.
// Changes save as soon as they are made; `load` and `save` call the matching endpoint.
export async function noticePreferences(target, { load, save, current = () => true }) {
  target.innerHTML = '<h2>Avisos por correo</h2><p role="status">Cargando…</p>';
  let preferences;
  try { preferences = await load(); } catch (error) { if (current()) target.querySelector('[role=status]').textContent = error.message; return; }
  if (!current()) return;
  if (!preferences.email) {
    target.innerHTML = '<h2>Avisos por correo</h2><p class="note">Vincula tu correo para recibir un resumen de las fotos nuevas de tus muros.</p>';
    return;
  }
  target.innerHTML = `<h2>Avisos por correo</h2><p class="note"></p><label for="digest-frequency">Resumen de fotos nuevas</label><select id="digest-frequency"><option value="off">No enviarme resúmenes</option><option value="daily">Cada día</option><option value="weekly">Cada semana (lunes)</option></select>${preferences.moderates ? '<label class="check"><input type="checkbox" id="moderation-notice"> Avisarme si hay fotos pendientes de revisar en los grupos que modero</label>' : ''}<p role="status"></p>`;
  target.querySelector('.note').textContent = `Se envían a ${preferences.email} y solo si hay novedades.`;
  const select = target.querySelector('#digest-frequency'), box = target.querySelector('#moderation-notice'), status = target.querySelector('[role=status]');
  select.value = preferences.digest; if (box) box.checked = preferences.moderation;
  const change = async (data, control) => {
    control.disabled = true; status.textContent = 'Guardando…';
    try { preferences = await save(data); status.textContent = 'Preferencia guardada.'; }
    catch (error) { status.textContent = error.message; }
    finally { select.value = preferences.digest; if (box) box.checked = preferences.moderation; control.disabled = false; }
  };
  select.onchange = () => change({ digest: select.value }, select);
  if (box) box.onchange = () => change({ moderation: box.checked }, box);
}
