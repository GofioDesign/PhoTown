import { test, expect, request as playwrightRequest } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signToken } from '../../server/tokens.js';

// axe is optional so the suite also runs where the package is unavailable.
let AxeBuilder = null;
try { ({ default: AxeBuilder } = await import('@axe-core/playwright')); } catch { /* accessibility checks skipped */ }
async function a11y(page) {
  if (!AxeBuilder) return;
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
}
const origin = 'http://localhost:8787';
const vars = () => readFileSync('.dev.vars', 'utf8');
test.beforeAll(() => {
  if (!/^DEV_LOGIN_LINKS=true$/m.test(vars())) throw new Error('Set DEV_LOGIN_LINKS=true in your local .dev.vars (see .dev.vars.example).');
});
test.beforeEach(async ({ context }) => {
  // Distinct simulated clients for the real local rate limiter.
  await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `2001:db8::${Math.floor(Math.random()*65535).toString(16)}` });
});
async function adminToken() {
  const secret = /^SESSION_SECRET=(.+)$/m.exec(vars())[1].trim();
  return signToken({ SESSION_SECRET: secret }, { sub: 'local-test-admin-' + crypto.randomUUID(), email: 'gofiodesign@gmail.com' }, 'admin', 600);
}
// Local-only fixture. No test-only authentication endpoint is shipped: the
// Google admin session is signed with the local secret.
async function adminCookie(context) {
  await context.addCookies([{ name: 'photown_admin', value: await adminToken(), domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' }]);
}
async function adminApi() {
  return playwrightRequest.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin, Cookie: `photown_admin=${await adminToken()}`, 'CF-Connecting-IP': `2001:db8::a:${Math.floor(Math.random()*65535).toString(16)}` } });
}
const uniqueEmail = () => `persona-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;
async function createGroup(name = 'Prueba ' + Date.now()) {
  const api = await adminApi();
  const group = await (await api.post('/api/admin/groups', { data: { name } })).json();
  return { id: group.id, name };
}
async function inviteLink(groupId, email) {
  const api = await adminApi();
  const response = await api.post(`/api/admin/groups/${groupId}/invitations`, { data: { emails: [email] } });
  expect(response.status()).toBe(200);
  return (await response.json()).results[0].dev_link;
}
// Invite by email and follow the emailed sign-in link.
async function signIn(page, { email = uniqueEmail(), group } = {}) {
  group ||= await createGroup();
  await page.goto(await inviteLink(group.id, email));
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await expect(page).toHaveURL(/\/wall$/);
  return { email, group };
}
async function enter(page, options) {
  const account = await signIn(page, options);
  await page.getByRole('button', { name: 'Abrir cámara', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  return account;
}
const outboxSize = page => page.evaluate(async () => (await self.PhotownOutbox.list()).length);
test('camera is monochrome before capture; repeat, upload and deduplication use real local R2', async ({ page }, testInfo) => {
  await enter(page);
  await expect(page.locator('video')).toHaveCSS('filter', 'grayscale(1)');
  await page.screenshot({ path: testInfo.outputPath('camera-mobile.png'), fullPage: true });
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.locator('#photo')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('preview-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('preview-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const pixels = await page.locator('#photo').evaluate(async img => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let maxDifference = 0;
    for (let i = 0; i < data.length; i += 4) maxDifference = Math.max(maxDifference, Math.abs(data[i] - data[i + 1]), Math.abs(data[i + 1] - data[i + 2]));
    return { maxDifference, width: canvas.width, height: canvas.height };
  });
  expect(pixels.maxDifference).toBeLessThanOrEqual(2); // WebP decoder rounding tolerance.
  expect(Math.max(pixels.width, pixels.height)).toBeLessThanOrEqual(2560);
  await page.getByRole('button', { name: 'Repetir', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page.locator('#photo')).toBeVisible();
  let firstResult;
  await page.route('**/api/photos', async route => {
    // Let R2 store the image, then simulate losing the successful response.
    const result = await route.fetch();
    expect(result.status()).toBe(201);
    firstResult = await result.json();
    await route.abort('connectionreset');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  // The capture waits in the device outbox; retrying reuses its id and R2 deduplicates.
  await expect(page.getByText('Sin conexión. La foto está guardada', { exact: false })).toBeVisible();
  // Background Sync (service worker) or the manual button resends with the same id.
  if (await page.getByRole('button', { name: 'Enviar ahora' }).isVisible()) await page.getByRole('button', { name: 'Enviar ahora' }).click();
  await expect.poll(() => outboxSize(page)).toBe(0);
  const library = (await (await page.request.get('/api/library')).json()).photos;
  expect(library).toHaveLength(1); expect(library[0].id).toBe(firstResult.id); expect(library[0].has_thumb).toBe(1);
  // A repeated upload of the same capture is recognised, not duplicated.
  const repeat = await page.evaluate(async id => (await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/webp', 'Idempotency-Key': id }, body: await (await fetch(`/api/library/${id}/download`)).blob() })).status, firstResult.id);
  expect(repeat).toBe(200);
});
test('network failure keeps the capture on the device and retries it with the same id', async ({ page, context }) => {
  await enter(page);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  let failedId;
  await page.route('**/api/photos', async route => {
    failedId = route.request().headers()['idempotency-key'];
    await route.abort('internetdisconnected');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.locator('#outbox-bar')).toContainText('Una foto guardada en este dispositivo');
  // Survives a reload: the outbox lives in IndexedDB, not in page memory.
  await page.reload();
  await expect.poll(() => outboxSize(page)).toBe(0);
  const library = (await (await page.request.get('/api/library')).json()).photos;
  expect(library.map(photo => photo.id)).toEqual([failedId]);
  // Offline capture is sent automatically when the connection returns.
  await page.getByRole('button', { name: 'Abrir cámara' }).click();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Sin conexión. La foto está guardada y se enviará sola al volver la conexión.')).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect.poll(() => outboxSize(page)).toBe(0);
  expect((await (await page.request.get('/api/library')).json()).photos).toHaveLength(2);
});
test('denied camera permission explains recovery without offering gallery import', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Abrir cámara' }).click();
  await expect(page.getByText('Permite el acceso a la cámara', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Volver a abrir la cámara' })).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
});
test('session expiry keeps the capture and sends it after signing in again by code', async ({ page, context }) => {
  const { email } = await enter(page);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page.locator('#photo')).toBeVisible();
  await context.clearCookies({ name: 'photown_publisher' });
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Tu sesión ha caducado. La foto está guardada', { exact: false })).toBeVisible();
  expect(await outboxSize(page)).toBe(1);
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  const requested = page.waitForResponse('**/api/login');
  await page.getByRole('button', { name: 'Enviarme el acceso' }).click();
  const { dev_code: code } = await (await requested).json();
  await page.getByLabel('Código de 6 números').fill(code.slice(0, 3) + ' ' + code.slice(3));
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/wall$/);
  await expect.poll(() => outboxSize(page)).toBe(0);
  expect((await (await page.request.get('/api/library')).json()).photos).toHaveLength(1);
});
test('personal fullscreen supports ALT, original download and scoped permanent deletion', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Abrir cámara' }).click();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  await page.locator('#capture-area').click();
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.locator('.destinations')).toBeHidden();
  await page.getByRole('button', { name: 'Repetir', exact: true }).click();
  const shutter = page.getByRole('button', { name: 'Fotografiar', exact: true });
  await expect(shutter).toBeEnabled(); await shutter.focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page).toHaveURL(/\/wall$/);
  await page.getByRole('link', { name: 'YO', exact: true }).click();
  await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  await page.locator('.mosaic-tile').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('.photo-viewer').getByRole('link', { name: 'Descargar fotografía', exact: true }).click();
  const file = await downloaded; expect(file.suggestedFilename()).toMatch(/^photown-.*\.webp$/); expect(await file.failure()).toBeNull();
  await page.getByRole('button', { name: 'ALT', exact: true }).click();
  await page.getByLabel('Descripción de la imagen', { exact: true }).fill('Una imagen de prueba en blanco y negro.');
  await page.getByRole('button', { name: 'Guardar descripción' }).click();
  await expect(page.getByText('Descripción guardada.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.photo-viewer')).toBeVisible();
  await expect(page.locator('.viewer-image')).toHaveAttribute('alt', 'Una imagen de prueba en blanco y negro.');
  await a11y(page);
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await expect(page.getByText('Las copias de otros grupos', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Eliminar definitivamente', exact: true }).click();
  await expect(page.locator('.mosaic-tile')).toHaveCount(0);
  await expect(page.getByText('Fotografía eliminada definitivamente.', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('Todavía no has enviado fotografías. Abre la cámara para empezar.')).toBeVisible();
  await a11y(page);
});

test('admin creates a group, invites by email, moderates, creates a challenge and blocks participants', async ({ page, context }) => {
  await adminCookie(context);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toBeVisible();
  const name = 'Prueba ' + Date.now(), email = uniqueEmail();
  await page.getByLabel('Nuevo grupo').fill(name);
  await page.getByRole('button', { name: 'Crear grupo', exact: true }).click();
  await expect(page.getByText('Grupo creado. Invita a sus participantes por correo.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Invitar' })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Correos de las personas invitadas').fill(`${email}, no-es-un-correo`);
  await page.getByRole('button', { name: 'Enviar invitaciones' }).click();
  await expect(page.getByText('Introduce un correo electrónico válido.')).toBeVisible();
  await page.getByLabel('Correos de las personas invitadas').fill(email);
  await page.getByRole('button', { name: 'Enviar invitaciones' }).click();
  await expect(page.locator('#invite-form [role=status]')).toContainText('1 invitación');
  await expect(page.locator('.invitation-list')).toContainText(email);
  await a11y(page);
  await page.getByRole('tab', { name: 'Retos' }).click();
  await page.getByLabel('Título del reto').fill('Diagonales en la ciudad');
  await page.getByLabel('Propuesta').fill('Busca líneas que crucen el encuadre.');
  await page.locator('.grid-radio', { hasText: 'Diagonales' }).click();
  await page.getByRole('button', { name: 'Crear reto y avisar al grupo' }).click();
  await expect(page.getByText('Reto creado. El grupo recibirá un aviso.')).toBeVisible();
  const group = (await (await page.request.get('/api/admin/groups')).json()).groups.find(item => item.name === name);
  // The invited person follows the emailed link (returned locally by DEV_LOGIN_LINKS).
  await page.goto(await inviteLink(group.id, email));
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await expect(page).toHaveURL(/\/wall$/);
  await expect(page.getByText('Reto abierto')).toBeVisible();
  await page.getByRole('link', { name: 'Participar' }).click();
  await expect(page.getByText('Reto · Diagonales en la ciudad')).toBeVisible();
  await expect(page.getByRole('button', { name: /Guía de composición: Diagonales/ })).toBeVisible();
  await expect(page.locator('.grid-overlay path').first()).toBeAttached();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page.getByLabel('Para el reto «Diagonales en la ciudad»')).toBeChecked();
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Fotografía guardada. Pendiente de revisión.', { exact: true })).toBeVisible();
  await page.goto('/admin');
  const card = page.locator('.admin-row').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card.getByText('1 por revisar')).toBeVisible();
  await card.getByRole('button', { name: 'Gestionar' }).click();
  await expect(page.getByText('Reto «Diagonales en la ciudad»', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Aprobar', exact: true }).click();
  await expect(page.getByText('No hay fotografías pendientes.')).toBeVisible();
  await page.getByRole('tab', { name: 'Participantes' }).click();
  await page.getByLabel(email).selectOption('BLOCKED');
  await page.getByRole('button', { name: 'Guardar estado' }).click();
  await expect(page.getByText('Estado guardado.', { exact: true })).toBeVisible();
  await page.goto('/wall?challenge=' + (await (await page.request.get('/api/challenges')).json()).challenges[0].id);
  await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  await expect(page.getByText('Reto · Diagonales en la ciudad')).toBeVisible();
  const upload = await page.request.post('/api/photos', { headers: { Origin: origin, 'Content-Type': 'image/webp', 'Idempotency-Key': crypto.randomUUID() }, data: Buffer.alloc(40) });
  expect(upload.status()).toBe(403);
});
test('sign-in screen: link, code, no account enumeration and waiting list for strangers', async ({ page, context }) => {
  const stranger = uniqueEmail();
  await page.goto('/');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await a11y(page);
  await page.getByLabel('Correo electrónico').fill(stranger);
  const response = page.waitForResponse('**/api/login');
  await page.getByRole('button', { name: 'Enviarme el acceso' }).click();
  expect(await (await response).json()).toEqual({ sent: true });
  await expect(page.getByText(`Si ${stranger} tiene invitación`, { exact: false })).toBeVisible();
  await page.getByLabel('Código de 6 números').fill('123456');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByText('El enlace o el código no es válido o ha caducado.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Usar otro correo' }).click();
  await expect(page.getByLabel('Correo electrónico')).toHaveValue(stranger);
  expect((await (await page.request.get('/api/session')).json()).authenticated).toBe(false);
  // Old invitation-code links explain the change instead of failing silently.
  await page.goto('/enter?inv=ABCDEFGH');
  await expect(page.getByText('Las invitaciones con código ya no se usan', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  // A used link cannot be reused.
  const group = await createGroup(), email = uniqueEmail(), link = await inviteLink(group.id, email);
  await page.goto(link); await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await expect(page).toHaveURL(/\/wall$/);
  await page.goto('/settings');
  await expect(page.locator('.account-email')).toHaveText(email);
  await page.getByRole('button', { name: 'Cerrar sesión en este dispositivo' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(link); await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await expect(page.getByText('no es válido o ha caducado', { exact: false })).toBeVisible();
  await adminCookie(context);
  await page.goto('/admin'); await page.getByRole('button', { name: 'Lista de espera', exact: true }).click();
  const row = page.locator('.waitlist-table article').filter({ hasText: stranger }); await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Eliminar solicitud', exact: true }).click(); await page.getByRole('button', { name: 'Eliminar solicitud definitivamente' }).click();
  await expect(row).toHaveCount(0);
});
test('main screens have no automated WCAG A/AA violations', async ({ page }) => {
  for (const path of ['/', '/login', '/admin']) {
    await page.goto(path); await expect(page.locator('h1,h2').first()).toBeVisible();
    await a11y(page);
  }
  await enter(page);
  await a11y(page);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page.locator('#photo')).toBeVisible();
  await a11y(page);
  for (const path of ['/challenges', '/notifications', '/settings']) { await page.goto(path); await expect(page.locator('h1').first()).toBeVisible(); await a11y(page); }
});
test('multiple groups, personal archive, alias, ALT, handedness and retry preserve independent copies', async ({ page, context }) => {
  await adminCookie(context);
  const post = (path, data) => page.request.post(path, { headers:{Origin:'http://localhost:8787'}, data });
  const firstName = 'Destino A '+Date.now(), secondName = 'Destino B '+Date.now();
  const first = await createGroup(firstName), second = await createGroup(secondName);
  const { email } = await signIn(page, { group: second });
  await inviteLink(first.id, email); // existing accounts join immediately
  await page.goto('/wall'); await page.locator('#group-menu').click();
  await page.getByRole('dialog').getByRole('button', {name:firstName, exact:true}).click();
  await expect(page.locator('#group-menu')).toHaveText(firstName);
  await page.getByRole('link', {name:'Personalización'}).click();
  await expect(page.getByRole('button', {name:'Guardar alias'})).toBeEnabled();
  await a11y(page);
  await page.getByLabel('Alias (opcional)').fill('Mi mirada'); await page.getByRole('button',{name:'Guardar alias'}).click();
  await expect(page.getByText('Alias guardado.')).toBeVisible();
  await page.getByLabel('Zurdo', {exact:true}).check();
  await page.getByRole('link', {name:'Volver al muro'}).click();
  await expect(page.locator('.bottom-nav > :first-child')).toHaveText(firstName);
  await page.reload(); await expect(page.locator('.bottom-nav > :first-child')).toHaveText(firstName);
  await page.getByRole('button',{name:'Abrir cámara'}).click();
  await page.getByRole('button',{name:'Fotografiar',exact:true}).click();
  await page.locator(`.destinations input[value="${second.id}"]`).check();
  let lost = false;
  await page.route('**/api/photos', async route => {
    if (route.request().headers()['x-photown-group'] === second.id && !lost) { lost = true; await route.fetch(); await route.abort('connectionreset'); }
    else await route.continue();
  });
  await page.getByRole('button',{name:'Enviar',exact:true}).click();
  await expect(page).toHaveURL(/\/wall$/);
  if (await page.getByRole('button',{name:'Enviar ahora'}).isVisible()) await page.getByRole('button',{name:'Enviar ahora'}).click();
  await expect.poll(() => outboxSize(page)).toBe(0);
  const firstPhotos = (await (await page.request.get(`/api/admin/groups/${first.id}/photos`)).json()).photos;
  const secondPhotos = (await (await page.request.get(`/api/admin/groups/${second.id}/photos`)).json()).photos;
  expect(firstPhotos).toHaveLength(1); expect(secondPhotos).toHaveLength(1);
  await post(`/api/admin/photos/${firstPhotos[0].id}/approve`, {});
  await post(`/api/library/${firstPhotos[0].id}/description`, {description:'Luz de una ventana.'});
  await page.reload(); await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  await a11y(page);
  await expect(page.locator('.tile-author').getByText('Mi mirada',{exact:true})).toHaveCount(1);
  const open = page.locator('.mosaic-tile'); await open.click();
  await expect(page.getByRole('dialog',{name:'Fotografía a tamaño completo'})).toBeVisible();
  await expect(page.locator('.viewer-credit')).toHaveText('Mi mirada');
  await page.getByRole('button',{name:'ALT',exact:true}).click();
  await expect(page.locator('.description-text')).toHaveText('Luz de una ventana.');
  await page.keyboard.press('Escape'); await expect(page.locator('.photo-viewer')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(open).toBeFocused();
  await page.getByRole('link',{name:'PHOTOWN',exact:true}).click();
  await expect(page).toHaveURL(/\/wall$/); await expect(page.locator('#group-menu')).toHaveText(firstName);
  await page.getByRole('link',{name:'YO',exact:true}).click(); await expect(page.locator('.mosaic-tile')).toHaveCount(2);
  await page.locator(`[data-id="${firstPhotos[0].id}"]`).click();
  await page.getByRole('button', {name:'Eliminar',exact:true}).click();
  await page.getByRole('button', {name:'Eliminar definitivamente'}).click();
  await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  expect((await page.request.get(`/api/library/${secondPhotos[0].id}/download`)).status()).toBe(200);
});

test('portrait camera controls fit the viewport and installation guidance is available', async ({ page }) => {
  await page.setViewportSize({width:360,height:640}); await enter(page);
  for (const size of [{width:360,height:640},{width:390,height:844},{width:320,height:568}]) {
    await page.setViewportSize(size);
    const box = await page.getByRole('button',{name:'Fotografiar',exact:true}).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y+box.height).toBeLessThanOrEqual(size.height);
    const visor = await page.locator('#capture-area').boundingBox(); expect(box.y).toBeGreaterThan(visor.y); expect(box.y+box.height).toBeLessThanOrEqual(visor.y+visor.height);
  }
  await page.screenshot({path:'test-results/camera-portrait.png'});
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole('button',{name:'Pantalla completa',exact:true}).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.getByRole('button',{name:'Salir de pantalla completa',exact:true}).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  }
  await page.goto('/settings'); await page.getByRole('button',{name:'Instalar app'}).click();
  await expect(page.getByRole('dialog',{name:'Instalar PhoTown'})).toBeVisible();
  await page.getByRole('button',{name:'Cerrar instrucciones'}).click();
  const manifest = await (await page.request.get('/manifest.webmanifest')).json(); expect(manifest.display).toBe('standalone');
  expect((await page.request.get('/icon-192.png')).status()).toBe(200);
});

test('YO long press selects, ZIP preserves originals and partial bulk deletion can be retried', async ({ page }, testInfo) => {
  await enter(page); await page.getByRole('button', {name:'Volver al muro'}).click();
  const ids = await page.evaluate(async () => {
    const ids = [];
    for (const [width, height] of [[300,500],[600,300],[400,400],[400,600],[700,400],[500,650]]) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#444'; ctx.fillRect(0,0,width,height); ctx.fillStyle = '#ddd'; ctx.fillRect(width/4,height/4,width/2,height/2);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'));
      const id = crypto.randomUUID(); const response = await fetch('/api/photos', {method:'POST',headers:{'Content-Type':'image/webp','Idempotency-Key':id},body:blob});
      if (!response.ok) throw new Error('Fixture upload failed'); ids.push(id);
    }
    return ids;
  });
  await page.getByRole('link', {name:'YO',exact:true}).click(); await expect(page.locator('.mosaic-tile')).toHaveCount(6);
  await page.locator('.mosaic-tile img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  await expect(page.locator('.bottom-nav > :first-child')).toHaveText('YO');
  await expect(page.locator('.bottom-nav a')).toHaveAttribute('aria-current','page');
  await page.screenshot({path:testInfo.outputPath('personal-mosaic-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:900}); await page.screenshot({path:testInfo.outputPath('personal-mosaic-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  const first = page.locator(`[data-id="${ids[0]}"]`), second = page.locator(`[data-id="${ids[1]}"]`);
  await first.scrollIntoViewIfNeeded(); const box = await first.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
  await expect(page.getByRole('navigation',{name:'Selección de fotografías'})).toBeVisible(); await page.mouse.up();
  await expect(first).toHaveAttribute('aria-pressed','true');
  await second.click(); await expect(second).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.selection-nav [role=status]')).toHaveText('2');
  await a11y(page);
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
  const download = page.waitForEvent('download'); await page.getByRole('button',{name:'Descargar seleccionadas'}).click();
  const archive = await download; expect(archive.suggestedFilename()).toBe('photown-mis-fotos.zip');
  const bytes = readFileSync(await archive.path()), entries = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset+18), length = bytes.readUInt16LE(offset+26), name = bytes.subarray(offset+30,offset+30+length).toString();
    entries.set(name,bytes.subarray(offset+30+length,offset+30+length+size)); offset += 30+length+size;
  }
  expect(entries.size).toBe(2);
  for (const id of ids.slice(0,2)) expect(entries.get(`photown-${id}.webp`)).toEqual(await (await page.request.get(`/api/library/${id}/download`)).body());
  await expect(page.getByRole('button',{name:'Eliminar',exact:true})).toBeEnabled();
  await page.route(`**/api/library/${ids[1]}`, route => route.abort('connectionreset'), {times:1});
  await page.getByRole('button',{name:'Eliminar',exact:true}).click();
  await page.getByRole('button',{name:'Eliminar definitivamente'}).click();
  await expect(page.locator('.mosaic-tile')).toHaveCount(5);
  await expect(page.locator('.selection-nav [role=status]')).toHaveText('1');
  await page.getByRole('button',{name:'Eliminar',exact:true}).click(); await page.getByRole('button',{name:'Eliminar definitivamente'}).click();
  await expect(page.locator('.mosaic-tile')).toHaveCount(4); await expect(page.locator('.bottom-nav')).toBeVisible();
  await page.getByRole('link',{name:'Personalización'}).click(); await page.getByRole('button',{name:'Seleccionar varias fotos'}).click();
  await expect(page.locator('.selection-nav')).toBeVisible(); // Accessible alternative to long press.
  await page.getByRole('button',{name:'Cancelar selección'}).click();
});

test('YO profile photo, direct card controls, reactions and administrator classroom wall', async ({ page, context }, testInfo) => {
  const { group } = await enter(page); await page.getByRole('button',{name:'Fotografiar',exact:true}).click();
  await page.getByRole('button',{name:'Enviar',exact:true}).click(); await expect(page).toHaveURL(/\/wall$/);
  await expect(page.locator('#group-menu')).toHaveCount(0);
  await page.getByRole('link',{name:'YO',exact:true}).click();
  await page.getByRole('button',{name:'Editar mi perfil'}).click();
  await page.getByLabel('Mi alias (opcional)').fill('Mirada de prueba');
  await page.getByLabel('Foto identificativa (opcional)').setInputFiles('public/icon-192.png');
  await page.getByRole('button',{name:'Guardar perfil'}).click();
  await expect(page.getByRole('dialog',{name:'Editar mi perfil'})).toHaveCount(0);
  await expect(page.locator('.profile-avatar img')).toBeVisible();
  await page.locator('.profile-avatar img').evaluate(img => img.decode());
  expect((await (await page.request.get('/api/session')).json()).has_avatar).toBe(true);
  await expect(page.locator('.tile-author')).toHaveCount(0);
  await page.getByRole('button',{name:'Editar descripción ALT'}).click();
  await page.getByLabel('Descripción de la imagen',{exact:true}).fill('Imagen para una clase.');
  await page.getByRole('button',{name:'Guardar descripción'}).click(); await expect(page.getByText('Descripción guardada.')).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.getByRole('checkbox',{name:'Seleccionar fotografía'}).check();
  for (const width of [280,320,390]) {
    await page.setViewportSize({width,height:640});
    for (const button of await page.locator('.selection-nav button').all()) {
      const box = await button.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x+box.width).toBeLessThanOrEqual(width); expect(box.y+box.height).toBeLessThanOrEqual(640);
    }
  }
  await page.screenshot({path:testInfo.outputPath('compact-selection.png')});
  await page.getByRole('button',{name:'Cancelar selección'}).click();
  await adminCookie(context);
  const photo = (await (await page.request.get('/api/library')).json()).photos[0];
  await page.request.post(`/api/admin/photos/${photo.id}/approve`,{headers:{Origin:'http://localhost:8787'}});
  await page.goto('/wall');
  await expect(page.locator(`.photo-frame:has([data-id="${photo.id}"]) .tile-author`)).toHaveText('Mirada de prueba');
  await page.locator(`.photo-frame:has([data-id="${photo.id}"]) .tile-author img`).evaluate(img => img.decode());
  await page.locator(`.photo-frame:has([data-id="${photo.id}"])`).getByRole('button',{name:'Ver descripción ALT'}).click();
  await expect(page.locator('.description-text')).toHaveText('Imagen para una clase.');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // A classmate reacts; the author sees the count and a notice.
  const classmate = await context.browser().newContext({ viewport: { width: 390, height: 844 } });
  const other = await classmate.newPage();
  await signIn(other, { group });
  await other.locator(`[data-id="${photo.id}"]`).click();
  await other.getByRole('button', { name: 'Buena luz', exact: true }).click();
  await expect(other.getByRole('button', { name: 'Buena luz, 1' })).toHaveAttribute('aria-pressed', 'true');
  await classmate.close();
  await page.goto('/wall');
  await expect(page.locator(`.photo-frame:has([data-id="${photo.id}"]) .tile-reactions`)).toHaveText('♥ 1');
  await page.getByRole('link', { name: /Avisos, \d+ sin leer/ }).click();
  await expect(page.getByText('ha reaccionado a tu foto: Buena luz.', { exact: false })).toBeVisible();
  await context.clearCookies({name:'photown_publisher'}); await context.clearCookies({name:'photown_group'});
  await page.goto('/admin');
  await page.locator('.admin-row').filter({has:page.getByRole('heading',{name:group.name,exact:true})}).getByRole('link',{name:'Muro de clase',exact:true}).click();
  await page.setViewportSize({width:1440,height:900});
  await expect(page.locator('#class-name')).toHaveText(group.name);
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
  await expect(page.locator(`[data-id="${photo.id}"]`)).toBeVisible();
  await page.locator('.mosaic-tile img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  await page.screenshot({path:testInfo.outputPath('classroom-wall.png'),fullPage:true});
  await page.locator(`[data-id="${photo.id}"]`).click();
  await expect(page.locator('.photo-viewer')).toBeVisible();
  await a11y(page);
  await page.locator('.viewer-image').evaluate(img => img.decode());
  await page.screenshot({path:testInfo.outputPath('classroom-fullscreen.png')});
  await page.keyboard.press('Escape'); await expect(page.locator(`[data-id="${photo.id}"]`)).toBeFocused();
});

test('browsers that cannot encode WebP (Safari) capture JPEG with a thumbnail and BN pixels', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) { return original.call(this, callback, type === 'image/webp' ? 'image/png' : type, quality); };
  });
  await enter(page);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  const pixels = await page.locator('#photo').evaluate(async img => {
    await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let max = 0; for (let i = 0; i < data.length; i += 4) max = Math.max(max, Math.abs(data[i] - data[i + 1]), Math.abs(data[i + 1] - data[i + 2]));
    return max;
  });
  expect(pixels).toBeLessThanOrEqual(4); // JPEG chroma rounding tolerance
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Fotografía guardada. Pendiente de revisión.', { exact: true })).toBeVisible();
  const [photo] = (await (await page.request.get('/api/library')).json()).photos;
  expect(photo.content_type).toBe('image/jpeg'); expect(photo.has_thumb).toBe(1);
  const original = await page.request.get(`/api/library/${photo.id}/download`);
  expect(original.headers()['content-disposition']).toMatch(/\.jpg"$/);
  const bytes = await original.body();
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
});

test('composition guides cover the visible picture and can be changed and rotated', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: /Guía de composición/ }).click();
  for (const name of ['Tercios', 'Proporción áurea', 'Diagonales', 'Centro y simetría', 'Espiral áurea']) {
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.getByRole('button', { name: `Guía de composición: ${name}. Cambiar guía` })).toBeVisible();
    const [video, grid] = await Promise.all([page.locator('video').evaluate(v => { const r = v.getBoundingClientRect(), s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { w: v.videoWidth * s, h: v.videoHeight * s }; }), page.locator('.grid-overlay').boundingBox()]);
    expect(Math.abs(grid.width - video.w)).toBeLessThan(2); expect(Math.abs(grid.height - video.h)).toBeLessThan(2);
    if (name !== 'Espiral áurea') await page.getByRole('button', { name: /Guía de composición/ }).click();
  }
  const before = await page.locator('.grid-lines path').getAttribute('d');
  await page.getByRole('button', { name: 'Girar' }).click();
  expect(await page.locator('.grid-lines path').getAttribute('d')).not.toBe(before);
  // The guide is an overlay only: the photograph never includes it.
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page.locator('#photo')).toBeVisible();
  await expect(page.locator('.grid-overlay')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Guía de composición: Espiral áurea. Cambiar guía' })).toBeVisible();
});
