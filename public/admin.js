const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = { pending: 'Pendiente', published: 'Publicada', hidden: 'Oculta' };

export async function renderAdmin({ root, api, shell, current, confirmDeletion }) {
  shell('<section class="gallery-shell"><a class="brand" href="/" data-route="/">PHOTOWN</a><h1>Administración</h1><p role="status">Comprobando acceso…</p></section>');
  let session;
  try { session = await api('/api/admin/session'); }
  catch (error) { if (current()) root.querySelector('[role=status]').textContent = error.message; return; }
  if (!current()) return;
  if (!session.authenticated) {
    const failed = new URLSearchParams(location.search).get('login') === 'failed';
    shell(`<section class="entry"><a class="brand" href="/" data-route="/">PHOTOWN</a><h1>Administración</h1><p>Gestiona grupos, invitaciones y fotografías.</p>${session.configured ? '<a class="button" href="/api/admin/google/start">Entrar con Google</a>' : '<p role="status">El acceso con Google está pendiente de configuración por el equipo de PhoTown.</p>'}${failed ? '<p role="alert">No se pudo autorizar esta cuenta. Utiliza una cuenta administradora o vuelve a intentar.</p>' : ''}</section>`);
    return;
  }
  shell(`<section class="gallery-shell"><a class="brand" href="/" data-route="/">PHOTOWN</a><h1>Administración de grupos</h1><p>${escape(session.email)}</p><button id="logout">Cerrar sesión de administración</button><form id="create-group"><label for="group-name">Nombre del nuevo grupo</label><input id="group-name" maxlength="80" required><label for="group-admin-email">Correo OAuth del admin inicial</label><input id="group-admin-email" name="admin_email" type="email" maxlength="254" required value="${escape(session.email)}"><button class="primary" type="submit">Crear grupo</button></form><p id="admin-message" role="status"></p><div id="new-invitation"></div><div id="groups" class="group-grid"></div><section id="group-detail" aria-label="Contenido del grupo"></section></section>`);
  const waiting = document.createElement('section');
  waiting.innerHTML = '<button id="show-waitlist" aria-expanded="false" aria-controls="waitlist-admin">Lista de espera</button><div id="waitlist-admin" hidden><h2>Personas en lista de espera</h2><p>Solicitudes guardadas sin envío de correos ni acceso automático.</p><div class="waitlist-table"></div><button id="more-waitlist" hidden>Cargar más solicitudes</button><p role="status"></p></div>';
  root.querySelector('#create-group').before(waiting);
  let waitCursor, waitLoading = false, waitLoaded = false;
  const loadWaiting = async () => {
    if (waitLoading) return; waitLoading = true;
    const more = waiting.querySelector('#more-waitlist'), report = waiting.querySelector('[role=status]'); more.disabled = true;
    try {
      const page = await api('/api/admin/waitlist' + (waitCursor ? '?before=' + encodeURIComponent(waitCursor) : ''));
      if (!current()) return;
      for (const entry of page.entries) {
        const row = document.createElement('article'); row.className = 'member-row';
        row.innerHTML = '<p class="waiting-email"></p><p class="note"></p><button>Eliminar solicitud</button>';
        row.querySelector('.waiting-email').textContent = entry.email;
        row.querySelector('.note').textContent = new Date(entry.created_at).toLocaleDateString('es');
        row.querySelector('button').onclick = async event => {
          const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', 'Eliminar solicitud');
          dialog.innerHTML = '<h2>¿Eliminar esta solicitud de la lista de espera?</h2><form method="dialog" class="controls"><button value="cancel" autofocus>Cancelar</button><button value="delete">Eliminar solicitud definitivamente</button></form>';
          root.append(dialog); dialog.showModal();
          const yes = await new Promise(resolve => dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'delete'); dialog.remove(); event.target.focus(); }, { once: true }));
          if (!yes) return;
          event.target.disabled = true;
          try { await api('/api/admin/waitlist/' + entry.id, { method: 'DELETE' }); row.remove(); report.textContent = 'Solicitud eliminada.'; waiting.querySelector('#show-waitlist').focus(); }
          catch (error) { report.textContent = error.message; event.target.disabled = false; }
        };
        waiting.querySelector('.waitlist-table').append(row);
      }
      waitCursor = page.next; waitLoaded = true; more.hidden = !waitCursor; more.textContent = 'Cargar más solicitudes';
      report.textContent = waiting.querySelector('.waitlist-table').children.length ? '' : 'Todavía no hay solicitudes.';
    } catch (error) { report.textContent = error.message; more.hidden = false; more.textContent = 'Reintentar carga'; }
    finally { waitLoading = false; more.disabled = false; }
  };
  waiting.querySelector('#show-waitlist').onclick = () => { const panel = waiting.querySelector('#waitlist-admin'); panel.hidden = !panel.hidden; waiting.querySelector('#show-waitlist').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden && !waitLoaded) loadWaiting(); };
  waiting.querySelector('#more-waitlist').onclick = loadWaiting;
  const report = text => { if (current()) root.querySelector('#admin-message').textContent = text; };
  const post = (path, data = {}) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  function invitation(target, code) {
    const link = new URL('/enter', location.origin);
    link.searchParams.set('inv', code);
    target.innerHTML = '<p>Comparte el enlace para entrar con el código ya rellenado. Guarda esta invitación: se muestra ahora y puedes generar otra después.</p><p class="invitation"></p><button type="button" data-copy="code">Copiar código</button><label>Enlace de invitación<input class="invitation-link" type="url" readonly></label><button type="button" data-copy="link">Copiar enlace de invitación</button><p role="status"></p>';
    target.querySelector('.invitation').textContent = code;
    target.querySelector('.invitation-link').value = link.href;
    for (const button of target.querySelectorAll('[data-copy]')) button.onclick = async () => {
      const isLink = button.dataset.copy === 'link';
      try { await navigator.clipboard.writeText(isLink ? link.href : code); target.querySelector('[role=status]').textContent = isLink ? 'Enlace copiado.' : 'Código copiado.'; }
      catch { target.querySelector('[role=status]').textContent = 'Selecciona la invitación visible y cópiala manualmente.'; }
    };
  }
  async function groups() {
    const response = await api('/api/admin/groups'); if (!current()) return;
    const list = root.querySelector('#groups'); list.replaceChildren();
    if (!response.groups.length) { list.textContent = 'Todavía no hay grupos. Crea el primero.'; return; }
    for (const group of response.groups) {
      const card = document.createElement('article'); card.className = 'admin-row';
      card.innerHTML = `<h2>${escape(group.name)}</h2><p>${group.active ? 'Grupo abierto' : 'Grupo cerrado'}</p><a class="button" href="/admin/wall?group=${encodeURIComponent(group.id)}">Muro</a><button data-action="manage">Gestionar grupo</button><button data-action="invitation">Generar nueva invitación</button><button data-action="active">${group.active ? 'Cerrar grupo' : 'Abrir grupo'}</button><div class="invitation-result"></div><p class="group-status" role="status"></p>`;
      card.querySelector('[data-action=manage]').onclick = () => details(group);
      card.querySelector('[data-action=invitation]').onclick = async event => {
        event.target.disabled = true;
        try { const result = await post(`/api/admin/groups/${group.id}/invitation`); invitation(card.querySelector('.invitation-result'), result.code); card.querySelector('.group-status').textContent = 'El código anterior ya no permite nuevas entradas. Las sesiones abiertas conservan su acceso hasta caducar.'; }
        catch (error) { card.querySelector('.group-status').textContent = error.message; } finally { event.target.disabled = false; }
      };
      card.querySelector('[data-action=active]').onclick = async event => {
        event.target.disabled = true;
        try { await post(`/api/admin/groups/${group.id}/active`, { active: !group.active }); await groups(); }
        catch (error) { card.querySelector('.group-status').textContent = error.message; event.target.disabled = false; }
      };
      list.append(card);
    }
  }
  let detailVersion = 0;
  async function details(group) {
    const version = ++detailVersion;
    const target = root.querySelector('#group-detail');
    target.innerHTML = `<h2 tabindex="-1">${escape(group.name)}</h2><p class="detail-message" role="status">Cargando…</p><div class="photo-grid"></div><button class="more" hidden>Cargar más fotografías</button><h3>Administración del grupo</h3><form id="assign-admin"><label for="assigned-email">Correo OAuth</label><input id="assigned-email" name="email" type="email" maxlength="254" required><label for="assigned-role">Rol</label><select id="assigned-role" name="role"><option value="admin">Admin</option><option value="moderator">Moderator</option></select><button type="submit">Asignar acceso</button><p role="status"></p></form><div class="group-admins"></div><h3>Participantes</h3><div class="members"></div>`;
    target.querySelector('h2').focus();
    let cursor, loading = false;
    const valid = () => current() && version === detailVersion;
    const load = async () => {
      if (loading) return;
      loading = true;
      const more = target.querySelector('.more'); more.disabled = true;
      try {
        const response = await api(`/api/admin/groups/${group.id}/photos${cursor ? '?before=' + encodeURIComponent(cursor) : ''}`);
        if (!valid()) return;
        const grid = target.querySelector('.photo-grid');
        for (const photo of response.photos) {
          const card = document.createElement('article'); card.className = 'photo-card';
          card.innerHTML = `<img loading="lazy" src="/api/images/${photo.id}" alt="${escape(photo.description || 'Fotografía sin descripción disponible')}"><p>${escape(labels[photo.status])}</p><button data-action="approve">Aprobar</button><button data-action="hide">Ocultar</button><button data-action="trust">Aprobar y confiar</button><button data-action="delete">Borrar definitivamente</button><p role="status"></p>`;
          for (const button of card.querySelectorAll('button')) button.onclick = async () => {
            const action = button.dataset.action;
            if (action === 'delete' && !(await confirmDeletion())) return;
            card.querySelectorAll('button').forEach(b => b.disabled = true);
            try { await post(`/api/admin/photos/${photo.id}/${action}`); await details(group); }
            catch (error) { card.querySelector('[role=status]').textContent = error.message; card.querySelectorAll('button').forEach(b => b.disabled = false); }
          };
          grid.append(card);
          const owner = document.createElement('p'); owner.className = 'invitation'; owner.textContent = `Identidad: ${photo.publisher_id}`; card.append(owner);
        }
        cursor = response.next; more.hidden = !cursor;
        target.querySelector('.detail-message').textContent = grid.children.length ? '' : 'No hay fotografías para revisar.';
      } catch (error) { if (valid()) { target.querySelector('.detail-message').textContent = error.message; more.hidden = false; more.textContent = 'Reintentar carga'; } }
      finally { loading = false; more.disabled = false; }
    };
    target.querySelector('.more').onclick = load;
    await load();
    try {
      const response = await api(`/api/admin/groups/${group.id}/admins`); if (!valid()) return;
      const assigned = target.querySelector('.group-admins');
      const drawAdmins = admins => {
        assigned.replaceChildren();
        for (const item of admins) {
          const row = document.createElement('p');
          row.textContent = `${item.email} · ${item.role}${item.claimed_user_id ? ' · vinculado' : ' · pendiente de primer acceso'}`;
          assigned.append(row);
        }
        if (!admins.length) assigned.textContent = 'No hay cuentas administrativas asignadas.';
      };
      drawAdmins(response.admins);
      const form = target.querySelector('#assign-admin');
      form.onsubmit = async event => {
        event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
        try {
          await post(`/api/admin/groups/${group.id}/admins`, { email: form.elements.email.value, role: form.elements.role.value });
          const refreshed = await api(`/api/admin/groups/${group.id}/admins`); drawAdmins(refreshed.admins); form.reset(); form.querySelector('[role=status]').textContent = 'Acceso asignado.';
        } catch (error) { form.querySelector('[role=status]').textContent = error.message; }
        finally { button.disabled = false; }
      };
    } catch (error) { if (valid()) target.querySelector('.group-admins').textContent = error.message; }
    try {
      const response = await api(`/api/admin/groups/${group.id}/publishers`); if (!valid()) return;
      const list = target.querySelector('.members');
      const recovery = document.createElement('form');
      recovery.innerHTML = '<h3>Recuperar fotografías de una identidad anterior</h3><p>La persona debe entrar de nuevo y comunicar su identidad, visible en Mis fotos. Comprueba con ella cuáles eran sus fotos antes de reasignarlas.</p><label for="recovery-source">Identidad anterior</label><select id="recovery-source" name="source" required><option value="">Selecciona la identidad anterior</option></select><label>Nueva identidad<input name="target" required placeholder="Identidad completa de Mis fotos" autocomplete="off"></label><label><input type="checkbox" required> He comprobado que ambas identidades pertenecen a la misma persona. La anterior quedará bloqueada en este grupo.</label><button type="submit">Reasignar fotografías</button><p role="status"></p>';
      for (const member of response.publishers) {
        const option = document.createElement('option'); option.value = member.publisher_id;
        option.textContent = `${member.publisher_id} · último acceso ${new Date(member.last_seen).toLocaleString('es')}`;
        recovery.querySelector('select').append(option);
      }
      recovery.onsubmit = async event => {
        event.preventDefault(); const button = recovery.querySelector('button'); button.disabled = true;
        try {
          const result = await post(`/api/admin/groups/${group.id}/recover-identity`, { source: recovery.elements.source.value, target: recovery.elements.target.value.trim() });
          await details(group); report(`${result.transferred} fotografías reasignadas. La identidad anterior queda bloqueada en este grupo.`);
        } catch (error) { recovery.querySelector('[role=status]').textContent = error.message; }
        finally { button.disabled = false; }
      };
      list.before(recovery);
      if (!response.publishers.length) list.textContent = 'Todavía no hay participantes.';
      for (const member of response.publishers) {
        const row = document.createElement('div'); row.className = 'member-row';
        row.innerHTML = `<label for="member-${member.publisher_id}">Participante ${escape(member.publisher_id.slice(0, 8))}</label><select id="member-${member.publisher_id}"><option value="NEW">Nuevo</option><option value="MODERATED">Con moderación</option><option value="TRUSTED">De confianza</option><option value="BLOCKED">Bloqueado</option></select><button>Guardar estado</button><p role="status"></p>`;
        row.querySelector('select').value = member.status;
        row.querySelector('option[value=NEW]').disabled = true;
        row.querySelector('button').onclick = async event => {
          event.target.disabled = true;
          try { await post(`/api/admin/groups/${group.id}/publishers/${member.publisher_id}`, { status: row.querySelector('select').value }); row.querySelector('[role=status]').textContent = 'Estado guardado.'; }
          catch (error) { row.querySelector('[role=status]').textContent = error.message; }
          finally { event.target.disabled = false; }
        };
        list.append(row);
      }
    } catch (error) { if (valid()) target.querySelector('.members').textContent = error.message; }
  }
  root.querySelector('#create-group').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { const result = await post('/api/admin/groups', { name: event.target.querySelector('#group-name').value, admin_email: event.target.elements.admin_email.value }); invitation(root.querySelector('#new-invitation'), result.code); event.target.reset(); event.target.elements.admin_email.value = session.email; await groups(); report('Grupo creado.'); }
    catch (error) { report(error.message); } finally { button.disabled = false; }
  };
  root.querySelector('#logout').onclick = async () => {
    try { await post('/api/admin/logout'); if (current()) await renderAdmin({ root, api, shell, current, confirmDeletion }); }
    catch (error) { report(error.message); }
  };
  try { await groups(); } catch (error) { report(error.message); }
}
