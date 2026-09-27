import { gridIcon, gridName, GRIDS } from './grids.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => new Date(value.length === 10 ? value + 'T12:00:00' : value).toLocaleDateString('es', { day: 'numeric', month: 'long' });
function ago(value) {
  const minutes = Math.round((Date.now() - new Date(value)) / 60000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 1440) return `hace ${Math.round(minutes / 60)} h`;
  return date(value);
}

export function communityUI({ root, api, shell, navigate, state, current, ui }) {
  const back = '<a class="button back-button" href="/wall" data-route="/wall">Volver al muro</a>';

  async function challenges(version) {
    shell(`<section class="page-shell">${ui.header()}<h1>Retos</h1><p class="lead">Una propuesta, una guía de composición en la cámara y un muro para comparar cómo lo resolvemos.</p><p id="message" class="wall-message" role="status">Cargando retos…</p><div id="challenge-list" class="challenge-list"></div><details class="guide-help"><summary>¿Qué es cada guía?</summary><dl></dl></details>${back}</section>`);
    const help = root.querySelector('.guide-help dl');
    for (const grid of GRIDS.filter(item => item.id !== 'none')) help.insertAdjacentHTML('beforeend', `<dt>${gridIcon(grid.id)}<span>${escape(grid.name)}</span></dt><dd>${escape(grid.hint)}</dd>`);
    try {
      await state().refresh(); if (!current(version)) return;
      const list = state().challenges || [];
      const target = root.querySelector('#challenge-list');
      root.querySelector('#message').textContent = list.length ? '' : state().id ? 'Todavía no hay retos en este grupo. Mientras tanto, prueba las guías de composición desde la cámara.' : 'Todavía no perteneces a ningún grupo.';
      for (const item of list) {
        const card = document.createElement('article'); card.className = 'challenge-card' + (item.active ? '' : ' closed');
        card.innerHTML = `<div class="challenge-grid">${gridIcon(item.grid)}</div><div class="challenge-body"><p class="eyebrow">${item.active ? 'Abierto' : 'Cerrado'}${item.ends_at ? ' · hasta el ' + escape(date(item.ends_at)) : ''}</p><h2></h2><p class="challenge-prompt"></p><p class="note">Guía: ${escape(gridName(item.grid))} · ${item.photos} ${item.photos === 1 ? 'foto' : 'fotos'} en el muro${item.mine ? ` · has enviado ${item.mine}` : ''}</p><div class="challenge-actions">${item.active ? `<a class="button primary" href="/camera?challenge=${item.id}" data-route="/camera?challenge=${item.id}">Fotografiar</a>` : ''}<a class="button" href="/wall?challenge=${item.id}" data-route="/wall?challenge=${item.id}">Ver fotos</a></div></div>`;
        card.querySelector('h2').textContent = item.title;
        card.querySelector('.challenge-prompt').textContent = item.prompt;
        card.querySelectorAll('[data-route]').forEach(el => el.onclick = event => { event.preventDefault(); navigate(el.dataset.route); });
        target.append(card);
      }
    } catch (error) { if (current(version)) root.querySelector('#message').textContent = error.message; }
  }

  async function notifications(version) {
    shell(`<section class="page-shell">${ui.header()}<h1>Avisos</h1><p id="message" class="wall-message" role="status">Cargando avisos…</p><ol id="notice-list" class="notice-list"></ol>${back}</section>`);
    try {
      const { notifications: items } = await api('/api/notifications'); if (!current(version)) return;
      const list = root.querySelector('#notice-list');
      root.querySelector('#message').textContent = items.length ? '' : 'No tienes avisos todavía. Aquí verás fotos nuevas de tu grupo, reacciones a tus fotos y retos.';
      for (const item of items) {
        const row = document.createElement('li'); row.className = 'notice' + (item.read_at ? '' : ' unread');
        row.innerHTML = `${item.photo_id ? `<button class="notice-photo" aria-label="Ver la fotografía"><img alt="" loading="lazy" src="/api/images/${escape(item.photo_id)}?size=thumb"></button>` : `<span class="notice-photo">${item.kind === 'challenge' ? ui.icon('target') : ui.icon('bell')}</span>`}<div><p class="notice-text"></p><p class="note">${escape(ago(item.created_at))}${item.read_at ? '' : ' · <span class="new">nuevo</span>'}</p></div>`;
        row.querySelector('.notice-text').textContent = item.text;
        const photoButton = row.querySelector('button.notice-photo');
        if (photoButton) {
          photoButton.querySelector('img').onerror = () => row.querySelector('.notice-photo').replaceChildren(document.createRange().createContextualFragment(ui.icon('bell')));
          photoButton.onclick = () => {
            const dialog = ui.modal(`<img class="viewer-image" alt="Fotografía del aviso"><div class="viewer-top"><button class="close-viewer" autofocus aria-label="Cerrar fotografía">${ui.icon('close')}</button></div><p class="viewer-message" role="status"></p>`, 'Fotografía a tamaño completo', 'photo-viewer');
            dialog.querySelector('img').src = `/api/images/${item.photo_id}`;
            dialog.querySelector('img').onerror = () => { dialog.querySelector('.viewer-message').textContent = 'Esta fotografía ya no está disponible.'; };
            dialog.querySelector('.close-viewer').onclick = () => dialog.close();
          };
        }
        if (item.kind === 'challenge' && item.challenge_id) {
          const link = document.createElement('a'); link.className = 'button'; link.href = `/wall?challenge=${item.challenge_id}`; link.textContent = 'Ver reto';
          link.onclick = async event => {
            event.preventDefault();
            if (item.group_id && item.group_id !== state().id) { try { await api('/api/groups/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group: item.group_id }) }); await state().refresh(); } catch { /* keep current group */ } }
            navigate('/challenges');
          };
          row.querySelector('div').append(link);
        }
        list.append(row);
      }
      if (items.some(item => !item.read_at)) {
        await api('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        state().account.unread = 0;
        const badge = root.querySelector('.wall-header a[href="/notifications"] .badge'); badge?.remove();
      }
    } catch (error) { if (current(version)) root.querySelector('#message').textContent = error.message; }
  }
  return { challenges, notifications };
}
