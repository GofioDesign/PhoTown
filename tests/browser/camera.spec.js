import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signToken } from '../../server/tokens.js';
import AxeBuilder from '@axe-core/playwright';

const code = process.env.PHOTOWN_TEST_CODE;
test.beforeEach(async ({ context }) => {
  // Distinct simulated clients for the real local rate limiter.
  await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `2001:db8::${Math.floor(Math.random()*65535).toString(16)}` });
});
test.beforeAll(() => {
  if (!code) throw new Error('Set PHOTOWN_TEST_CODE to the INVITE_CODE in your local .dev.vars.');
});
async function enter(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByLabel('Código de invitación').fill(code);
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await page.getByRole('button', { name: 'Abrir cámara', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
}
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
  await expect(page.getByRole('button', { name: 'Reintentar envío' })).toBeVisible();
  const duplicate = page.waitForResponse(response => response.url().endsWith('/api/photos'));
  await page.getByRole('button', { name: 'Reintentar envío' }).click();
  expect((await duplicate).status()).toBe(200);
  expect(await (await duplicate).json()).toEqual(firstResult);
  await expect(page.getByText('Fotografía guardada. Pendiente de revisión.', { exact: true })).toBeVisible();
});
test('network failure retains the capture and id for retry', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  let failedId;
  await page.route('**/api/photos', async route => {
    failedId = route.request().headers()['idempotency-key'];
    await route.abort('internetdisconnected');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Tu fotografía sigue aquí.', { exact: false })).toBeVisible();
  await expect(page.locator('#photo')).toBeVisible();
  const retried = page.waitForRequest('**/api/photos');
  await page.getByRole('button', { name: 'Reintentar envío' }).click();
  expect((await retried).headers()['idempotency-key']).toBe(failedId);
  await expect(page.getByText('Fotografía guardada. Pendiente de revisión.', { exact: true })).toBeVisible();
});
test('denied camera permission explains recovery without offering gallery import', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.goto('/enter');
  await page.getByLabel('Código de invitación').fill(code);
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await page.getByRole('button', { name: 'Abrir cámara' }).click();
  await expect(page.getByText('Permite el acceso a la cámara', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Volver a abrir la cámara' })).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
});
test('session expiry preserves capture through renewed invitation', async ({ page, context }) => {
  await enter(page);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page.locator('#photo')).toBeVisible();
  const imageUrl = await page.locator('#photo').getAttribute('src');
  await context.clearCookies({ name: 'photown_group' });
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vuelve a entrar.' })).toBeVisible();
  await page.getByLabel('Código de invitación').fill(code);
  await page.getByRole('button', { name: 'Continuar con mi fotografía' }).click();
  await expect(page.locator('#photo')).toHaveAttribute('src', imageUrl);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Fotografía guardada. Pendiente de revisión.', { exact: true })).toBeVisible();
});
test('personal fullscreen supports ALT, original download and scoped permanent deletion', async ({ page }) => {
  await page.goto('/enter');
  await expect(page.getByLabel('Código de invitación')).toHaveAttribute('type', 'text');
  await page.getByLabel('Código de invitación').fill(code);
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await expect(page).toHaveURL(/\/wall$/);
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
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await expect(page.getByText('Las copias de otros grupos', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Eliminar definitivamente', exact: true }).click();
  await expect(page.locator('.mosaic-tile')).toHaveCount(0);
  await expect(page.getByText('Fotografía eliminada definitivamente.', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('Todavía no has enviado fotografías. Abre la cámara para empezar.')).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
});

test('admin can create group, rotate invitation, moderate and block participants using actual D1', async ({ page, context }) => {
  // Local-only fixture. No test-only authentication endpoint is shipped.
  const secret = /^SESSION_SECRET=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1].trim();
  const token = await signToken({ SESSION_SECRET: secret }, { sub: 'local-test-admin-' + crypto.randomUUID(), email: 'gofiodesign@gmail.com' }, 'admin', 600);
  await context.addCookies([{ name: 'photown_admin', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administración de grupos' })).toBeVisible();
  const name = 'Prueba ' + Date.now();
  await page.getByLabel('Nombre del nuevo grupo').fill(name);
  await page.getByRole('button', { name: 'Crear grupo', exact: true }).click();
  await expect(page.getByText('Grupo creado.', { exact: true })).toBeVisible();
  const card = page.locator('.admin-row').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await card.getByRole('button', { name: 'Generar nueva invitación' }).click();
  await expect(card.locator('.invitation')).toBeVisible();
  const invitation = await card.locator('.invitation').textContent();
  expect(invitation).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  const invitationLink = await card.getByLabel('Enlace de invitación').inputValue();
  expect(new URL(invitationLink).searchParams.get('inv')).toBe(invitation);
  await expect(card.getByRole('button', { name: 'Copiar enlace de invitación', exact: true })).toBeVisible();
  await page.goto(invitationLink);
  await expect(page.getByLabel('Código de invitación')).toHaveValue(invitation);
  await expect(page).toHaveURL(/\/enter$/);
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await page.getByRole('button', { name: 'Abrir cámara' }).click();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Fotografía guardada. Pendiente de revisión.', { exact: true })).toBeVisible();
  await page.goto('/admin');
  await page.locator('.admin-row').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Gestionar grupo' }).click();
  await page.getByRole('button', { name: 'Aprobar', exact: true }).click();
  await expect(page.getByText('Publicada', { exact: true })).toBeVisible();
  await page.locator('.member-row select').selectOption('BLOCKED');
  await page.getByRole('button', { name: 'Guardar estado' }).click();
  await expect(page.getByText('Estado guardado.', { exact: true })).toBeVisible();
  await page.goto('/wall'); await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  const oldIdentity = (await (await page.request.get('/api/session')).json()).identity;
  await context.clearCookies({ name: 'photown_publisher' }); await context.clearCookies({ name: 'photown_group' });
  await page.goto(invitationLink); await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await expect(page).toHaveURL(/\/wall$/);
  await page.goto('/settings');
  await page.getByText('Recuperar mi acceso', { exact: true }).click();
  await expect(page.getByLabel('Mi identidad', { exact: true })).toHaveValue(/[a-f0-9-]{36}/);
  const newIdentity = await page.getByLabel('Mi identidad', { exact: true }).inputValue();
  expect(newIdentity).not.toBe(oldIdentity); expect(newIdentity).not.toBe('');
  await page.goto('/admin');
  await page.locator('.admin-row').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Gestionar grupo' }).click();
  await page.getByLabel('Identidad anterior', { exact: true }).selectOption(oldIdentity);
  await page.getByLabel('Nueva identidad', { exact: true }).fill(newIdentity);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Reasignar fotografías', exact: true }).click();
  await expect(page.getByText('1 fotografías reasignadas.', { exact: false })).toBeVisible();
  await page.goto('/my-photos'); await expect(page.locator('.mosaic-tile')).toHaveCount(1);
});
test('main screens have no automated WCAG A/AA violations', async ({ page }) => {
  for (const path of ['/', '/enter', '/admin']) {
    await page.goto(path); await expect(page.locator('h1,h2').first()).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  }
  await enter(page);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await expect(page.locator('#photo')).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
});

test('multiple groups, personal archive, alias, ALT, handedness and retry preserve independent copies', async ({ page, context }) => {
  const secret = /^SESSION_SECRET=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1].trim();
  const token = await signToken({ SESSION_SECRET: secret }, { sub: 'local-test-admin-' + crypto.randomUUID(), email: 'gofiodesign@gmail.com' }, 'admin', 600);
  await context.addCookies([{ name:'photown_admin', value:token, domain:'localhost', path:'/', httpOnly:true, sameSite:'Strict' }]);
  const post = (path, data) => page.request.post(path, { headers:{Origin:'http://localhost:8787'}, data });
  const firstName = 'Destino A '+Date.now(), secondName = 'Destino B '+Date.now();
  const first = await (await post('/api/admin/groups', {name:firstName})).json();
  const second = await (await post('/api/admin/groups', {name:secondName})).json();
  expect((await post('/api/enter', {code:first.code})).status()).toBe(200); expect((await post('/api/enter', {code:second.code})).status()).toBe(200);
  await page.goto('/wall'); await page.locator('#group-menu').click();
  await page.getByRole('dialog').getByRole('button', {name:firstName, exact:true}).click();
  await expect(page.locator('#group-menu')).toHaveText(firstName);
  await page.getByRole('button', {name:'Personalización'}).click();
  await expect(page.getByRole('button', {name:'Guardar alias'})).toBeEnabled();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByLabel('Mi alias (opcional)').fill('Mi mirada'); await page.getByRole('button',{name:'Guardar alias'}).click();
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
  await expect(page.getByRole('button',{name:'Reintentar envío'})).toBeVisible();
  await page.getByRole('button',{name:'Reintentar envío'}).click();
  await expect(page).toHaveURL(/\/wall$/);
  const firstPhotos = (await (await page.request.get(`/api/admin/groups/${first.id}/photos`)).json()).photos;
  const secondPhotos = (await (await page.request.get(`/api/admin/groups/${second.id}/photos`)).json()).photos;
  expect(firstPhotos).toHaveLength(1); expect(secondPhotos).toHaveLength(1);
  await post(`/api/admin/photos/${firstPhotos[0].id}/approve`, {});
  await post(`/api/library/${firstPhotos[0].id}/description`, {description:'Luz de una ventana.'});
  await page.reload(); await expect(page.locator('.mosaic-tile')).toHaveCount(1);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
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
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
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
  await page.getByRole('button',{name:'Personalización'}).click(); await page.getByRole('button',{name:'Seleccionar varias fotos'}).click();
  await expect(page.locator('.selection-nav')).toBeVisible(); // Accessible alternative to long press.
  await page.getByRole('button',{name:'Cancelar selección'}).click();
});

test('waitlist handles validation, failure and persistence without granting access or sending mail', async ({ page, context }) => {
  const email = `sprint2-${Date.now()}@example.com`;
  await page.goto('/enter'); await page.getByRole('button',{name:'Quiero probarlo'}).click();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button',{name:'Entrar en lista de espera'}).click();
  await expect(page.getByText('Introduce un correo electrónico válido.')).toBeVisible();
  await page.getByLabel('Correo electrónico',{exact:true}).fill('bad'); await page.getByRole('button',{name:'Entrar en lista de espera'}).click();
  await expect(page.getByLabel('Correo electrónico',{exact:true})).toHaveAttribute('aria-invalid','true');
  await page.getByLabel('Correo electrónico',{exact:true}).fill(email);
  await page.route('**/api/waitlist', route => route.abort('internetdisconnected'), {times:1});
  await page.getByRole('button',{name:'Entrar en lista de espera'}).click();
  await expect(page.locator('#waitlist-message')).toContainText('Comprueba tu conexión');
  await page.getByRole('button',{name:'Entrar en lista de espera'}).click();
  await expect(page.getByText('Gracias. Te avisaremos cuando puedas entrar.')).toBeVisible();
  expect((await (await page.request.get('/api/session')).json()).authenticated).toBe(false);
  expect((await page.request.get('/api/admin/waitlist')).status()).toBe(401);
  const secret = /^SESSION_SECRET=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1].trim();
  const token = await signToken({SESSION_SECRET:secret},{sub:'local-test-admin-'+crypto.randomUUID(),email:'gofiodesign@gmail.com'},'admin',600);
  await context.addCookies([{name:'photown_admin',value:token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Strict'}]);
  await page.goto('/admin'); await page.getByRole('button',{name:'Lista de espera',exact:true}).click();
  const row = page.locator('.waitlist-table article').filter({hasText:email}); await expect(row).toBeVisible();
  await row.getByRole('button',{name:'Eliminar solicitud',exact:true}).click(); await page.getByRole('button',{name:'Eliminar solicitud definitivamente'}).click();
  await expect(row).toHaveCount(0);
});

test('YO profile photo, direct card controls and administrator classroom wall', async ({ page, context }, testInfo) => {
  await enter(page); await page.getByRole('button',{name:'Fotografiar',exact:true}).click();
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
  const secret = /^SESSION_SECRET=(.+)$/m.exec(readFileSync('.dev.vars','utf8'))[1].trim();
  const token = await signToken({SESSION_SECRET:secret},{sub:'local-class-'+crypto.randomUUID(),email:'gofiodesign@gmail.com'},'admin',600);
  await context.addCookies([{name:'photown_admin',value:token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Strict'}]);
  const photo = (await (await page.request.get('/api/library')).json()).photos[0];
  await page.request.post(`/api/admin/photos/${photo.id}/approve`,{headers:{Origin:'http://localhost:8787'}});
  await page.goto('/wall');
  await expect(page.locator(`.photo-frame:has([data-id="${photo.id}"]) .tile-author`)).toHaveText('Mirada de prueba');
  await page.locator(`.photo-frame:has([data-id="${photo.id}"]) .tile-author img`).evaluate(img => img.decode());
  await page.locator(`.photo-frame:has([data-id="${photo.id}"])`).getByRole('button',{name:'Ver descripción ALT'}).click();
  await expect(page.locator('.description-text')).toHaveText('Imagen para una clase.');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await context.clearCookies({name:'photown_publisher'}); await context.clearCookies({name:'photown_group'});
  await page.goto('/admin');
  await page.locator('.admin-row').filter({has:page.getByRole('heading',{name:'PhoTown',exact:true})}).getByRole('link',{name:'Muro',exact:true}).click();
  await page.setViewportSize({width:1440,height:900});
  await expect(page.locator('#class-name')).toHaveText('PhoTown');
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
  await expect(page.locator(`[data-id="${photo.id}"]`)).toBeVisible();
  await page.locator('.mosaic-tile img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  await page.screenshot({path:testInfo.outputPath('classroom-wall.png'),fullPage:true});
  await page.locator(`[data-id="${photo.id}"]`).click();
  await expect(page.locator('.photo-viewer')).toBeVisible();
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.locator('.viewer-image').evaluate(img => img.decode());
  await page.screenshot({path:testInfo.outputPath('classroom-fullscreen.png')});
  await page.keyboard.press('Escape'); await expect(page.locator(`[data-id="${photo.id}"]`)).toBeFocused();
});
