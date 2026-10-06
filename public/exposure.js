// Manual exposure for the live camera where the browser exposes it (Chrome on Android).
// exposureTime is in units of 100 µs (Media Capture Image spec). Aperture is fixed on phones.
const SPEEDS = [8000, 4000, 2000, 1000, 500, 250, 125, 60, 30, 15, 8, 4, 2]; // 1/x s
const ISOS = [25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800];

export const speedLabel = units => {
  const seconds = units / 10000;
  return seconds >= .5 ? `${Math.round(seconds * 10) / 10} s` : `1/${Math.round(1 / seconds)} s`;
};
export function exposureSupport(capabilities = {}) {
  const manual = Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('manual');
  const range = value => Boolean(value) && Number.isFinite(value.min) && Number.isFinite(value.max) && value.max > value.min;
  return {
    manual: manual && (range(capabilities.exposureTime) || range(capabilities.iso)),
    time: manual && range(capabilities.exposureTime),
    iso: manual && range(capabilities.iso),
    compensation: range(capabilities.exposureCompensation)
  };
}
// Photographic stops that fit the camera's range, always including its limits.
export function speedSteps({ min, max }) {
  const steps = SPEEDS.map(x => 10000 / x).filter(v => v >= min && v <= max);
  return [...new Set([min, ...steps, max].map(v => Math.round(v * 100) / 100))].sort((a, b) => a - b);
}
export function isoSteps({ min, max }) {
  return [...new Set([min, ...ISOS.filter(v => v > min && v < max), max])];
}
const nearest = (steps, value) => steps.reduce((best, step, index) => Math.abs(step - value) < Math.abs(steps[best] - value) ? index : best, 0);

export function exposurePanel(track, panel, say) {
  const capabilities = track.getCapabilities?.() || {}, support = exposureSupport(capabilities);
  if (!support.manual && !support.compensation) return null;
  const settings = track.getSettings?.() || {};
  const speeds = support.time ? speedSteps(capabilities.exposureTime) : [], isos = support.iso ? isoSteps(capabilities.iso) : [];
  const comp = capabilities.exposureCompensation;
  panel.innerHTML = `<div class="exposure-mode" role="group" aria-label="Modo de exposición">${support.manual ? '<button type="button" data-mode="manual" aria-pressed="false">Manual</button>' : ''}<button type="button" data-mode="auto" aria-pressed="true">Auto</button></div>
    ${support.time ? `<label>Velocidad <output data-out="time"></output><input type="range" data-input="time" min="0" max="${speeds.length - 1}" step="1"></label>` : ''}
    ${support.iso ? `<label>ISO <output data-out="iso"></output><input type="range" data-input="iso" min="0" max="${isos.length - 1}" step="1"></label>` : ''}
    ${support.compensation ? `<label>Compensación <output data-out="comp"></output><input type="range" data-input="comp" min="${comp.min}" max="${comp.max}" step="${comp.step || .1}"></label>` : ''}
    <p class="note">La apertura (F) es fija en los móviles.</p>
    ${support.time && support.iso ? '' : `<p class="note">Esta cámara no deja elegir ${support.time ? 'el ISO' : support.iso ? 'la velocidad' : 'velocidad ni ISO'} desde una web. La cámara informa: ${exposureReport(track).replace(/[&<>]/g, '')}</p>`}`;
  const input = name => panel.querySelector(`[data-input=${name}]`), output = name => panel.querySelector(`[data-out=${name}]`);
  let mode = 'auto';
  if (input('time')) input('time').value = nearest(speeds, settings.exposureTime ?? speeds[Math.floor(speeds.length / 2)]);
  if (input('iso')) input('iso').value = nearest(isos, settings.iso ?? isos[0]);
  if (input('comp')) input('comp').value = settings.exposureCompensation ?? 0;
  const show = () => {
    if (output('time')) output('time').textContent = speedLabel(speeds[input('time').value]);
    if (output('iso')) output('iso').textContent = String(isos[input('iso').value]);
    if (output('comp')) { const value = Number(input('comp').value); output('comp').textContent = `${value > 0 ? '+' : ''}${(Math.abs(value) < .05 ? 0 : value).toFixed(1)} EV`; }
    for (const name of ['time', 'iso']) if (input(name)) input(name).disabled = mode !== 'manual';
    if (input('comp')) input('comp').disabled = mode === 'manual';
    panel.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  };
  let pending;
  const apply = () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const constraint = mode === 'manual'
        ? { exposureMode: 'manual', ...(input('time') ? { exposureTime: speeds[input('time').value] } : {}), ...(input('iso') ? { iso: isos[input('iso').value] } : {}) }
        : { exposureMode: 'continuous', ...(input('comp') ? { exposureCompensation: Number(input('comp').value) } : {}) };
      try { await track.applyConstraints({ advanced: [constraint] }); say(''); }
      catch { say('Esta cámara no ha aceptado el ajuste. Prueba otro valor o vuelve a Auto.'); }
    }, 120);
  };
  panel.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => { mode = button.dataset.mode; show(); apply(); });
  panel.querySelectorAll('input').forEach(element => element.oninput = () => { show(); apply(); });
  show();
  return { support };
}

// One line describing what the camera reported, shown when manual exposure is not offered.
export function exposureReport(track) {
  const capabilities = track.getCapabilities?.();
  if (!capabilities) return 'el navegador no da información de la cámara.';
  const range = value => value && Number.isFinite(value.min) ? `${value.min}–${value.max}` : 'no';
  return [
    `modos ${Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.length ? capabilities.exposureMode.join('/') : 'no'}`,
    `tiempo ${range(capabilities.exposureTime)}`,
    `ISO ${range(capabilities.iso)}`,
    `compensación ${range(capabilities.exposureCompensation)}`
  ].join(', ') + '.';
}
