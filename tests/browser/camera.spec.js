import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signToken } from '../../server/tokens.js';
import AxeBuilder from '@axe-core/playwright';

const code = process.env.PHOTOWN_TEST_CODE;
test.beforeAll(() => {
  if (!code) throw new Error('Set PHOTOWN_TEST_CODE to the INVITE_CODE in your local .dev.vars.');
});
async function enter(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByLabel('Código de invitación').fill(code);
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
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
  await expect(page.getByRole('heading', { name: 'Fotografía guardada.' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Fotografía guardada.' })).toBeVisible();
});
test('denied camera permission explains recovery without offering gallery import', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.goto('/enter');
  await page.getByLabel('Código de invitación').fill(code);
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
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
  await expect(page.getByRole('heading', { name: 'Fotografía guardada.' })).toBeVisible();
});
test('visible invitation, whole-viewfinder capture, keyboard controls and permanent own-photo deletion', async ({ page }) => {
  await page.goto('/enter');
  await expect(page.getByLabel('Código de invitación')).toHaveAttribute('type', 'text');
  await page.getByLabel('Código de invitación').fill(code);
  await page.getByRole('button', { name: 'Entrar en PhoTown' }).click();
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  await page.locator('#capture-area').click();
  await expect(page).toHaveURL(/\/preview$/);
  await page.getByRole('button', { name: 'Repetir', exact: true }).click();
  const shutter = page.getByRole('button', { name: 'Fotografiar', exact: true });
  await expect(shutter).toBeEnabled(); await shutter.focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await page.getByRole('link', { name: 'Ver mis fotos' }).click();
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByLabel('Descripción de la imagen (opcional)').fill('Una imagen de prueba en blanco y negro.');
  await page.getByRole('button', { name: 'Guardar descripción' }).click();
  await expect(page.getByText('Descripción guardada.')).toBeVisible();
  await page.getByRole('button', { name: 'Borrar fotografía', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Borrar fotografía', exact: true }).click();
  await page.getByRole('button', { name: 'Borrar definitivamente', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await expect(page.getByText('Fotografía borrada definitivamente.', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('Todavía no has enviado fotografías a este grupo.')).toBeVisible();
});
test('admin can create group, rotate invitation, moderate and block participants using actual D1', async ({ page, context }) => {
  // Local-only fixture. No test-only authentication endpoint is shipped.
  const secret = /^SESSION_SECRET=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1].trim();
  const token = await signToken({ SESSION_SECRET: secret }, { sub: 'local-test-admin', email: 'gofiodesign@gmail.com' }, 'admin', 600);
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
  await expect(page.getByRole('button', { name: 'Fotografiar', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Fotografiar', exact: true }).click();
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fotografía guardada.' })).toBeVisible();
  await page.goto('/admin');
  await page.locator('.admin-row').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Gestionar grupo' }).click();
  await page.getByRole('button', { name: 'Aprobar', exact: true }).click();
  await expect(page.getByText('Publicada', { exact: true })).toBeVisible();
  await page.locator('.member-row select').selectOption('BLOCKED');
  await page.getByRole('button', { name: 'Guardar estado' }).click();
  await expect(page.getByText('Estado guardado.', { exact: true })).toBeVisible();
  await page.goto('/wall'); await expect(page.locator('.photo-card')).toHaveCount(1);
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
