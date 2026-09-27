const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = { uploading: 'Envío incompleto', pending: 'Pendiente de revisión', published: 'En el muro', hidden: 'Fuera del muro', deleting: 'Borrado pendiente' };

const paths = {
  yo: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2Z"/>',
  group: '<circle cx="12" cy="7" r="3"/><circle cx="4" cy="10" r="2"/><circle cx="20" cy="10" r="2"/><path d="M6 22v-3a6 6 0 0 1 12 0v3ZM1 21v-3a4 4 0 0 1 4-4m18 7v-3a4 4 0 0 0-4-4"/>',
  download: '<path d="M12 2v13m-5-5 5 5 5-5M3 16v6h18v-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 16h12l1-16M10 10v8m4-8v8"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>'
};
const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;

export function photoUI({ root, api, shell, navigate, state, current, confirmDeletion }) {
  let selectionRequested = false;
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function handedness() { try { return localStorage.getItem('photown-handedness') === 'left' ? 'left' : 'right'; } catch { return 'right'; } }
  function header() { return '<header class="wall-header"><a class="brand" href="/wall" data-route="/wall">PHOTOWN</a><button data-route="/settings" aria-label="Personalización">…</button></header>'; }
  function navigation(mine) {
    const yo = `<a href="/my-photos" data-route="/my-photos" ${mine ? 'aria-current="page"' : ''}>${icon('yo')}<span>YO</span></a>`;
    const group = `<button id="group-menu" ${!mine ? 'aria-current="page"' : ''} aria-label="${escape(state().name)}${state().groups.length > 1 ? ', cambiar de grupo' : ', ver muro'}">${icon('group')}<span>${escape(state().name)}</span></button>`;
    const sideGroup = !mine && state().groups.length <= 1 ? '<span aria-hidden="true"></span>' : group;
    return `<nav class="bottom-nav" aria-label="Navegación principal">${handedness() === 'left' ? sideGroup : yo}<button class="nav-shutter" data-route="/camera" aria-label="Abrir cámara"><span aria-hidden="true"></span></button>${handedness() === 'left' ? yo : sideGroup}</nav>`;
  }
  function modal(html, label, className = '') {
    const previous = document.activeElement, dialog = document.createElement('dialog');
    dialog.className = className; dialog.setAttribute('aria-label', label); dialog.innerHTML = html;
    dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }, { once: true });
    root.append(dialog); dialog.showModal(); return dialog;
  }
  function bindGroup() {
    const button = root.querySelector('#group-menu');
    if (!button) return;
    button.onclick = () => {
      if (state().groups.length < 2) { navigate('/wall'); return; }
      const dialog = modal('<h2>Cambiar de grupo</h2><div class="group-choices"></div><p role="status"></p><form method="dialog"><button>Cancelar</button></form>', 'Cambiar de grupo');
      for (const group of state().groups) {
        const option = document.createElement('button'); option.textContent = group.name;
        option.setAttribute('aria-pressed', String(group.id === state().id));
        option.onclick = async () => {
          dialog.querySelectorAll('button').forEach(b => b.disabled = true);
          const preventClose = event => event.preventDefault(); dialog.addEventListener('cancel', preventClose);
          try { await post('/api/groups/select', { group: group.id }); await state().refresh(); dialog.close(); navigate('/wall'); }
          catch (error) { dialog.querySelector('[role=status]').textContent = error.message; }
          finally { dialog.removeEventListener('cancel', preventClose); dialog.querySelectorAll('button').forEach(b => b.disabled = false); }
        };
        dialog.querySelector('.group-choices').append(option);
      }
    };
  }
  async function settings(version) {
    shell(`<section class="settings-shell">${header()}<h1>Personalización</h1><a class="button" href="/enter" data-route="/enter">Añadir otro grupo</a><form id="alias-form"><label for="my-alias">Mi alias (opcional)</label><input id="my-alias" maxlength="40" autocomplete="nickname"><p class="note">Firma de tus fotos en ${escape(state().name)}. Déjalo vacío para retirar la atribución.</p><button disabled>Guardar alias</button><p role="status"></p></form><fieldset class="handedness"><legend>Mano preferida</legend><label><input type="radio" name="hand" value="right">Diestro</label><label><input type="radio" name="hand" value="left">Zurdo</label></fieldset><p id="preference-message" role="status"></p><button id="select-photos">Seleccionar varias fotos</button><button data-install>Instalar app</button><details><summary>Recuperar mi acceso</summary><p class="note">Guarda tu identidad. Si pierdes las cookies, el administrador puede ayudarte a recuperar tus fotos.</p><label for="identity">Mi identidad</label><input id="identity" readonly><button id="copy-identity">Copiar mi identidad</button><p id="identity-message" role="status"></p></details><a class="button" href="/wall" data-route="/wall">Volver al muro</a><p id="message" role="alert"></p></section>`);
    root.querySelector(`[name=hand][value=${handedness()}]`).checked = true;
    root.querySelectorAll('[name=hand]').forEach(input => input.onchange = () => {
      try { localStorage.setItem('photown-handedness', input.value); root.querySelector('#preference-message').textContent = 'Preferencia guardada en este dispositivo.'; }
      catch { root.querySelector('#preference-message').textContent = 'El navegador no permite guardar la preferencia.'; }
    });
    root.querySelector('#select-photos').onclick = () => { selectionRequested = true; navigate('/my-photos'); };
    try {
      const session = await api('/api/session'); if (!current(version)) return;
      root.querySelector('#identity').value = session.identity || '';
      const form = root.querySelector('#alias-form'); form.querySelector('input').value = session.alias || ''; form.querySelector('button').disabled = false;
      form.onsubmit = async event => {
        event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
        try { const result = await post('/api/profile', { alias: form.querySelector('input').value }); form.querySelector('input').value = result.alias; form.querySelector('[role=status]').textContent = 'Alias guardado.'; }
        catch (error) { form.querySelector('[role=status]').textContent = error.message; }
        finally { button.disabled = false; }
      };
      root.querySelector('#copy-identity').onclick = async () => {
        try { await navigator.clipboard.writeText(session.identity); root.querySelector('#identity-message').textContent = 'Identidad copiada.'; }
        catch { root.querySelector('#identity').select(); root.querySelector('#identity-message').textContent = 'Copia la identidad seleccionada.'; }
      };
    } catch (error) { if (current(version)) root.querySelector('#message').textContent = error.message; }
  }
  async function renderProfile(version) {
    const target = root.querySelector('#my-profile');
    try {
      const session = await api('/api/session'); if (!current(version)) return;
      target.innerHTML = `<button id="edit-profile" aria-label="Editar mi perfil"><span class="profile-avatar">${session.has_avatar ? '<img src="/api/profile/avatar?v=' + Date.now() + '" alt="">' : icon('yo')}</span><span>${escape(session.alias || 'Mi perfil')}</span></button>`;
      target.querySelector('button').onclick = () => {
        const dialog = modal(`<h2>Mi perfil</h2><p class="note">Alias y foto de perfil en ${escape(state().name)}.</p><form id="profile-form"><label for="profile-alias">Mi alias (opcional)</label><input id="profile-alias" maxlength="40" autocomplete="nickname" value="${escape(session.alias)}"><label for="profile-photo">Foto identificativa (opcional)</label><input id="profile-photo" type="file" accept="image/jpeg,image/png,image/webp"><p class="note">La foto se recorta al centro y se guarda en blanco y negro.</p><button>Guardar perfil</button></form>${session.has_avatar ? '<button id="remove-avatar">Eliminar foto de perfil</button>' : ''}<p role="status"></p><form method="dialog"><button>Cancelar</button></form>`, 'Editar mi perfil');
        let saving = false;
        dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
        async function save(action) {
          if (saving) return; saving = true; dialog.querySelectorAll('button').forEach(button => button.disabled = true);
          try { await action(); dialog.close(); if (current(version)) renderProfile(version); }
          catch (error) { dialog.querySelector('[role=status]').textContent = error.message; }
          finally { saving = false; dialog.querySelectorAll('button').forEach(button => button.disabled = false); }
        }
        dialog.querySelector('#profile-form').onsubmit = event => {
          event.preventDefault(); save(async () => {
            const file = dialog.querySelector('[type=file]').files[0];
            if (file) {
              if (file.size > 10 * 1024 * 1024) throw new Error('Elige una foto de menos de 10 MB.');
              let bitmap; try { bitmap = await createImageBitmap(file); } catch { throw new Error('No se pudo abrir la imagen. Utiliza JPG, PNG o WebP.'); }
              const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
              const ctx = canvas.getContext('2d'), side = Math.min(bitmap.width, bitmap.height);
              ctx.filter = 'grayscale(1)'; ctx.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 256, 256); bitmap.close();
              const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .85));
              if (!blob) throw new Error('No se pudo preparar la imagen.');
              await api('/api/profile/avatar', { method:'PUT', headers:{'Content-Type':'image/webp'}, body:blob });
            }
            await post('/api/profile', { alias:dialog.querySelector('#profile-alias').value });
          });
        };
        const remove = dialog.querySelector('#remove-avatar');
        if (remove) remove.onclick = () => save(() => api('/api/profile/avatar', {method:'DELETE'}));
      };
    } catch (error) { if (current(version)) target.textContent = error.message; }
  }
  async function gallery(version, mine, adminGroup = null) {
    shell(`<section class="wall-shell">${adminGroup ? '<header class="wall-header"><a class="brand" href="/admin" data-route="/admin">PHOTOWN</a><span id="class-name"></span><a class="button" href="/admin" data-route="/admin">Administración</a></header>' : header()}${!adminGroup && state().groups.length > 1 ? '<nav id="group-circles" aria-label="Tus grupos"></nav>' : ''}${mine ? '<section id="my-profile" class="my-profile" aria-label="Mi perfil"></section>' : ''}<h1 class="sr-only">${mine ? 'YO, mis fotografías' : 'Muro de ' + escape(state().name)}</h1><p id="message" class="wall-message" role="status">Cargando fotografías…</p><div id="photos" class="mosaic"></div><button id="more" class="load-more" hidden>Cargar más fotografías</button><div id="navigation">${adminGroup ? '' : navigation(mine)}</div></section>`);
    bindGroup();
    if (mine) renderProfile(version);
    if (!adminGroup && state().groups.length > 1) {
      const circles = root.querySelector('#group-circles');
      for (const group of state().groups) {
        const button = document.createElement('button'); button.setAttribute('aria-label', group.name); button.setAttribute('aria-pressed', String(group.id === state().id));
        button.innerHTML = `<span class="group-circle">${group.has_cover ? `<img src="/api/groups/${group.id}/cover" alt="">` : icon('group')}</span><span>${escape(group.name)}</span>`;
        button.onclick = async () => {
          circles.querySelectorAll('button').forEach(control => control.disabled = true);
          try { await post('/api/groups/select', { group: group.id }); await state().refresh(); if (current(version)) navigate('/wall'); }
          catch (error) { if (current(version)) root.querySelector('#message').textContent = error.message; }
          finally { circles.querySelectorAll('button').forEach(control => control.disabled = false); }
        };
        circles.append(button);
      }
    }
    const container = root.querySelector('#photos'), more = root.querySelector('#more'), report = text => { if (current(version)) root.querySelector('#message').textContent = text; };
    const photos = new Map(), selected = new Set(); let selecting = mine && selectionRequested, working = false, cursor, loading = false;
    selectionRequested = false;
    function selectionBar() {
      if (adminGroup) return;
      const nav = root.querySelector('#navigation');
      if (!selecting) {
        nav.innerHTML = navigation(mine);
        nav.querySelectorAll('[data-route]').forEach(el => el.onclick = event => { event.preventDefault(); navigate(el.dataset.route); });
        bindGroup();
      } else {
        nav.innerHTML = `<nav class="selection-nav" aria-label="Selección de fotografías"><button id="cancel-selection" aria-label="Cancelar selección" ${working ? 'disabled' : ''}>${icon('close')}</button><span role="status" aria-label="${selected.size} fotografías seleccionadas">${selected.size}</span><button id="download-selection" aria-label="Descargar seleccionadas" ${!selected.size || working ? 'disabled' : ''}>${icon('download')}</button><button aria-label="Eliminar" id="delete-selection" ${!selected.size || working ? 'disabled' : ''}>${icon('trash')}</button></nav>`;
        nav.querySelector('#cancel-selection').onclick = () => { selected.clear(); selecting = false; update(); container.querySelector('button')?.focus(); };
        nav.querySelector('#download-selection').onclick = downloadSelected;
        nav.querySelector('#delete-selection').onclick = () => remove([...selected].map(id => photos.get(id)));
      }
    }
    function update() {
      container.querySelectorAll('.mosaic-tile').forEach(tile => { tile.classList.toggle('selected', selected.has(tile.dataset.id)); tile.closest('.photo-frame')?.classList.toggle('selected', selected.has(tile.dataset.id)); const checkbox = tile.closest('.photo-frame')?.querySelector('input[type=checkbox]'); if (checkbox) { checkbox.checked = selected.has(tile.dataset.id); checkbox.disabled = working; } if (selecting) tile.setAttribute('aria-pressed', String(selected.has(tile.dataset.id))); else tile.removeAttribute('aria-pressed'); });
      selectionBar();
    }
    function toggle(photo) {
      if (working || !current(version)) return;
      if (selected.has(photo.id)) selected.delete(photo.id);
      else { if (selected.size >= 50) { report('Selecciona hasta 50 fotografías por operación.'); return; } selected.add(photo.id); }
      selecting = true; update();
    }
    async function remove(items, viewer) {
      if (working || !items.length || !(await confirmDeletion(items)) || !current(version)) return;
      working = true; if (selecting) selectionBar();
      if (viewer) viewer.querySelectorAll('button').forEach(button => button.disabled = true);
      let deleted = 0;
      try {
        for (const photo of items) {
          await api(`/api/library/${photo.id}`, { method: 'DELETE' });
          photos.delete(photo.id); selected.delete(photo.id); container.querySelector(`[data-id="${photo.id}"]`)?.closest('.photo-frame').remove(); deleted++;
        }
        viewer?.close(); if (!selected.size) selecting = false;
        report(`${deleted === 1 ? 'Fotografía eliminada' : deleted + ' fotografías eliminadas'} definitivamente.`);
      } catch (error) { const text = `${deleted ? deleted + ' eliminadas. ' : ''}${error.message} Puedes reintentar las pendientes.`; report(text); if (viewer) viewer.querySelector('.viewer-message').textContent = text; }
      finally { working = false; if (current(version)) update(); if (viewer) viewer.querySelectorAll('button').forEach(button => button.disabled = false); }
    }
    async function downloadSelected() {
      working = true; selectionBar(); report('Preparando descarga…');
      try {
        const { downloadArchive } = await import('./zip.js');
        await downloadArchive([...selected].map(id => photos.get(id)), text => report(text));
        report('Descarga preparada. Revisa las descargas del navegador.');
      } catch (error) { report(error.message); }
      finally { working = false; if (current(version)) selectionBar(); }
    }
    function showPhoto(photo, openAlt = false) {
      const dialog = modal(`<img class="viewer-image"><div class="viewer-top"><button class="close-viewer" autofocus aria-label="Cerrar fotografía">${icon('close')}</button>${mine || photo.description ? '<button id="alt-toggle" aria-expanded="false" aria-controls="alt-panel">ALT</button>' : ''}</div>${!mine && (photo.alias || photo.has_avatar) ? '<p class="viewer-credit"></p>' : ''}${mine ? `<div class="viewer-bottom"><a class="button" href="/api/library/${photo.id}/download" download="photown-${photo.id}.webp" aria-label="Descargar fotografía">${icon('download')}</a><button id="delete-one" aria-label="Eliminar">${icon('trash')}</button></div><p class="viewer-context"></p>` : ''}<section id="alt-panel" class="alt-panel" hidden><button id="alt-close" aria-label="Cerrar descripción">×</button>${mine ? '<form><label for="description">Descripción de la imagen</label><textarea id="description" maxlength="500" rows="4" placeholder="Describe esta imagen…"></textarea><button>Guardar descripción</button></form>' : '<p class="description-text"></p>'}<p class="alt-message" role="status"></p></section><p class="viewer-message" role="status"></p>`, 'Fotografía a tamaño completo', 'photo-viewer');
      const image = dialog.querySelector('img'); image.src = `/api/images/${photo.id}`; image.alt = photo.description || 'Fotografía en blanco y negro, sin descripción disponible.';
      if (!mine && (photo.alias || photo.has_avatar)) {
        const credit = dialog.querySelector('.viewer-credit');
        if (photo.has_avatar) { const avatar = document.createElement('img'); avatar.src = `/api/photo-avatar/${photo.id}`; avatar.alt = ''; credit.append(avatar); }
        const name = document.createElement('span'); name.textContent = photo.alias || ''; credit.append(name);
      }
      dialog.querySelector('.close-viewer').onclick = () => dialog.close();
      const panel = dialog.querySelector('#alt-panel'), toggleAlt = dialog.querySelector('#alt-toggle');
      const closeAlt = () => { panel.hidden = true; toggleAlt?.setAttribute('aria-expanded', 'false'); toggleAlt?.focus(); };
      if (toggleAlt) toggleAlt.onclick = () => { panel.hidden = !panel.hidden; toggleAlt.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) panel.querySelector(mine ? 'textarea' : 'button').focus(); };
      dialog.querySelector('#alt-close').onclick = closeAlt;
      dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); else if (!panel.hidden) { event.preventDefault(); closeAlt(); } });
      if (mine) {
        dialog.querySelector('.viewer-context').textContent = `${photo.group_name} · ${labels[photo.status] || ''}`;
        dialog.querySelector('textarea').value = photo.description || '';
        dialog.querySelector('form').onsubmit = async event => {
          event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
          const description = event.target.querySelector('textarea').value.trim();
          try {
            await post(`/api/library/${photo.id}/description`, { description }); photo.description = description;
            image.alt = description || 'Fotografía en blanco y negro, sin descripción disponible.';
            container.querySelector(`[data-id="${photo.id}"] img`).alt = image.alt;
            dialog.querySelector('.alt-message').textContent = 'Descripción guardada.';
          } catch (error) { dialog.querySelector('.alt-message').textContent = error.message; }
          finally { button.disabled = false; }
        };
        dialog.querySelector('#delete-one').onclick = () => remove([photo], dialog);
      } else dialog.querySelector('.description-text').textContent = photo.description || '';
      if (openAlt) toggleAlt?.click();
    }
    function add(photo) {
      photos.set(photo.id, photo);
      const frame = document.createElement('article'); frame.className = 'photo-frame';
      const tile = document.createElement('button'); tile.className = 'mosaic-tile'; tile.dataset.id = photo.id;
      const img = document.createElement('img'); img.src = `/api/images/${photo.id}`; img.alt = photo.description || 'Fotografía en blanco y negro, sin descripción disponible.'; img.loading = 'lazy'; img.decoding = 'async';
      tile.append(img);
      const unavailable = ['uploading','deleting'].includes(photo.status);
      if (unavailable) { img.remove(); const placeholder = document.createElement('span'); placeholder.className = 'photo-placeholder'; placeholder.textContent = labels[photo.status]; tile.append(placeholder); tile.disabled = true; }
      let timer, start, suppress = false;
      const cancel = () => { clearTimeout(timer); timer = null; };
      tile.onclick = () => { if (suppress) { suppress = false; return; } if (selecting) toggle(photo); else showPhoto(photo); };
      if (mine) {
        tile.onpointerdown = event => {
          if (event.button !== 0 || working) return;
          suppress = false; start = { x: event.clientX, y: event.clientY };
          timer = setTimeout(() => { suppress = true; toggle(photo); }, 550);
        };
        tile.onpointermove = event => { if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel(); };
        tile.onpointerup = cancel; tile.onpointercancel = cancel; tile.onpointerleave = cancel;
        tile.oncontextmenu = event => { event.preventDefault(); if (!selecting) toggle(photo); };
        tile.onkeydown = event => { if (event.key === ' ' && event.shiftKey) { event.preventDefault(); toggle(photo); } };
      }
      frame.append(tile);
      if (!unavailable) {
        if (mine || photo.description) {
          const alt = document.createElement('button'); alt.className = 'tile-alt'; alt.textContent = 'ALT'; alt.setAttribute('aria-label', mine ? 'Editar descripción ALT' : 'Ver descripción ALT'); alt.onclick = () => showPhoto(photo, true); frame.append(alt);
        }
        if (!mine && (photo.alias || photo.has_avatar)) {
          const author = document.createElement('div'); author.className = 'tile-author';
          if (photo.has_avatar) { const avatar = document.createElement('img'); avatar.src = `/api/photo-avatar/${photo.id}`; avatar.alt = ''; author.append(avatar); }
          if (photo.alias) { const name = document.createElement('span'); name.textContent = photo.alias; author.append(name); }
          frame.append(author);
        }
        if (mine) {
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'tile-select'; checkbox.setAttribute('aria-label', 'Seleccionar fotografía'); checkbox.onchange = () => toggle(photo); frame.append(checkbox);
          const actions = document.createElement('div'); actions.className = 'tile-actions';
          actions.innerHTML = `<a href="/api/library/${photo.id}/download" download="photown-${photo.id}.webp" aria-label="Descargar fotografía">${icon('download')}</a><button aria-label="Eliminar fotografía">${icon('trash')}</button>`;
          actions.querySelector('button').onclick = () => remove([photo]); frame.append(actions);
        }
      }
      container.append(frame);
    }
    async function load() {
      if (loading) return; loading = true; more.disabled = true;
      try {
        const page = await api(`${adminGroup ? '/api/admin/groups/' + encodeURIComponent(adminGroup) + '/wall' : mine ? '/api/library' : '/api/wall'}${cursor ? '?before=' + encodeURIComponent(cursor) : ''}`);
        if (!current(version)) return;
        if (adminGroup) root.querySelector('#class-name').textContent = page.group.name;
        page.photos.forEach(photo => { if (!photos.has(photo.id)) add(photo); }); cursor = page.next; more.hidden = !cursor; more.textContent = 'Cargar más fotografías';
        report(photos.size ? '' : mine ? 'Todavía no has enviado fotografías. Abre la cámara para empezar.' : 'El muro está esperando las primeras fotografías aprobadas.');
        update();
      } catch (error) { if (!current(version)) return; report(error.message); more.hidden = false; more.textContent = 'Reintentar carga'; if (error.status === 401) navigate(adminGroup ? '/admin' : '/enter', true); }
      finally { loading = false; more.disabled = false; }
    }
    more.onclick = load; update(); await load();
  }
  return { gallery, settings };
}
