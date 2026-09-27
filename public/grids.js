// Composition guides drawn over the live camera. They are an overlay only:
// nothing here is ever written into the photograph.
export const GRIDS = [
  { id: 'none', name: 'Sin guía', hint: 'Encuadre libre.' },
  { id: 'thirds', name: 'Tercios', hint: 'Coloca el sujeto o el horizonte sobre una línea o en un cruce.' },
  { id: 'phi', name: 'Proporción áurea', hint: 'Como los tercios, pero con las líneas a 0,382 y 0,618: más cerca del centro.' },
  { id: 'spiral', name: 'Espiral áurea', hint: 'Deja que la curva lleve la mirada hacia el punto donde se cierra. Gírala con «Girar».' },
  { id: 'diagonals', name: 'Diagonales', hint: 'Alinea líneas y bordes con las diagonales y sus perpendiculares para dar movimiento.' },
  { id: 'center', name: 'Centro y simetría', hint: 'Para composiciones simétricas, reflejos y sujetos centrados.' }
];
export const gridName = id => GRIDS.find(grid => grid.id === id)?.name || 'Sin guía';
const PHI = (1 + Math.sqrt(5)) / 2;
const round = value => Math.round(value * 10) / 10;
const line = (x1, y1, x2, y2) => `M${round(x1)} ${round(y1)}L${round(x2)} ${round(y2)}`;

function foot([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  return [ax + t * dx, ay + t * dy];
}

// Golden spiral built from successive squares cut from a φ:1 rectangle.
// Coordinates are in a unit rectangle (PHI × 1) and mapped to the frame.
function spiral(width, height, orientation) {
  const portrait = height > width, points = [];
  let x = 0, y = 0, w = PHI, h = 1;
  for (let i = 0; i < 11; i++) {
    let start, end, center;
    if (i % 4 === 0) { const s = h; start = [x, y + s]; end = [x + s, y]; center = [x + s, y + s]; x += s; w -= s; }
    else if (i % 4 === 1) { const s = w; start = [x, y]; end = [x + s, y + s]; center = [x, y + s]; y += s; h -= s; }
    else if (i % 4 === 2) { const s = h; start = [x + w, y]; end = [x + w - s, y + s]; center = [x + w - s, y]; w -= s; }
    else { const s = w; start = [x + w, y + h]; end = [x, y + h - s]; center = [x + w, y + h - s]; h -= s; }
    const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
    let delta = Math.atan2(end[1] - center[1], end[0] - center[0]) - a0;
    if (delta > Math.PI) delta -= 2 * Math.PI; if (delta < -Math.PI) delta += 2 * Math.PI;
    const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
    for (let step = i ? 1 : 0; step <= 12; step++) {
      const angle = a0 + delta * step / 12;
      points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
    }
  }
  const flipX = orientation & 1, flipY = orientation & 2;
  const map = ([u, v]) => {
    let px = u / PHI, py = v; // 0..1
    if (portrait) [px, py] = [py, px];
    if (flipX) px = 1 - px;
    if (flipY) py = 1 - py;
    return [px * width, py * height];
  };
  return 'M' + points.map(point => map(point).map(round).join(' ')).join('L');
}

export function gridPath(kind, width, height, orientation = 0) {
  const paths = [];
  const vertical = f => paths.push(line(width * f, 0, width * f, height));
  const horizontal = f => paths.push(line(0, height * f, width, height * f));
  if (kind === 'thirds') { [1 / 3, 2 / 3].forEach(f => { vertical(f); horizontal(f); }); }
  if (kind === 'phi') { [1 - 1 / PHI, 1 / PHI].forEach(f => { vertical(f); horizontal(f); }); }
  if (kind === 'spiral') paths.push(spiral(width, height, orientation));
  if (kind === 'diagonals') {
    const tl = [0, 0], tr = [width, 0], bl = [0, height], br = [width, height];
    paths.push(line(...tl, ...br), line(...tr, ...bl));
    for (const [corner, a, b] of [[tr, tl, br], [bl, tl, br], [tl, tr, bl], [br, tr, bl]]) paths.push(line(...corner, ...foot(corner, a, b)));
  }
  if (kind === 'center') {
    vertical(.5); horizontal(.5);
    const r = Math.min(width, height) * .12;
    paths.push(`M${round(width / 2 - r)} ${round(height / 2)}a${round(r)} ${round(r)} 0 1 0 ${round(2 * r)} 0a${round(r)} ${round(r)} 0 1 0 ${round(-2 * r)} 0`);
  }
  return paths.join('');
}

// Points worth marking: the four "power points" of thirds and φ grids.
function markers(kind, width, height) {
  const f = kind === 'thirds' ? [1 / 3, 2 / 3] : kind === 'phi' ? [1 - 1 / PHI, 1 / PHI] : [];
  return f.flatMap(fx => f.map(fy => [fx * width, fy * height]));
}

export function gridSVG(kind, width, height, orientation = 0) {
  if (!kind || kind === 'none') return '';
  const d = gridPath(kind, width, height, orientation);
  const dots = markers(kind, width, height).map(([x, y]) => `<circle cx="${round(x)}" cy="${round(y)}" r="5"/>`).join('');
  return `<svg class="grid-overlay" viewBox="0 0 ${round(width)} ${round(height)}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><g class="grid-shadow"><path d="${d}"/>${dots}</g><g class="grid-lines"><path d="${d}"/>${dots}</g></svg>`;
}

// Small static preview used in challenge cards and the guide picker.
export function gridIcon(kind, orientation = 0) {
  const d = kind === 'none' ? '' : gridPath(kind, 60, 40, orientation);
  return `<svg class="grid-icon" viewBox="-1 -1 62 42" aria-hidden="true" focusable="false"><rect x="0" y="0" width="60" height="40"/><path d="${d}"/></svg>`;
}

// Place the overlay exactly over the visible picture of an object-fit:contain video.
export function fitOverlay(container, media, holder) {
  const width = media.videoWidth || media.naturalWidth, height = media.videoHeight || media.naturalHeight;
  const box = container.getBoundingClientRect();
  if (!width || !height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / width, box.height / height);
  const shown = { width: width * scale, height: height * scale };
  Object.assign(holder.style, { width: `${shown.width}px`, height: `${shown.height}px`, left: `${(box.width - shown.width) / 2}px`, top: `${(box.height - shown.height) / 2}px` });
  return shown;
}
