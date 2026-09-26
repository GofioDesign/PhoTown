import { GRIDS, gridIcon, gridName } from './grids.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = { pending: 'Pendiente', published: 'Publicada', hidden: 'Oculta' };
const day = value => new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });

export async function renderAdmin({ root, api, shell, current, confirmDeletion }) {
  shell('<section class="admin-shell"><a class="brand" href="/" data-route="/">PHOTOWN</a><h1>Administración</h1><p role="status">Comprobando acceso…</p></section>');
  let session;
  try { session = await api('/api/admin/session'); }
  catch (error) { if (current()) root.querySelector('[role=status]').textContent = error.message; return; }
  if (!current()) return;
  if (!session.authenticated) {
    const failed = new URLSearchParams(location.search).get('login') === 'failed';
    shell(`<section class="entry"><a class="brand" href="/" data-route="/">PHOTOWN</a><h1>Administración</h1><p>Gestiona grupos, invitaciones, retos y fotografías.</p>${session.configured ? '<a class="button primary" href="/api/admin/google/start">Entrar con Google</a>' : '<p role="status">El acceso con Google está pendiente de configuración por el equipo de PhoTown.</p>'}${failed ? '<p role="alert">No se pudo autorizar esta cuenta. Utiliza una cuenta administradora o vuelve a intentar.</p>' : ''}</section>`);
    return;
  }
  shell(`<section class="admin-shell"><header class="admin-header"><a class="brand" href="/" data-route="/">PHOTOWN</a><span class="note">${escape(session.email)}</span><button id="logout">Cerrar sesión</button></header>
    <h1>Administración</h1>
    ${session.mail ? '' : '<p class="warning" role="note">El envío de correo no está configurado en este entorno. Las invitaciones se guardan, pero no se enviarán hasta activar Cloudflare Email.</p>'}
    <form id="create-group" class="inline-form"><label for="group-name">Nuevo grupo</label><div><input id="group-name" maxlength="80" required placeholder="Nombre del grupo o de la clase"><button class="primary" type="submit">Crear grupo</button></div></form>
    <p id="admin-message" role="status"></p><div id="groups" class="group-grid"></div><section id="group-detail" aria-label="Contenido del grupo"></section><section id="waiting"></section></section>`);
  const report = text => { if (current()) root.querySelector('#admin-message').textContent = text; };
  const post = (path, data = {}) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const waiting = root.querySelector('#waiting');
  waiting.innerHTML = '<button id="show-waitlist" aria-expanded="false" aria-controls="waitlist-admin">Lista de espera</button><div id="waitlist-admin" hidden><h2>Personas en lista de espera</h2><p class="note">Correos que pidieron acceso sin invitación. Puedes invitarlas desde un grupo.</p><div class="waitlist-table"></div><button id="more-waitlist" hidden>Cargar más solicitudes</button><p role="status"></p></div>';
  let waitCursor, waitLoading = false, waitLoaded = false;
  const loadWaiting = async () => {
    if (waitLoading) return; waitLoading = true;
    const more = waiting.querySelector('#more-waitlist'), status = waiting.querySelector('[role=status]'); more.disabled = true;
    try {
      const page = await api('/api/admin/waitlist' + (waitCursor ? '?before=' + encodeURIComponent(waitCursor) : ''));
      if (!current()) return;
      for (const entry of page.entries) {
        const row = document.createElement('article'); row.className = 'member-row';
        row.innerHTML = '<p class="waiting-email"></p><p class="note"></p><button>Eliminar solicitud</button>';
        row.querySelector('.waiting-email').textContent = entry.email;
        row.querySelector('.note').textContent = day(entry.created_at);
        row.querySelector('button').onclick = async event => {
          const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', 'Eliminar solicitud');
          dialog.innerHTML = '<h2>¿Eliminar esta solicitud de la lista de espera?</h2><form method="dialog" class="controls"><button value="cancel" autofocus>Cancelar</button><button value="delete">Eliminar solicitud definitivamente</button></form>';
          root.append(dialog); dialog.showModal();
          const yes = await new Promise(resolve => dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'delete'); dialog.remove(); event.target.focus(); }, { once: true }));
          if (!yes) return;
          event.target.disabled = true;
          try { await api('/api/admin/waitlist/' + entry.id, { method: 'DELETE' }); row.remove(); status.textContent = 'Solicitud eliminada.'; waiting.querySelector('#show-waitlist').focus(); }
          catch (error) { status.textContent = error.message; event.target.disabled = false; }
        };
        waiting.querySelector('.waitlist-table').append(row);
      }
      waitCursor = page.next; waitLoaded = true; more.hidden = !waitCursor; more.textContent = 'Cargar más solicitudes';
      status.textContent = waiting.querySelector('.waitlist-table').children.length ? '' : 'Todavía no hay solicitudes.';
    } catch (error) { status.textContent = error.message; more.hidden = false; more.textContent = 'Reintentar carga'; }
    finally { waitLoading = false; more.disabled = false; }
  };
  waiting.querySelector('#show-waitlist').onclick = () => { const panel = waiting.querySelector('#waitlist-admin'); panel.hidden = !panel.hidden; waiting.querySelector('#show-waitlist').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden && !waitLoaded) loadWaiting(); };
  waiting.querySelector('#more-waitlist').onclick = loadWaiting;

  async function groups(select) {
    const response = await api('/api/admin/groups'); if (!current()) return;
    const list = root.querySelector('#groups'); list.replaceChildren();
    if (!response.groups.length) { list.textContent = 'Todavía no hay grupos. Crea el primero.'; return; }
    for (const group of response.groups) {
      const card = document.createElement('article'); card.className = 'admin-row' + (group.active ? '' : ' closed');
      card.innerHTML = `<h2></h2><p class="stats"><span>${group.members} ${group.members === 1 ? 'participante' : 'participantes'}</span><span>${group.challenges} ${group.challenges === 1 ? 'reto abierto' : 'retos abiertos'}</span>${group.pending ? `<span class="pending-badge">${group.pending} por revisar</span>` : ''}${group.active ? '' : '<span>Cerrado</span>'}</p><div class="row-actions"><button data-action="manage" class="primary">Gestionar</button><a class="button" href="/admin/wall?group=${encodeURIComponent(group.id)}">Muro de clase</a><button data-action="active">${group.active ? 'Cerrar grupo' : 'Abrir grupo'}</button></div><p class="group-status" role="status"></p>`;
      card.querySelector('h2').textContent = group.name;
      card.querySelector('[data-action=manage]').onclick = () => details(group);
      card.querySelector('[data-action=active]').onclick = async event => {
        event.target.disabled = true;
        try { await post(`/api/admin/groups/${group.id}/active`, { active: !group.active }); await groups(); }
        catch (error) { card.querySelector('.group-status').textContent = error.message; event.target.disabled = false; }
      };
      list.append(card);
      if (select === group.id) details(group);
    }
  }

  let detailVersion = 0;
  async function details(group, tab = group.pending ? 'photos' : 'invite') {
    const version = ++detailVersion;
    const target = root.querySelector('#group-detail');
    const tabs = [['photos', `Fotos${group.pending ? ` (${group.pending})` : ''}`], ['invite', 'Invitar'], ['challenges', 'Retos'], ['members', 'Participantes']];
    target.innerHTML = `<h2 tabindex="-1"></h2><div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" id="tab-${id}" aria-controls="panel" aria-selected="${id === tab}">${label}</button>`).join('')}</div><div id="panel" role="tabpanel" aria-labelledby="tab-${tab}"></div>`;
    target.querySelector('h2').textContent = group.name;
    target.querySelector('h2').focus();
    target.querySelectorAll('[role=tab]').forEach(button => button.onclick = () => details(group, button.id.slice(4)));
    const panel = target.querySelector('#panel');
    const valid = () => current() && version === detailVersion;
    if (tab === 'photos') await photosPanel(group, panel, valid);
    else if (tab === 'invite') await invitePanel(group, panel, valid);
    else if (tab === 'challenges') await challengesPanel(group, panel, valid);
    else await membersPanel(group, panel, valid);
  }

  async function photosPanel(group, panel, valid) {
    let onlyPending = true;
    panel.innerHTML = '<label class="switch"><input type="checkbox" checked id="only-pending"> Solo pendientes de revisión</label><p class="detail-message" role="status">Cargando…</p><div class="photo-grid"></div><button class="more" hidden>Cargar más fotografías</button>';
    let cursor, loading = false;
    const grid = panel.querySelector('.photo-grid');
    const load = async () => {
      if (loading) return; loading = true;
      const more = panel.querySelector('.more'); more.disabled = true;
      try {
        const query = new URLSearchParams(); if (cursor) query.set('before', cursor); if (onlyPending) query.set('status', 'pending');
        const response = await api(`/api/admin/groups/${group.id}/photos?${query}`);
        if (!valid()) return;
        for (const photo of response.photos) {
          const card = document.createElement('article'); card.className = 'photo-card';
          card.innerHTML = `<img loading="lazy" src="/api/images/${photo.id}${photo.has_thumb ? '?size=thumb' : ''}" alt="${escape(photo.description || 'Fotografía sin descripción disponible')}"><p><strong>${escape(labels[photo.status])}</strong>${photo.alias ? ' · ' + escape(photo.alias) : ''}${photo.challenge_title ? ' · Reto «' + escape(photo.challenge_title) + '»' : ''}</p><div class="row-actions">${photo.status !== 'published' ? '<button data-action="approve" class="primary">Aprobar</button><button data-action="trust">Aprobar y confiar</button>' : ''}${photo.status !== 'hidden' ? '<button data-action="hide">Ocultar</button>' : ''}<button data-action="delete">Borrar</button></div><p role="status"></p>`;
          for (const button of card.querySelectorAll('button')) button.onclick = async () => {
            const action = button.dataset.action;
            if (action === 'delete' && !(await confirmDeletion())) return;
            card.querySelectorAll('button').forEach(b => b.disabled = true);
            try {
              await post(`/api/admin/photos/${photo.id}/${action}`);
              if (onlyPending || action === 'delete') card.remove(); else { card.querySelector('[role=status]').textContent = 'Hecho.'; }
              if (action !== 'hide' && photo.status === 'pending') group.pending = Math.max(0, group.pending - 1);
              panel.querySelector('.detail-message').textContent = grid.children.length ? '' : 'No hay fotografías pendientes.';
            } catch (error) { card.querySelector('[role=status]').textContent = error.message; card.querySelectorAll('button').forEach(b => b.disabled = false); }
          };
          const owner = document.createElement('p'); owner.className = 'invitation note'; owner.textContent = `Identidad: ${photo.publisher_id}`; card.append(owner);
          grid.append(card);
        }
        cursor = response.next; more.hidden = !cursor;
        panel.querySelector('.detail-message').textContent = grid.children.length ? '' : onlyPending ? 'No hay fotografías pendientes.' : 'No hay fotografías.';
      } catch (error) { if (valid()) { panel.querySelector('.detail-message').textContent = error.message; more.hidden = false; more.textContent = 'Reintentar carga'; } }
      finally { loading = false; more.disabled = false; }
    };
    panel.querySelector('#only-pending').onchange = event => { onlyPending = event.target.checked; cursor = undefined; grid.replaceChildren(); load(); };
    panel.querySelector('.more').onclick = load;
    await load();
  }

  async function invitePanel(group, panel, valid) {
    panel.innerHTML = `<form id="invite-form"><label for="invite-emails">Correos de las personas invitadas</label><textarea id="invite-emails" rows="4" required placeholder="ana@ejemplo.com, luis@ejemplo.com"></textarea><p class="note">Separa los correos con comas, espacios o saltos de línea (hasta 50). Cada persona recibe un enlace para entrar sin contraseña; si ya tiene cuenta, se añade al grupo al momento.</p><button class="primary">Enviar invitaciones</button><p role="status"></p></form><h3>Invitaciones</h3><div class="invitation-list" role="status">Cargando…</div>`;
    const form = panel.querySelector('#invite-form'), list = panel.querySelector('.invitation-list');
    const load = async () => {
      const { invitations } = await api(`/api/admin/groups/${group.id}/invitations`); if (!valid()) return;
      list.replaceChildren();
      if (!invitations.length) { list.textContent = 'Todavía no has invitado a nadie en este grupo.'; return; }
      for (const invitation of invitations) {
        const row = document.createElement('div'); row.className = 'member-row';
        row.innerHTML = `<p class="waiting-email"></p><p class="note">${invitation.accepted_at ? 'Aceptada el ' + day(invitation.accepted_at) : invitation.sent_at ? 'Enviada el ' + day(invitation.sent_at) : 'Guardada sin enviar'}</p>${invitation.accepted_at ? '' : '<button data-action="resend">Reenviar</button><button data-action="revoke">Retirar</button>'}<p role="status"></p>`;
        row.querySelector('.waiting-email').textContent = invitation.email;
        const status = row.querySelector('[role=status]');
        row.querySelector('[data-action=resend]')?.addEventListener('click', async event => {
          event.target.disabled = true;
          try { const result = await post(`/api/admin/groups/${group.id}/invitations`, { emails: [invitation.email] }); status.textContent = result.results[0].sent ? 'Invitación reenviada.' : 'Guardada; el correo no está configurado.'; }
          catch (error) { status.textContent = error.message; } finally { event.target.disabled = false; }
        });
        row.querySelector('[data-action=revoke]')?.addEventListener('click', async event => {
          event.target.disabled = true;
          try { await api(`/api/admin/groups/${group.id}/invitations?email=${encodeURIComponent(invitation.email)}`, { method: 'DELETE' }); row.remove(); }
          catch (error) { status.textContent = error.message; event.target.disabled = false; }
        });
        list.append(row);
      }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const emails = [...new Set(form.querySelector('textarea').value.split(/[\s,;]+/).map(v => v.trim()).filter(Boolean))];
      const status = form.querySelector('[role=status]'), button = form.querySelector('button');
      if (!emails.length) { status.textContent = 'Escribe al menos un correo.'; return; }
      button.disabled = true; status.textContent = `Enviando ${emails.length} ${emails.length === 1 ? 'invitación' : 'invitaciones'}…`;
      try {
        const result = await post(`/api/admin/groups/${group.id}/invitations`, { emails });
        const sent = result.results.filter(item => item.sent).length, members = result.results.filter(item => item.member).length;
        status.textContent = result.mail ? `${sent} ${sent === 1 ? 'invitación enviada' : 'invitaciones enviadas'}${members ? `; ${members} ya tenían cuenta y están en el grupo` : ''}.` : 'Invitaciones guardadas. El envío de correo no está configurado todavía.';
        form.reset(); await load();
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
    try { await load(); } catch (error) { if (valid()) list.textContent = error.message; }
  }

  async function challengesPanel(group, panel, valid) {
    panel.innerHTML = `<form id="challenge-form" class="challenge-form"><label for="challenge-title">Título del reto</label><input id="challenge-title" maxlength="80" required placeholder="Por ejemplo: Una esquina en tercios"><label for="challenge-prompt">Propuesta</label><textarea id="challenge-prompt" maxlength="1000" rows="3" placeholder="Qué buscamos, en qué fijarse, una pista…"></textarea><fieldset class="grid-choice"><legend>Guía de composición en la cámara</legend></fieldset><label for="challenge-end">Cierre (opcional)</label><input id="challenge-end" type="date"><button class="primary">Crear reto y avisar al grupo</button><p role="status"></p></form><h3>Retos del grupo</h3><div class="challenge-admin-list" role="status">Cargando…</div>`;
    const choices = panel.querySelector('.grid-choice');
    for (const grid of GRIDS) choices.insertAdjacentHTML('beforeend', `<label class="grid-radio"><input type="radio" name="grid" value="${grid.id}" ${grid.id === 'thirds' ? 'checked' : ''}>${gridIcon(grid.id)}<span>${escape(grid.name)}</span></label>`);
    const list = panel.querySelector('.challenge-admin-list'), form = panel.querySelector('#challenge-form');
    const load = async () => {
      const { challenges } = await api(`/api/admin/groups/${group.id}/challenges`); if (!valid()) return;
      list.replaceChildren();
      if (!challenges.length) { list.textContent = 'Todavía no hay retos. Crea el primero arriba.'; return; }
      for (const challenge of challenges) {
        const row = document.createElement('article'); row.className = 'member-row challenge-admin' + (challenge.active ? '' : ' closed');
        row.innerHTML = `${gridIcon(challenge.grid)}<div><h4></h4><p class="note">${escape(gridName(challenge.grid))} · ${challenge.photos} ${challenge.photos === 1 ? 'foto' : 'fotos'}${challenge.ends_at ? ' · cierre ' + escape(challenge.ends_at) : ''} · ${challenge.active ? 'abierto' : 'cerrado'}</p><div class="row-actions"><a class="button" href="/admin/wall?group=${encodeURIComponent(group.id)}&challenge=${challenge.id}">Ver en muro de clase</a><button>${challenge.active ? 'Cerrar reto' : 'Reabrir'}</button></div><p role="status"></p></div>`;
        row.querySelector('h4').textContent = challenge.title;
        row.querySelector('button').onclick = async event => {
          event.target.disabled = true;
          try { await post(`/api/admin/challenges/${challenge.id}`, { active: !challenge.active }); await load(); }
          catch (error) { row.querySelector('[role=status]').textContent = error.message; event.target.disabled = false; }
        };
        list.append(row);
      }
    };
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button.primary'), status = form.querySelector('[role=status]'); button.disabled = true;
      try {
        await post(`/api/admin/groups/${group.id}/challenges`, { title: form.querySelector('#challenge-title').value, prompt: form.querySelector('#challenge-prompt').value, grid: form.querySelector('[name=grid]:checked').value, ends_at: form.querySelector('#challenge-end').value || null });
        form.reset(); form.querySelector('[value=thirds]').checked = true; status.textContent = 'Reto creado. El grupo recibirá un aviso.'; await load();
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
    try { await load(); } catch (error) { if (valid()) list.textContent = error.message; }
  }

  async function membersPanel(group, panel, valid) {
    panel.innerHTML = '<div class="members" role="status">Cargando…</div><details class="recovery"><summary>Recuperar fotos de una identidad anterior</summary></details>';
    try {
      const response = await api(`/api/admin/groups/${group.id}/publishers`); if (!valid()) return;
      const list = panel.querySelector('.members'); list.replaceChildren();
      if (!response.publishers.length) list.textContent = 'Todavía no hay participantes. Invítalos por correo.';
      for (const member of response.publishers) {
        const row = document.createElement('div'); row.className = 'member-row';
        row.innerHTML = `<label for="member-${member.publisher_id}"></label><p class="note">${member.alias ? 'Alias: ' + escape(member.alias) + ' · ' : ''}último acceso ${day(member.last_seen)}</p><select id="member-${member.publisher_id}"><option value="NEW">Nuevo (con revisión)</option><option value="MODERATED">Con revisión</option><option value="TRUSTED">De confianza (publica directamente)</option><option value="BLOCKED">Bloqueado</option></select><button>Guardar estado</button><p role="status"></p>`;
        row.querySelector('label').textContent = member.email || `Identidad sin correo ${member.publisher_id.slice(0, 8)}`;
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
      const recovery = document.createElement('form');
      recovery.innerHTML = '<p class="note">Solo para identidades antiguas sin correo. La persona entra con su correo y te comunica su identidad; comprueba con ella cuáles eran sus fotos antes de reasignarlas.</p><label for="recovery-source">Identidad anterior</label><select id="recovery-source" name="source" required><option value="">Selecciona la identidad anterior</option></select><label>Nueva identidad<input name="target" required placeholder="Identidad completa" autocomplete="off"></label><label><input type="checkbox" required> He comprobado que ambas identidades pertenecen a la misma persona. La anterior quedará bloqueada en este grupo.</label><button type="submit">Reasignar fotografías</button><p role="status"></p>';
      for (const member of response.publishers) {
        const option = document.createElement('option'); option.value = member.publisher_id;
        option.textContent = `${member.email || member.publisher_id} · último acceso ${new Date(member.last_seen).toLocaleString('es')}`;
        recovery.querySelector('select').append(option);
      }
      recovery.onsubmit = async event => {
        event.preventDefault(); const button = recovery.querySelector('button'); button.disabled = true;
        try {
          const result = await post(`/api/admin/groups/${group.id}/recover-identity`, { source: recovery.elements.source.value, target: recovery.elements.target.value.trim() });
          recovery.querySelector('[role=status]').textContent = `${result.transferred} fotografías reasignadas. La identidad anterior queda bloqueada en este grupo.`;
        } catch (error) { recovery.querySelector('[role=status]').textContent = error.message; }
        finally { button.disabled = false; }
      };
      panel.querySelector('.recovery').append(recovery);
    } catch (error) { if (valid()) panel.querySelector('.members').textContent = error.message; }
  }

  root.querySelector('#create-group').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { const result = await post('/api/admin/groups', { name: event.target.querySelector('input').value }); event.target.reset(); report('Grupo creado. Invita a sus participantes por correo.'); await groups(result.id); }
    catch (error) { report(error.message); } finally { button.disabled = false; }
  };
  root.querySelector('#logout').onclick = async () => {
    try { await post('/api/admin/logout'); if (current()) await renderAdmin({ root, api, shell, current, confirmDeletion }); }
    catch (error) { report(error.message); }
  };
  try { await groups(); } catch (error) { report(error.message); }
}
