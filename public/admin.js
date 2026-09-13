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
  shell(`<section class="gallery-shell"><a class="brand" href="/" data-route="/">PHOTOWN</a><h1>Administración de grupos</h1><p>${escape(session.email)}</p><button id="logout">Cerrar sesión de administración</button><form id="create-group"><label for="group-name">Nombre del nuevo grupo</label><input id="group-name" maxlength="80" required><button class="primary" type="submit">Crear grupo</button></form><p id="admin-message" role="status"></p><div id="new-invitation"></div><div id="groups" class="group-grid"></div><section id="group-detail" aria-label="Contenido del grupo"></section></section>`);
  const report = text => { if (current()) root.querySelector('#admin-message').textContent = text; };
  const post = (path, data = {}) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  function invitation(target, code) {
    target.innerHTML = '<p>Copia este código de invitación. Se muestra ahora y no se podrá consultar después; puedes generar otro.</p><p class="invitation"></p><button type="button">Copiar código</button><p role="status"></p>';
    target.querySelector('.invitation').textContent = code;
    target.querySelector('button').onclick = async () => {
      try { await navigator.clipboard.writeText(code); target.querySelector('[role=status]').textContent = 'Código copiado.'; }
      catch { target.querySelector('[role=status]').textContent = 'Selecciona el código visible y cópialo manualmente.'; }
    };
  }
  async function groups() {
    const response = await api('/api/admin/groups'); if (!current()) return;
    const list = root.querySelector('#groups'); list.replaceChildren();
    if (!response.groups.length) { list.textContent = 'Todavía no hay grupos. Crea el primero.'; return; }
    for (const group of response.groups) {
      const card = document.createElement('article'); card.className = 'admin-row';
      card.innerHTML = `<h2>${escape(group.name)}</h2><p>${group.active ? 'Grupo abierto' : 'Grupo cerrado'}</p><button data-action="manage">Gestionar grupo</button><button data-action="invitation">Generar nueva invitación</button><button data-action="active">${group.active ? 'Cerrar grupo' : 'Abrir grupo'}</button><div class="invitation-result"></div><p class="group-status" role="status"></p>`;
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
    target.innerHTML = `<h2 tabindex="-1">${escape(group.name)}</h2><p class="detail-message" role="status">Cargando…</p><div class="photo-grid"></div><button class="more" hidden>Cargar más fotografías</button><h3>Participantes</h3><div class="members"></div>`;
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
        }
        cursor = response.next; more.hidden = !cursor;
        target.querySelector('.detail-message').textContent = grid.children.length ? '' : 'No hay fotografías para revisar.';
      } catch (error) { if (valid()) { target.querySelector('.detail-message').textContent = error.message; more.hidden = false; more.textContent = 'Reintentar carga'; } }
      finally { loading = false; more.disabled = false; }
    };
    target.querySelector('.more').onclick = load;
    await load();
    try {
      const response = await api(`/api/admin/groups/${group.id}/publishers`); if (!valid()) return;
      const list = target.querySelector('.members');
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
    try { const result = await post('/api/admin/groups', { name: event.target.querySelector('input').value }); invitation(root.querySelector('#new-invitation'), result.code); event.target.reset(); await groups(); report('Grupo creado.'); }
    catch (error) { report(error.message); } finally { button.disabled = false; }
  };
  root.querySelector('#logout').onclick = async () => {
    try { await post('/api/admin/logout'); if (current()) await renderAdmin({ root, api, shell, current, confirmDeletion }); }
    catch (error) { report(error.message); }
  };
  try { await groups(); } catch (error) { report(error.message); }
}
