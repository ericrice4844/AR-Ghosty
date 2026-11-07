// Procedural ghost art. No image files: every figure is built from layered
// gradients, procedural skin/grime textures and soft shadow, then lit from the
// face, eroded into smoke at the edges and graded to sit in the camera image.
//
// Unit space: a figure spans y = -0.5 (top) .. 0.5 (bottom), centred on x = 0,
// and is scaled to its on-screen height. Faces use their own local space where
// the head spans y = -1 (crown) .. 1 (chin), x = ±0.76.
// p = { t, agit (0..1), s (pixel scale), speaking, moving, scare }
import { clamp } from './util.js';

const TAU = Math.PI * 2;
function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function noise1(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; }
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rgb = (c, m = 1, a = 1) => `rgba(${Math.min(255, c[0] * m) | 0},${Math.min(255, c[1] * m) | 0},${Math.min(255, c[2] * m) | 0},${a})`;

function ellipse(c, x, y, rx, ry, rot = 0) { c.beginPath(); c.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot, 0, TAU); }

// Soft radial blob — the basic brush for shading.
function blob(c, x, y, rx, ry, col, a) {
  if (a <= 0.004) return;
  c.save();
  c.translate(x, y);
  c.scale(rx, ry);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(${col},${a})`);
  g.addColorStop(0.55, `rgba(${col},${a * 0.55})`);
  g.addColorStop(1, `rgba(${col},0)`);
  c.fillStyle = g;
  c.fillRect(-1, -1, 2, 2);
  c.restore();
}

// ---- procedural textures ------------------------------------------------------
function fbmCanvas(size, octaves, seed, fn) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const x = cv.getContext('2d');
  const im = x.createImageData(size, size);
  const lat = (n) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = hash1(i * 1.37 + seed * 91.3 + n);
    return g;
  };
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push({ n: 4 << o, g: lat(4 << o) });
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let v = 0, amp = 0.5, tot = 0;
      for (const { n, g } of layers) {
        const fx = (px / size) * n, fy = (py / size) * n;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = fx - ix, ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = g[(iy % n) * n + (ix % n)], b = g[(iy % n) * n + ((ix + 1) % n)];
        const cc = g[((iy + 1) % n) * n + (ix % n)], d = g[((iy + 1) % n) * n + ((ix + 1) % n)];
        v += amp * (a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy);
        tot += amp;
        amp *= 0.5;
      }
      const [r, gg, bb, al] = fn(v / tot, px, py);
      const i = (py * size + px) * 4;
      im.data[i] = r; im.data[i + 1] = gg; im.data[i + 2] = bb; im.data[i + 3] = al;
    }
  }
  x.putImageData(im, 0, 0);
  return cv;
}

let TEX = null;
function tex() {
  if (TEX) return TEX;
  TEX = {
    // multiply layer: pale with darker mottling and pores
    skin: fbmCanvas(192, 5, 1, (v) => { const k = 255 - Math.max(0, v - 0.42) * 260 - Math.random() * 18; return [k, k * 0.97, k * 0.96, 255]; }),
    // dark blotches with alpha: dirt, rot, stains
    grime: fbmCanvas(192, 5, 7, (v) => { const a = sstep(0.5, 0.78, v) * 200; return [30, 24, 18, a]; }),
    // alpha-only smoke for eroding silhouettes
    smoke: fbmCanvas(128, 4, 13, (v) => [0, 0, 0, sstep(0.38, 0.62, v) * 255]),
  };
  return TEX;
}
const patCache = new WeakMap();
function pat(c, name) {
  let m = patCache.get(c);
  if (!m) { m = {}; patCache.set(c, m); }
  if (!m[name]) m[name] = c.createPattern(tex()[name], 'repeat');
  return m[name];
}
function texture(c, name, op, alpha, scale, ox = 0, oy = 0) {
  const p = pat(c, name);
  if (!p || !p.setTransform) return;
  p.setTransform(new DOMMatrix([scale, 0, 0, scale, ox, oy]));
  c.save();
  c.globalCompositeOperation = op;
  c.globalAlpha *= alpha;
  c.fillStyle = p;
  c.fillRect(-3, -3, 6, 6);
  c.restore();
}

// ---- anatomy -------------------------------------------------------------------
// A tapering limb built as shaded flesh: dark at the edges, lit along the
// top, with knobbly joints. pts are the joint positions.
function limb(c, pts, w0, w1, sk, a = 1) {
  const n = pts.length - 1;
  const wAt = (i) => w0 + (w1 - w0) * (i / Math.max(1, n));
  const joint = (x, y, r, k) => {
    const g = c.createRadialGradient(x - r * 0.25, y - r * 0.25, r * 0.1, x, y, r);
    g.addColorStop(0, rgb(sk, 0.95 * k, a)); g.addColorStop(0.7, rgb(sk, 0.62 * k, a)); g.addColorStop(1, rgb(sk, 0.3, a * 0.0));
    c.fillStyle = g;
    ellipse(c, x, y, r, r);
    c.fill();
  };
  joint(pts[0][0], pts[0][1], wAt(0) * 0.55, 1);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / l, ny = dx / l;
    const wa = wAt(i) / 2, wb = wAt(i + 1) / 2;
    const g = c.createLinearGradient(x0 + nx * wa, y0 + ny * wa, x0 - nx * wa, y0 - ny * wa);
    g.addColorStop(0, rgb(sk, 0.3, a));
    g.addColorStop(0.28, rgb(sk, 0.78, a));
    g.addColorStop(0.5, rgb(sk, 1.0, a));
    g.addColorStop(0.75, rgb(sk, 0.66, a));
    g.addColorStop(1, rgb(sk, 0.25, a));
    c.fillStyle = g;
    // slight bulge mid-segment, like muscle wasted down to the bone
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, bw = (wa + wb) / 2 * 0.92;
    c.beginPath();
    c.moveTo(x0 + nx * wa, y0 + ny * wa);
    c.quadraticCurveTo(mx + nx * bw, my + ny * bw, x1 + nx * wb, y1 + ny * wb);
    c.lineTo(x1 - nx * wb, y1 - ny * wb);
    c.quadraticCurveTo(mx - nx * bw, my - ny * bw, x0 - nx * wa, y0 - ny * wa);
    c.closePath();
    c.fill();
    joint(x1, y1, wb * (i < n - 1 ? 1.18 : 1), i < n - 1 ? 1.05 : 0.9);
  }
}

// Long jointed fingers with dirty nails. ang = direction the fingers point.
function hand(c, x, y, ang, len, o) {
  const sk = o.skin, w = o.w ?? len * 0.11, curl = o.curl ?? 0.2, spread = o.spread ?? 0.13, a = o.a ?? 1;
  c.save();
  c.translate(x, y);
  c.rotate(ang);
  c.fillStyle = rgb(sk, 0.75, a);
  ellipse(c, len * 0.16, 0, len * 0.22, len * 0.17);
  c.fill();
  const lens = [0.86, 1, 0.94, 0.72];
  const fingers = [];
  for (let i = 0; i < 4; i++) {
    let px = len * 0.3, py = (i - 1.5) * len * 0.085, d = (i - 1.5) * spread;
    const pts = [[px, py]];
    const segs = [0.44, 0.32, 0.26];
    for (let j = 0; j < 3; j++) {
      const L = segs[j] * len * lens[i] * (o.long ?? 1);
      px += Math.cos(d) * L; py += Math.sin(d) * L;
      pts.push([px, py]);
      d += curl * (0.6 + j * 0.4) + (hash1(i * 7 + j) - 0.5) * 0.15;
    }
    fingers.push(pts);
  }
  const thumb = [[len * 0.12, len * 0.14], [len * 0.3, len * 0.3], [len * 0.44, len * 0.38]];
  for (const pts of [...fingers, thumb]) limb(c, pts, w, w * 0.72, sk, a);
  c.fillStyle = `rgba(48,38,30,${0.95 * a})`;
  for (const pts of [...fingers, thumb]) {
    const [ex, ey] = pts[pts.length - 1], [bx, by] = pts[pts.length - 2];
    const r = Math.atan2(ey - by, ex - bx);
    ellipse(c, ex - Math.cos(r) * w * 0.25, ey - Math.sin(r) * w * 0.25, w * 0.55, w * 0.36, r);
    c.fill();
  }
  c.restore();
}

// A curtain of hair. Coordinates are local (often head space).
function hairCurtain(c, o) {
  const { x0, x1, top, bottom, n, t = 0, seed = 0 } = o;
  const sway = o.sway ?? 0, w = o.w ?? 0.03, gap = o.gap;
  c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const u = (i + hash1(i + seed) * 0.8) / n;
    const x = x0 + (x1 - x0) * u;
    if (gap && x > gap[0] && x < gap[1]) continue;
    const wob = (noise1(i * 3.1 + seed + t * 0.5) - 0.5) * (o.wobble ?? 0.12);
    const len = bottom + (hash1(i * 3 + seed) - 0.5) * Math.abs(bottom - top) * 0.15;
    const sx = x * (o.crown ?? 0.55), sy = top + Math.abs(x) * (o.arch ?? 0.25);
    c.strokeStyle = `rgba(${o.col || '6,5,5'},${0.55 + hash1(i * 5 + seed) * 0.42})`;
    c.lineWidth = w * (0.5 + hash1(i * 11 + seed) * 0.9);
    c.beginPath();
    c.moveTo(sx, sy);
    c.bezierCurveTo(x * 1.05, sy + (len - sy) * 0.3, x * 1.15 + sway * 0.5 + wob, sy + (len - sy) * 0.7, x * (o.flare ?? 1.2) + sway + wob * 2, len);
    c.stroke();
  }
  // a few lighter strands catch the light
  c.strokeStyle = 'rgba(120,120,115,0.18)';
  c.lineWidth = w * 0.3;
  for (let i = 0; i < n / 6; i++) {
    const x = x0 + (x1 - x0) * hash1(i * 17 + seed);
    if (gap && x > gap[0] && x < gap[1]) continue;
    c.beginPath();
    c.moveTo(x * 0.55, top + Math.abs(x) * 0.25);
    c.quadraticCurveTo(x * 1.1 + sway * 0.5, (top + bottom) / 2, x * 1.2 + sway, bottom * 0.9);
    c.stroke();
  }
}

// ---- faces -----------------------------------------------------------------------
function eye(c, x, y, o) {
  const s = o.eyeSize ?? 1, ew = 0.17 * s, eh = 0.08 * s * (o.eyeOpen ?? 1);
  const lx = (o.lookX ?? 0) * ew * 0.35, ly = (o.lookY ?? 0) * eh * 0.3;
  const type = o.eyes || 'human';
  const P = new Path2D();
  P.moveTo(x - ew, y);
  P.quadraticCurveTo(x, y - eh * 2.1, x + ew, y - eh * 0.1);
  P.quadraticCurveTo(x, y + eh * 1.6, x - ew, y);
  if (type === 'hollow') {
    c.save();
    c.translate(x, y + eh * 0.3);
    c.scale(ew * 1.15, eh * 2.3);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, '#000'); g.addColorStop(0.4, 'rgba(0,0,0,0.95)'); g.addColorStop(0.75, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(-1, -1, 2, 2);
    c.restore();
    blob(c, x + lx, y, ew * 0.08, ew * 0.08, '230,230,230', 0.5);
    return;
  }
  if (type === 'glow') {
    blob(c, x, y, ew * 1.2, eh * 1.9, '0,0,0', 0.95);
    c.save();
    c.globalCompositeOperation = 'lighter';
    const col = o.glow || '255,60,40';
    blob(c, x + lx, y, ew * 0.9, ew * 0.9, col, 0.55);
    blob(c, x + lx, y, ew * 0.25, ew * 0.25, col, 1);
    blob(c, x + lx, y, ew * 0.1, ew * 0.1, '255,255,255', 0.9);
    c.restore();
    return;
  }
  c.save();
  c.clip(P);
  if (type === 'black') {
    const g = c.createRadialGradient(x, y, 0, x, y, ew);
    g.addColorStop(0, '#0b0b0b'); g.addColorStop(1, '#000');
    c.fillStyle = g; c.fillRect(x - ew, y - eh * 2, ew * 2, eh * 4);
  } else if (type === 'milky') {
    const g = c.createRadialGradient(x, y, 0, x, y, ew);
    g.addColorStop(0, 'rgb(214,220,214)'); g.addColorStop(0.7, 'rgb(170,176,170)'); g.addColorStop(1, 'rgb(140,90,90)');
    c.fillStyle = g; c.fillRect(x - ew, y - eh * 2, ew * 2, eh * 4);
    blob(c, x + lx, y + ly, eh * 1.1, eh * 1.1, '130,140,145', 0.5);
    blob(c, x + lx, y + ly, eh * 0.28, eh * 0.28, '30,30,30', 0.6);
  } else {
    const g = c.createRadialGradient(x, y, 0, x, y, ew);
    g.addColorStop(0, 'rgb(226,216,198)'); g.addColorStop(0.75, 'rgb(205,180,165)'); g.addColorStop(1, 'rgb(150,90,85)');
    c.fillStyle = g; c.fillRect(x - ew, y - eh * 2, ew * 2, eh * 4);
    // bloodshot veins
    c.strokeStyle = `rgba(150,20,20,${0.5 * (o.bloodshot ?? 0.4)})`;
    c.lineWidth = 0.006;
    for (let i = 0; i < 9; i++) {
      const a = hash1(i + 3) * TAU, sx2 = x + Math.cos(a) * ew, sy2 = y + Math.sin(a) * eh * 1.5;
      c.beginPath(); c.moveTo(sx2, sy2);
      c.quadraticCurveTo((sx2 + x) / 2 + (hash1(i) - 0.5) * 0.04, (sy2 + y) / 2, x + lx + Math.cos(a) * eh * 0.9, y + ly + Math.sin(a) * eh * 0.9);
      c.stroke();
    }
    const ir = eh * 1.05;
    const ig = c.createRadialGradient(x + lx, y + ly, 0, x + lx, y + ly, ir);
    ig.addColorStop(0, '#000'); ig.addColorStop(0.42, '#050403'); ig.addColorStop(0.5, 'rgb(70,62,50)'); ig.addColorStop(0.92, 'rgb(40,34,28)'); ig.addColorStop(1, 'rgba(20,16,14,0.9)');
    c.fillStyle = ig;
    ellipse(c, x + lx, y + ly, ir, ir);
    c.fill();
  }
  // upper lid shadow
  const lg = c.createLinearGradient(0, y - eh * 1.6, 0, y);
  lg.addColorStop(0, 'rgba(0,0,0,0.6)'); lg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = lg; c.fillRect(x - ew, y - eh * 2, ew * 2, eh * 2);
  c.restore();
  // wet glint
  blob(c, x + lx - ew * 0.22, y - eh * 0.45, ew * 0.09, ew * 0.07, '255,255,255', 0.85);
  c.strokeStyle = 'rgba(20,10,10,0.55)';
  c.lineWidth = 0.02;
  c.stroke(P);
}

function teethRow(c, xL, xR, edgeY, dir, n, len, seed, missing = 0.12) {
  const tw = (xR - xL) / n;
  for (let i = 0; i < n; i++) {
    if (hash1(i * 13 + seed) < missing) continue;
    const xa = xL + i * tw + tw * 0.06, xb = xa + tw * (0.8 + hash1(i + seed) * 0.15);
    const xm = (xa + xb) / 2;
    const y0 = edgeY(xm) - dir * 0.03;
    const L = len * (0.6 + hash1(i * 5 + seed) * 0.6) * (1 - Math.abs(xm / (xR - xL + 1e-3)) * 0.5);
    const y1 = y0 + dir * L;
    const g = c.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, 'rgb(90,45,40)'); g.addColorStop(0.25, 'rgb(196,184,146)'); g.addColorStop(1, 'rgb(150,132,96)');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(xa, y0); c.lineTo(xb, y0);
    c.lineTo(xb - tw * 0.08, y1 - dir * L * 0.15);
    c.quadraticCurveTo(xm, y1 + dir * L * 0.05, xa + tw * 0.08, y1 - dir * L * 0.15);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(40,25,20,0.5)'; c.lineWidth = 0.006; c.stroke();
  }
}

// o: skin [r,g,b], gaunt 0..1, bloat, eyes, eyeSize, eyeOpen, bloodshot, glow,
//    mouth 0..1, grin, jawDrop, veins, tex, alpha, wrinkles, noNose
export function face(c, o) {
  const g = o.gaunt ?? 0.4, open = clamp(o.mouth ?? 0, 0, 1), sk = o.skin;
  const jaw = open * 0.55 * (o.jawDrop ?? 1);
  const jw = 1 - g * 0.22 + (o.bloat || 0) * 0.28;
  const head = new Path2D();
  head.moveTo(0, -1);
  head.bezierCurveTo(0.56, -1, 0.8, -0.62, 0.76, -0.18);
  head.bezierCurveTo(0.74, 0.2, 0.66 * jw, 0.5 + jaw * 0.5, 0.36 * jw, 0.86 + jaw);
  head.quadraticCurveTo(0.18, 1.02 + jaw, 0, 1.03 + jaw);
  head.quadraticCurveTo(-0.18, 1.02 + jaw, -0.36 * jw, 0.86 + jaw);
  head.bezierCurveTo(-0.66 * jw, 0.5 + jaw * 0.5, -0.74, 0.2, -0.76, -0.18);
  head.bezierCurveTo(-0.8, -0.62, -0.56, -1, 0, -1);
  c.save();
  c.globalAlpha *= o.alpha ?? 1;
  const base = c.createRadialGradient(-0.15, -0.42, 0.05, 0, 0.05, 1.45);
  base.addColorStop(0, rgb(sk, 1.15)); base.addColorStop(0.5, rgb(sk, 0.92)); base.addColorStop(1, rgb(sk, 0.42));
  c.fillStyle = base;
  c.fill(head);
  c.save();
  c.clip(head);
  const side = c.createLinearGradient(-0.8, 0, 0.8, 0);
  side.addColorStop(0, 'rgba(0,0,0,0.6)'); side.addColorStop(0.3, 'rgba(0,0,0,0)'); side.addColorStop(0.72, 'rgba(0,0,0,0)'); side.addColorStop(1, 'rgba(0,0,0,0.65)');
  c.fillStyle = side; c.fillRect(-1, -1.2, 2, 2.8);
  const chin = c.createLinearGradient(0, 0.55 + jaw, 0, 1.05 + jaw);
  chin.addColorStop(0, 'rgba(0,0,0,0)'); chin.addColorStop(1, 'rgba(0,0,0,0.55)');
  c.fillStyle = chin; c.fillRect(-1, 0.4, 2, 1.4 + jaw);
  for (const sx of [-1, 1]) {
    blob(c, sx * 0.5, 0.3 + jaw * 0.35, 0.3, 0.4 + jaw * 0.3, '0,0,0', 0.22 + g * 0.45); // hollow cheeks
    blob(c, sx * 0.64, -0.34, 0.24, 0.32, '0,0,0', g * 0.5); // temples
    blob(c, sx * 0.32, -0.38, 0.24, 0.09, '255,255,255', 0.1); // brow
    blob(c, sx * 0.55, 0.05, 0.12, 0.08, '255,255,255', 0.07 * (1 - g)); // cheekbone
    blob(c, sx * 0.3, -0.1, 0.31, 0.24, '0,0,0', 0.6 + g * 0.35); // sockets
    blob(c, sx * 0.31, 0.06, 0.2, 0.07, '40,10,30', 0.25 + g * 0.2); // bags under eyes
  }
  if (o.wrinkles) {
    c.strokeStyle = `rgba(0,0,0,${0.18 * o.wrinkles})`;
    c.lineWidth = 0.012;
    for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(-0.4, -0.62 + i * 0.07); c.quadraticCurveTo(0, -0.66 + i * 0.07, 0.4, -0.62 + i * 0.07); c.stroke(); }
  }
  // nose
  if (!o.noNose) {
    blob(c, 0.1, 0.18, 0.08, 0.2, '0,0,0', 0.3);
    blob(c, -0.03, 0.16, 0.04, 0.16, '255,255,255', 0.1);
    blob(c, -0.075, 0.33, 0.04, 0.025, '0,0,0', 0.75);
    blob(c, 0.075, 0.33, 0.04, 0.025, '0,0,0', 0.75);
  } else {
    blob(c, 0, 0.25, 0.06, 0.08, '0,0,0', 0.25);
  }
  texture(c, 'skin', 'multiply', o.tex ?? 0.85, 0.009, 0.3, 0.2);
  texture(c, 'grime', 'source-atop', (o.tex ?? 0.85) * 0.35, 0.007);
  if (o.veins) {
    c.strokeStyle = `rgba(55,25,70,${0.28 * o.veins})`;
    c.lineWidth = 0.01;
    for (let v = 0; v < 7; v++) {
      let vx = (hash1(v * 3) < 0.5 ? -1 : 1) * (0.35 + hash1(v) * 0.35), vy = -0.5 + hash1(v * 7) * 1.1;
      c.beginPath(); c.moveTo(vx, vy);
      for (let k = 0; k < 6; k++) { vx += (hash1(v * 31 + k) - 0.5) * 0.12; vy += (hash1(v * 17 + k) - 0.4) * 0.1; c.lineTo(vx, vy); }
      c.stroke();
    }
  }
  if (o.wet) for (let i = 0; i < 6; i++) blob(c, (hash1(i * 9) - 0.5) * 1.1, (hash1(i * 4) - 0.6) * 1.2, 0.04, 0.025, '255,255,255', 0.35 * o.wet);

  // mouth
  const my = 0.52 + jaw * 0.5 + (o.grin ? 0 : open * 0.08);
  if (open > 0.03 || o.grin) {
    const mrx = o.grin ? 0.64 : 0.16 + open * 0.08;
    const mry = o.grin ? 0.12 + open * 0.3 : 0.04 + open * 0.44 + jaw * 0.3;
    const M = new Path2D();
    let upper, lower;
    if (o.grin) {
      const y0 = my - 0.14;
      M.moveTo(-mrx, y0);
      M.quadraticCurveTo(0, my + 0.04, mrx, y0);
      M.quadraticCurveTo(0, my + mry * 2.2, -mrx, y0);
      upper = (x) => { const u = (x / mrx + 1) / 2; return y0 + 2 * u * (1 - u) * (my + 0.04 - y0); };
      lower = (x) => { const u = (x / mrx + 1) / 2; return y0 + 2 * u * (1 - u) * (my + mry * 2.2 - y0); };
    } else {
      M.ellipse(0, my, mrx, mry, 0, 0, TAU);
      upper = (x) => my - mry * Math.sqrt(Math.max(0, 1 - (x / mrx) ** 2));
      lower = (x) => my + mry * Math.sqrt(Math.max(0, 1 - (x / mrx) ** 2));
    }
    const mg = c.createRadialGradient(0, my + mry * 0.3, 0, 0, my, Math.max(mrx, mry) * 1.1);
    mg.addColorStop(0, '#000'); mg.addColorStop(0.65, 'rgb(10,2,3)'); mg.addColorStop(1, 'rgb(80,22,24)');
    c.fillStyle = mg;
    c.fill(M);
    c.save();
    c.clip(M);
    const tn = o.grin ? 20 : 7;
    teethRow(c, -mrx * 0.95, mrx * 0.95, upper, 1, tn, o.grin ? 0.13 : 0.13, 3, o.grin ? 0.04 : 0.08);
    if (o.grin || open > 0.3) teethRow(c, -mrx * 0.85, mrx * 0.85, lower, -1, tn - 2, o.grin ? 0.12 : 0.07, 9, 0.25);
    c.restore();
    c.strokeStyle = rgb(sk, 0.35, 0.8);
    c.lineWidth = 0.035;
    c.stroke(M);
    if (o.grin) {
      // the cheeks have torn to make room
      c.strokeStyle = 'rgba(70,10,12,0.75)';
      c.lineWidth = 0.018;
      for (const sx of [-1, 1]) {
        c.beginPath(); c.moveTo(sx * mrx, my - 0.14);
        c.quadraticCurveTo(sx * (mrx + 0.05), my - 0.24, sx * (mrx + 0.03), my - 0.36);
        c.stroke();
      }
    }
  } else {
    c.strokeStyle = 'rgba(30,12,12,0.85)';
    c.lineWidth = 0.03;
    c.beginPath(); c.moveTo(-0.2, my + 0.01); c.quadraticCurveTo(0, my - 0.02, 0.2, my + 0.02); c.stroke();
    blob(c, 0, my + 0.07, 0.14, 0.04, '255,255,255', 0.08);
    c.strokeStyle = 'rgba(30,12,12,0.35)'; c.lineWidth = 0.008;
    for (let i = 0; i < 5; i++) { const x = -0.12 + i * 0.06; c.beginPath(); c.moveTo(x, my - 0.01); c.lineTo(x + 0.01, my + 0.05); c.stroke(); }
  }
  c.restore();
  // eyes go over the clipped shading
  if (o.eyes !== 'none') for (const sx of [-1, 1]) eye(c, sx * 0.3 + (o.asym ? sx * 0.02 : 0), -0.1 + (o.asym && sx > 0 ? 0.03 : 0), o);
  c.restore();
}

// ---------------------------------------------------------------------------
// The dead.
export const DRAW = {
  lantern(c, p) {
    const { t, agit } = p;
    const bob = Math.sin(t * 1.3) * 0.03;
    c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++) {
      let px = 0, py = bob - 0.06;
      for (let j = 1; j <= 14; j++) {
        const y = bob - 0.06 + j * 0.032;
        const x = Math.sin(t * 1.7 + k * 1.7 + j * 0.55) * 0.011 * j + (k - 2.5) * 0.005 * j;
        c.strokeStyle = `rgba(160,215,240,${0.22 * (1 - j / 15)})`;
        c.lineWidth = 0.028 * (1 - j / 16);
        c.beginPath(); c.moveTo(px, py); c.lineTo(x, y); c.stroke();
        px = x; py = y;
      }
    }
    const fl = 0.85 + noise1(t * 6) * 0.3;
    const g = c.createRadialGradient(0, bob - 0.12, 0, 0, bob - 0.12, 0.36 * fl);
    g.addColorStop(0, 'rgba(225,245,255,0.9)');
    g.addColorStop(0.14, 'rgba(165,220,245,0.55)');
    g.addColorStop(0.42, 'rgba(70,140,200,0.14)');
    g.addColorStop(1, 'rgba(30,70,130,0)');
    c.fillStyle = g;
    c.fillRect(-0.5, -0.5, 1, 1);
    c.globalCompositeOperation = 'source-over';
    // a drowned little face, deep inside the light
    c.save();
    c.translate(0, bob - 0.12);
    c.scale(0.07, 0.07);
    face(c, { skin: [190, 215, 228], gaunt: 0.7, eyes: 'hollow', eyeSize: 1.1, mouth: 0.25 + agit * 0.6, alpha: 0.18 + agit * 0.45 + Math.max(0, Math.sin(t * 0.6)) * 0.22, tex: 0.4, noNose: true });
    c.restore();
  },

  wren(c, p) {
    const { t, agit } = p;
    const sk = [178, 188, 194];
    blob(c, 0, 0.48, 0.17, 0.03, '0,0,0', 0.6);
    c.translate(0, Math.sin(t * 1.1) * 0.006);
    limb(c, [[-0.035, 0.27], [-0.04, 0.46]], 0.024, 0.018, sk);
    limb(c, [[0.035, 0.27], [0.03, 0.465]], 0.024, 0.018, sk);
    c.fillStyle = rgb(sk, 0.4);
    ellipse(c, -0.044, 0.47, 0.022, 0.008); c.fill();
    ellipse(c, 0.034, 0.473, 0.022, 0.008); c.fill();
    // nightgown, filthy from the cellar floor
    const sway = Math.sin(t * 0.8) * 0.01;
    const G = new Path2D();
    G.moveTo(-0.08, -0.25);
    G.quadraticCurveTo(-0.13, 0.05, -0.19 + sway, 0.31);
    for (let i = 0; i <= 18; i++) G.lineTo(-0.19 + (0.38 * i) / 18 + sway, 0.31 + (i % 3 === 1 ? 0.04 : 0) + hash1(i) * 0.025);
    G.quadraticCurveTo(0.13, 0.05, 0.08, -0.25);
    G.closePath();
    const gg = c.createLinearGradient(0, -0.25, 0, 0.34);
    gg.addColorStop(0, 'rgb(196,192,180)'); gg.addColorStop(0.6, 'rgb(150,144,128)'); gg.addColorStop(1, 'rgb(92,82,66)');
    c.fillStyle = gg;
    c.fill(G);
    c.save();
    c.clip(G);
    for (const x of [-0.12, -0.06, 0, 0.05, 0.11]) blob(c, x + sway, 0.08, 0.02, 0.3, '0,0,0', 0.25);
    blob(c, 0.05, 0.12, 0.06, 0.08, '80,40,25', 0.35);
    blob(c, -0.07, 0.24, 0.08, 0.06, '50,40,25', 0.45);
    texture(c, 'grime', 'source-atop', 0.9, 0.0016, t * 0.0);
    c.restore();
    // arms, a little too long
    const hy = 0.12 + agit * 0.03;
    limb(c, [[-0.075, -0.23], [-0.105, -0.05], [-0.115, hy]], 0.022, 0.017, sk);
    limb(c, [[0.075, -0.23], [0.1, -0.05], [0.11, hy]], 0.022, 0.017, sk);
    hand(c, -0.115, hy, Math.PI / 2 + 0.08, 0.055, { skin: sk, w: 0.0065, curl: 0.25 });
    hand(c, 0.11, hy, Math.PI / 2 - 0.08, 0.055, { skin: sk, w: 0.0065, curl: 0.25 });
    // her neck is stretched; her head sits at the wrong angle
    const jerk = (agit > 0.5 || p.scare) && noise1(t * 7) > 0.7 ? 0.45 : 0;
    const tilt = p.scare ? 0.1 : 0.32 + Math.sin(t * 0.45) * 0.05 + jerk + agit * 0.2;
    limb(c, [[0, -0.255], [Math.sin(tilt) * 0.02, -0.3]], 0.026, 0.024, sk);
    c.save();
    c.translate(Math.sin(tilt) * 0.03, -0.335);
    c.rotate(tilt);
    c.scale(0.072, 0.072);
    const fierce = agit > 0.55 || p.scare;
    face(c, { skin: sk, gaunt: 0.35, eyes: fierce ? 'black' : 'human', bloodshot: 0.8, eyeSize: fierce ? 1.15 : 1, mouth: p.scare ? 1 : fierce ? (agit - 0.5) * 1.8 : 0, jawDrop: 1.3, veins: 0.5, tex: 0.9 });
    const part = p.scare ? 0.75 : agit > 0.3 ? 0.2 + agit * 0.4 : 0;
    hairCurtain(c, { x0: -0.95, x1: 0.95, top: -1.05, bottom: 3.3, n: 90, w: 0.045, t, seed: 3, sway: sway * 30, gap: part ? [-part, part] : [0.14, 0.5], flare: 1.25 });
    c.restore();
  },

  weeper(c, p) {
    const { t, agit } = p;
    const lift = p.scare ? 1 : sstep(0.4, 0.92, agit);
    const sob = (Math.sin(t * 18) * 0.5 + 0.5) * Math.max(0, Math.sin(t * 1.7)) * (1 - lift);
    const sk = [168, 168, 166];
    c.translate(Math.sin(t * 23) * 0.003 * (1 + agit * 3), sob * 0.008);
    blob(c, 0, 0.47, 0.36, 0.05, '0,0,0', 0.75);
    limb(c, [[-0.07, -0.02], [-0.09, 0.2], [-0.11, 0.45]], 0.05, 0.035, sk);
    limb(c, [[0.07, -0.02], [0.09, 0.2], [0.11, 0.45]], 0.05, 0.035, sk);
    // grave dress
    const D = new Path2D();
    D.moveTo(-0.2, -0.06);
    D.quadraticCurveTo(-0.08, -0.22 - lift * 0.05, 0, -0.2 - lift * 0.05);
    D.quadraticCurveTo(0.08, -0.22 - lift * 0.05, 0.2, -0.06);
    D.quadraticCurveTo(0.3, 0.2, 0.29, 0.46);
    for (let i = 0; i <= 22; i++) D.lineTo(0.29 - (0.58 * i) / 22, 0.46 + (i % 2 ? 0.025 : -0.01) + hash1(i) * 0.02);
    D.quadraticCurveTo(-0.3, 0.2, -0.2, -0.06);
    D.closePath();
    const dg = c.createLinearGradient(0, -0.2, 0, 0.47);
    dg.addColorStop(0, 'rgb(118,114,108)'); dg.addColorStop(1, 'rgb(40,38,36)');
    c.fillStyle = dg;
    c.fill(D);
    c.save();
    c.clip(D);
    for (const x of [-0.2, -0.1, 0.02, 0.13, 0.22]) blob(c, x, 0.25, 0.025, 0.3, '0,0,0', 0.35);
    texture(c, 'grime', 'source-atop', 1, 0.0018);
    c.restore();
    const hy = -0.13 - lift * 0.18;
    // the face she hides
    c.save();
    c.translate(0, hy);
    c.scale(0.078, 0.078);
    face(c, { skin: sk, gaunt: 0.95, eyes: 'glow', glow: '255,40,25', eyeSize: 1.1, mouth: lift > 0.2 ? lift : 0, jawDrop: 1.7, veins: 1, tex: 1, alpha: lift > 0.15 ? 1 : 0.9, wrinkles: 1 });
    const gapW = lift * 0.75;
    hairCurtain(c, { x0: -2.6, x1: 2.6, top: -1.05, bottom: (0.42 - hy) / 0.078 - lift * 1.5, n: 150, w: 0.05, t, seed: 7, sway: Math.sin(t * 0.7) * 0.15, gap: lift > 0.15 ? [-gapW, gapW] : null, crown: 0.3, arch: 0.15, flare: 1.05 });
    c.restore();
    // arms wrapped around her head; the claws come down when she rises
    const hl = [-0.04 - lift * 0.12, hy + 0.02 + lift * 0.22], hr = [0.04 + lift * 0.12, hy + 0.02 + lift * 0.22];
    limb(c, [[-0.18, -0.05], [-0.24, 0.06 - lift * 0.05], hl], 0.03, 0.022, sk);
    limb(c, [[0.18, -0.05], [0.24, 0.06 - lift * 0.05], hr], 0.03, 0.022, sk);
    const down = lift > 0.5;
    hand(c, hl[0], hl[1], down ? Math.PI / 2 + 0.3 : -Math.PI / 2 + 0.5, 0.085, { skin: sk, w: 0.008, curl: down ? 0.35 : 0.15, long: 1.2 });
    hand(c, hr[0], hr[1], down ? Math.PI / 2 - 0.3 : -Math.PI / 2 - 0.5, 0.085, { skin: sk, w: 0.008, curl: down ? -0.35 : -0.15, long: 1.2 });
  },

  hollow(c, p) {
    const { t, agit } = p;
    c.rotate(Math.sin(t * 0.3) * 0.012);
    for (let i = 0; i < 22; i++) {
      const age = (t * 0.06 + i / 22) % 1;
      const x = Math.sin(i * 12.9) * 0.08 + (noise1(i + t * 0.3) - 0.5) * 0.06;
      blob(c, x, 0.45 - age * 0.95, 0.03 + age * 0.06, 0.03 + age * 0.06, '6,5,10', 0.4 * (1 - age));
    }
    const col = [10, 9, 13];
    c.fillStyle = rgb(col);
    const ht = Math.sin(t * 0.4) * 0.12 + agit * 0.3;
    c.beginPath();
    c.moveTo(-0.075, -0.36); c.lineTo(0.075, -0.36);
    c.quadraticCurveTo(0.06, -0.15, 0.04, 0.03); c.lineTo(-0.04, 0.03);
    c.quadraticCurveTo(-0.06, -0.15, -0.075, -0.36);
    c.fill();
    const sw = Math.sin(t * 0.5) * 0.01;
    limb(c, [[-0.07, -0.35], [-0.095, -0.05], [-0.1 + sw, 0.25]], 0.022, 0.016, col);
    limb(c, [[0.07, -0.35], [0.095, -0.05], [0.1 + sw, 0.25]], 0.022, 0.016, col);
    hand(c, -0.1 + sw, 0.25, Math.PI / 2 + 0.06, 0.12, { skin: [22, 20, 26], w: 0.0065, curl: 0.12, long: 1.3 });
    hand(c, 0.1 + sw, 0.25, Math.PI / 2 - 0.06, 0.12, { skin: [22, 20, 26], w: 0.0065, curl: -0.12, long: 1.3 });
    limb(c, [[-0.025, 0.02], [-0.032, 0.26], [-0.04, 0.5]], 0.028, 0.022, col);
    limb(c, [[0.025, 0.02], [0.032, 0.26], [0.04, 0.5]], 0.028, 0.022, col);
    limb(c, [[0, -0.36], [0, -0.41]], 0.016, 0.016, col);
    c.save();
    c.translate(0, -0.445);
    c.rotate(ht);
    c.scale(0.042, 0.06);
    // a pale, stretched face floats up out of the black when he's angry
    const fa = p.scare ? 1 : 0.12 + agit * 0.8;
    c.fillStyle = rgb(col);
    ellipse(c, 0, 0, 0.8, 1.05); c.fill();
    face(c, { skin: [150, 146, 158], gaunt: 1, eyes: 'black', eyeSize: 1.2, grin: agit > 0.25 || p.scare, mouth: 0.1 + agit * 0.3, tex: 1, veins: 0.6, alpha: fa, noNose: true });
    c.restore();
    c.save();
    c.translate(0, -0.445);
    c.rotate(ht);
    c.globalCompositeOperation = 'lighter';
    for (const sx of [-1, 1]) {
      blob(c, sx * 0.0126, -0.006, 0.01, 0.01, '200,200,255', 0.35 * (1 - fa * 0.6));
      blob(c, sx * 0.0126, -0.006, 0.0035, 0.0035, '255,255,255', 1 - fa * 0.5);
    }
    c.restore();
  },

  whisperer(c, p) {
    const { t, agit } = p;
    const wave = (y) => Math.sin(t * 1.5 + y * 9) * 0.012 * (y + 0.5);
    const S = new Path2D();
    S.moveTo(0, -0.44);
    S.bezierCurveTo(0.09, -0.44, 0.1, -0.3, 0.12 + wave(-0.25), -0.25);
    S.bezierCurveTo(0.2, -0.2, 0.22 + wave(0.1), 0.1, 0.25 + wave(0.45), 0.45);
    for (let i = 0; i <= 14; i++) S.lineTo(0.25 - (0.5 * i) / 14 + wave(0.45), 0.45 + Math.sin(i * 1.7 + t * 2) * 0.02);
    S.bezierCurveTo(-0.22 + wave(0.1), 0.1, -0.2, -0.2, -0.12 + wave(-0.25), -0.25);
    S.bezierCurveTo(-0.1, -0.3, -0.09, -0.44, 0, -0.44);
    const sg = c.createLinearGradient(0, -0.45, 0, 0.45);
    sg.addColorStop(0, 'rgba(178,190,180,0.85)'); sg.addColorStop(0.6, 'rgba(120,132,124,0.6)'); sg.addColorStop(1, 'rgba(90,100,95,0)');
    c.fillStyle = sg;
    c.fill(S);
    // a face and hands pressing out through the cloth from inside
    c.save();
    c.clip(S);
    c.save();
    c.translate(0, -0.33);
    c.scale(0.072, 0.075);
    const mo = p.scare ? 1 : p.speaking ? 0.2 + Math.abs(Math.sin(t * 9)) * 0.4 : 0.15 + agit * 0.4;
    face(c, { skin: [200, 210, 202], gaunt: 0.8, eyes: p.scare ? 'black' : 'hollow', mouth: mo, jawDrop: 1.4, tex: 0.3, alpha: 0.95, noNose: true });
    c.restore();
    for (const sx of [-1, 1]) hand(c, sx * 0.12, -0.08 + Math.sin(t * 0.9 + sx) * 0.01, -Math.PI / 2 + sx * 0.25, 0.08, { skin: [205, 215, 207], w: 0.009, curl: sx * 0.08, a: 0.55 });
    // the fabric over the top of them
    c.fillStyle = 'rgba(170,182,172,0.3)';
    c.fill(S);
    c.strokeStyle = 'rgba(40,52,46,0.35)';
    c.lineWidth = 0.007;
    for (const x of [-0.14, -0.08, -0.02, 0.04, 0.1, 0.15]) {
      c.beginPath(); c.moveTo(x * 0.4, -0.42); c.bezierCurveTo(x * 0.7, -0.3, x + wave(0), 0.05, x * 1.6 + wave(0.4), 0.44); c.stroke();
    }
    texture(c, 'grime', 'source-atop', 0.4, 0.0016);
    c.restore();
  },

  drowned(c, p) {
    const { t, agit } = p;
    const sk = [126, 150, 144];
    c.translate(0, Math.sin(t * 0.9) * 0.006);
    const T = new Path2D();
    T.moveTo(-0.07, -0.19); T.quadraticCurveTo(-0.24, -0.15, -0.26, 0.1); T.lineTo(-0.23, 0.5); T.lineTo(0.23, 0.5); T.lineTo(0.26, 0.1);
    T.quadraticCurveTo(0.24, -0.15, 0.07, -0.19); T.closePath();
    const cg = c.createLinearGradient(0, -0.2, 0, 0.5);
    cg.addColorStop(0, 'rgb(30,40,38)'); cg.addColorStop(1, 'rgb(10,14,13)');
    c.fillStyle = cg;
    c.fill(T);
    c.save(); c.clip(T); texture(c, 'grime', 'source-atop', 0.8, 0.002); c.restore();
    const reach = p.scare ? 1 : 0.4 + agit * 0.6;
    const hl = [-0.3, -0.05 - reach * 0.12], hr = [0.3, -0.04 - reach * 0.1];
    limb(c, [[-0.21, -0.12], [-0.3, 0.06], hl], 0.06, 0.045, sk);
    limb(c, [[0.21, -0.12], [0.31, 0.07], hr], 0.06, 0.045, sk);
    hand(c, hl[0], hl[1], -Math.PI / 2 - 0.35, 0.09, { skin: sk, w: 0.016, curl: -0.2 });
    hand(c, hr[0], hr[1], -Math.PI / 2 + 0.35, 0.09, { skin: sk, w: 0.016, curl: 0.2 });
    limb(c, [[0, -0.19], [0, -0.22]], 0.08, 0.08, sk);
    c.save();
    c.translate(0, -0.3);
    c.scale(0.1, 0.11);
    const mo = p.scare ? 1 : 0.5 + agit * 0.4 + (p.speaking ? Math.abs(Math.sin(t * 7)) * 0.1 : 0);
    face(c, { skin: sk, gaunt: 0, bloat: 0.6, eyes: 'milky', eyeSize: 1.25, mouth: mo, veins: 1.2, tex: 1, wet: 1, lookX: 0 });
    // black water spilling out of him
    const my = 0.52 + mo * 0.3;
    c.strokeStyle = 'rgba(14,22,18,0.85)';
    c.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      c.lineWidth = 0.05 + hash1(i) * 0.05;
      c.beginPath(); c.moveTo((i - 2) * 0.06, my);
      for (let y = 0; y < 10; y++) c.lineTo((i - 2) * 0.07 + Math.sin(t * 5 + y + i) * 0.03, my + y * 0.22);
      c.stroke();
    }
    hairCurtain(c, { x0: -1, x1: 1, top: -1.02, bottom: 0.4, n: 50, w: 0.06, t: t * 0.2, seed: 11, gap: [-0.55, 0.55], col: '12,22,16', crown: 0.6, wobble: 0.05 });
    hairCurtain(c, { x0: -1.05, x1: -0.7, top: -0.95, bottom: 1.6, n: 14, w: 0.07, t: t * 0.2, seed: 13, col: '12,22,16', wobble: 0.05 });
    hairCurtain(c, { x0: 0.7, x1: 1.05, top: -0.95, bottom: 1.6, n: 14, w: 0.07, t: t * 0.2, seed: 17, col: '12,22,16', wobble: 0.05 });
    c.restore();
    for (let i = 0; i < 12; i++) {
      const age = (t * 0.7 + i / 12) % 1;
      const x = [-0.3, 0.3, -0.05, 0.05, 0, -0.08, 0.08, -0.2, 0.2, 0, -0.1, 0.1][i];
      const y0 = [-0.05, -0.04, -0.2, -0.2, -0.18, -0.12, -0.12, 0.02, 0.02, -0.18, -0.25, -0.25][i];
      blob(c, x, y0 + age * 0.5, 0.005, 0.01, '170,200,200', 0.7 * (1 - age));
    }
  },

  crawler(c, p) {
    const { t, agit } = p;
    const mv = p.moving ? 1 : 0;
    const tw = !p.moving && noise1(t * 3 + 9) > 0.8 ? (noise1(t * 40) - 0.5) * 0.05 : 0;
    const g = (i) => mv * Math.sin(t * 16 + i * 1.6) * 0.03;
    const sk = [150, 147, 138], dk = [104, 101, 95];
    blob(c, 0, 0.45, 0.5, 0.06, '0,0,0', 0.8);
    limb(c, [[-0.08, -0.05], [-0.3, -0.27 + g(2)], [-0.22, 0.38]], 0.042, 0.026, dk);
    limb(c, [[0.08, -0.05], [0.3, -0.27 + g(3)], [0.22, 0.38]], 0.042, 0.026, dk);
    hand(c, -0.22, 0.38, Math.PI / 2 + 0.6, 0.06, { skin: dk, w: 0.012, curl: 0.3 });
    hand(c, 0.22, 0.38, Math.PI / 2 - 0.6, 0.06, { skin: dk, w: 0.012, curl: -0.3 });
    // emaciated torso, arched backwards, every rib showing
    const B = new Path2D();
    B.moveTo(-0.1, -0.06); B.bezierCurveTo(-0.06, -0.15, 0.06, -0.15, 0.1, -0.06);
    B.bezierCurveTo(0.16, 0.02, 0.17, 0.1, 0.13, 0.14); B.quadraticCurveTo(0, 0.2, -0.13, 0.14);
    B.bezierCurveTo(-0.17, 0.1, -0.16, 0.02, -0.1, -0.06); B.closePath();
    const tg = c.createLinearGradient(0, -0.13, 0, 0.17);
    tg.addColorStop(0, rgb(sk, 1.05)); tg.addColorStop(1, rgb(sk, 0.6));
    c.fillStyle = tg;
    c.fill(B);
    c.save();
    c.clip(B);
    for (let i = 0; i < 7; i++) {
      const y = -0.08 + i * 0.03, ww = 0.08 + Math.sin((i / 6) * Math.PI) * 0.04;
      c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = 0.014;
      c.beginPath(); c.moveTo(-ww, y + 0.014); c.quadraticCurveTo(0, y - 0.024, ww, y + 0.014); c.stroke();
      c.strokeStyle = rgb(sk, 1.2, 0.3); c.lineWidth = 0.005;
      c.beginPath(); c.moveTo(-ww, y + 0.006); c.quadraticCurveTo(0, y - 0.032, ww, y + 0.006); c.stroke();
    }
    blob(c, 0, 0.02, 0.012, 0.16, '0,0,0', 0.4);
    texture(c, 'skin', 'multiply', 0.8, 0.0018);
    texture(c, 'grime', 'source-atop', 0.6, 0.0016);
    c.restore();
    
    const hL = [-0.34 + g(0) * 0.5, 0.44], hR = [0.34 - g(1) * 0.5, 0.44];
    limb(c, [[-0.13, 0.11], [-0.4 + tw, -0.02 + g(0)], hL], 0.04, 0.022, sk);
    limb(c, [[0.13, 0.11], [0.4 - tw, -0.02 + g(1)], hR], 0.04, 0.022, sk);
    hand(c, hL[0], hL[1], Math.PI - 0.25, 0.1, { skin: sk, w: 0.012, curl: -0.12, spread: 0.2, long: 1.2 });
    hand(c, hR[0], hR[1], 0.25, 0.1, { skin: sk, w: 0.012, curl: 0.12, spread: 0.2, long: 1.2 });
    // its head hangs upside down between its arms, and it is smiling at you
    c.save();
    c.translate(tw * 2, 0.27);
    c.rotate(Math.PI + Math.sin(t * 0.9) * 0.12 + tw * 6);
    c.scale(0.085, 0.09);
    hairCurtain(c, { x0: -0.9, x1: 0.9, top: -0.9, bottom: -2.4, n: 70, w: 0.05, t, seed: 21, crown: 0.6, arch: -0.2 });
    face(c, { skin: sk, gaunt: 0.85, eyes: 'human', bloodshot: 1, eyeSize: 1.4, eyeOpen: 1.35, grin: true, mouth: p.scare ? 0.9 : 0.3 + agit * 0.45, veins: 0.9, tex: 1, lookY: -1 });
    c.restore();
  },

  mimic(c, p) {
    const { t, agit } = p;
    const def = p.scare ? 1 : 0.35 + agit * 0.65;
    const sk = [150, 138, 126];
    for (let k = 3; k >= 0; k--) {
      const ox = k * 0.03 * Math.sin(t * 1.7 + k), a = (k === 0 ? 0.9 : 0.18) * def;
      const B = new Path2D();
      B.moveTo(ox - 0.06, -0.3); B.quadraticCurveTo(ox - 0.17, -0.27, ox - 0.18, -0.15);
      B.lineTo(ox - 0.14, 0.15); B.quadraticCurveTo(ox - 0.1, 0.4, ox - 0.05, 0.5); B.lineTo(ox + 0.05, 0.5);
      B.quadraticCurveTo(ox + 0.1, 0.4, ox + 0.14, 0.15); B.lineTo(ox + 0.18, -0.15);
      B.quadraticCurveTo(ox + 0.17, -0.27, ox + 0.06, -0.3); B.closePath();
      const bg = c.createLinearGradient(0, -0.3, 0, 0.5);
      bg.addColorStop(0, `rgba(40,36,34,${a})`); bg.addColorStop(1, 'rgba(20,18,17,0)');
      c.fillStyle = bg;
      c.fill(B);
    }
    limb(c, [[-0.16, -0.24], [-0.2, 0.0], [-0.21, 0.26]], 0.03, 0.022, sk, def);
    limb(c, [[0.16, -0.24], [0.2, 0.0], [0.21, 0.26]], 0.03, 0.022, sk, def);
    hand(c, -0.21, 0.26, Math.PI / 2 + 0.05, 0.08, { skin: sk, w: 0.009, curl: 0.15, a: def });
    hand(c, 0.21, 0.26, Math.PI / 2 - 0.05, 0.08, { skin: sk, w: 0.009, curl: -0.15, a: def });
    // a cracked porcelain face, and a mouth that opens far too wide
    c.save();
    c.translate(0, -0.38);
    c.scale(0.07, 0.085);
    const open = p.scare ? 1 : p.speaking ? 0.35 + Math.abs(Math.sin(t * 13)) * 0.65 : 0.02;
    face(c, { skin: [226, 218, 206], gaunt: 0.1, eyes: 'hollow', eyeSize: 1.2, mouth: open, jawDrop: 2.2, tex: 0.25, noNose: true });
    c.strokeStyle = 'rgba(30,22,18,0.75)';
    c.lineWidth = 0.02;
    c.beginPath(); c.moveTo(0.1, -1); c.lineTo(0.18, -0.6); c.lineTo(0.08, -0.35); c.lineTo(0.22, -0.05); c.lineTo(0.15, 0.2); c.stroke();
    c.beginPath(); c.moveTo(-0.76, 0.1); c.lineTo(-0.45, 0.2); c.lineTo(-0.5, 0.45); c.lineTo(-0.3, 0.6); c.stroke();
    c.restore();
    if (agit > 0.5 || p.scare) {
      c.save();
      c.globalAlpha = 0.25;
      c.translate(0.03, -0.39);
      c.rotate(0.12);
      c.scale(0.07, 0.085);
      face(c, { skin: [226, 218, 206], eyes: 'black', mouth: 0.8, jawDrop: 2, tex: 0.25, noNose: true });
      c.restore();
    }
  },

  grinner(c, p) {
    const { t, agit } = p;
    const sk = [214, 204, 186];
    c.rotate(Math.sin(t * 0.35) * 0.04);
    blob(c, 0, 0.49, 0.16, 0.025, '0,0,0', 0.6);
    limb(c, [[-0.045, 0.1], [-0.05, 0.3], [-0.055, 0.49]], 0.055, 0.05, [22, 20, 22]);
    limb(c, [[0.045, 0.1], [0.05, 0.3], [0.055, 0.49]], 0.055, 0.05, [22, 20, 22]);
    const J = new Path2D();
    J.moveTo(-0.15, -0.26); J.lineTo(0.15, -0.26); J.lineTo(0.13, 0.16); J.lineTo(-0.13, 0.16); J.closePath();
    const jg = c.createLinearGradient(-0.15, 0, 0.15, 0);
    jg.addColorStop(0, 'rgb(12,11,12)'); jg.addColorStop(0.45, 'rgb(34,31,33)'); jg.addColorStop(1, 'rgb(10,9,10)');
    c.fillStyle = jg;
    c.fill(J);
    c.fillStyle = 'rgb(168,160,146)';
    c.beginPath(); c.moveTo(-0.045, -0.27); c.lineTo(0, -0.1); c.lineTo(0.045, -0.27); c.closePath(); c.fill();
    c.fillStyle = 'rgb(48,14,16)';
    c.beginPath(); c.moveTo(-0.01, -0.25); c.lineTo(0.01, -0.25); c.lineTo(0.005, -0.12); c.lineTo(0, -0.105); c.lineTo(-0.005, -0.12); c.fill();
    c.save(); c.clip(J); texture(c, 'grime', 'source-atop', 0.5, 0.0016); c.restore();
    limb(c, [[-0.14, -0.24], [-0.17, -0.06], [-0.165, 0.1]], 0.048, 0.04, [24, 22, 24]);
    limb(c, [[0.14, -0.24], [0.17, -0.06], [0.165, 0.1]], 0.048, 0.04, [24, 22, 24]);
    hand(c, -0.165, 0.11, Math.PI / 2 + 0.05, 0.085, { skin: sk, w: 0.009, curl: 0.15, long: 1.25 });
    hand(c, 0.165, 0.11, Math.PI / 2 - 0.05, 0.085, { skin: sk, w: 0.009, curl: -0.15, long: 1.25 });
    limb(c, [[0, -0.27], [0, -0.3]], 0.03, 0.03, sk);
    c.save();
    c.translate(0, -0.37);
    c.rotate(Math.sin(t * 0.5) * 0.1 + agit * 0.3);
    c.scale(0.07, 0.085);
    face(c, { skin: sk, gaunt: 0.6, eyes: 'black', eyeSize: 0.6, grin: true, mouth: p.scare ? 0.9 : 0.25 + agit * 0.35, veins: 0.3, tex: 0.9, wrinkles: 0.6 });
    // slicked-back hair with a sharp widow's peak
    const H = new Path2D();
    H.moveTo(-0.8, -0.18); H.bezierCurveTo(-0.85, -0.9, -0.4, -1.08, 0, -1.08);
    H.bezierCurveTo(0.4, -1.08, 0.85, -0.9, 0.8, -0.18);
    H.quadraticCurveTo(0.6, -0.5, 0.25, -0.55); H.lineTo(0, -0.38); H.lineTo(-0.25, -0.55);
    H.quadraticCurveTo(-0.6, -0.5, -0.8, -0.18); H.closePath();
    c.fillStyle = 'rgb(10,9,9)';
    c.fill(H);
    c.strokeStyle = 'rgba(120,120,120,0.25)'; c.lineWidth = 0.015;
    for (let i = 0; i < 9; i++) { const x = -0.6 + i * 0.15; c.beginPath(); c.moveTo(x * 0.3, -1.02); c.quadraticCurveTo(x, -0.9, x * 1.25, -0.45); c.stroke(); }
    c.restore();
  },
};

// Where each face is, for the jumpscare: [x, y, face height] in unit space.
export const FACE = {
  lantern: [0, -0.12, 0.17], wren: [0.01, -0.335, 0.17], weeper: [0, -0.31, 0.19], hollow: [0, -0.445, 0.13],
  whisperer: [0, -0.33, 0.17], drowned: [0, -0.27, 0.25], crawler: [0, 0.27, 0.2], mimic: [0, -0.35, 0.21], grinner: [0, -0.37, 0.19],
};

// How each one is lit and where its body dissolves into smoke (unit y).
const LOOK = {
  lantern: { lx: 0, ly: -0.12, lr: 0.6, dark: 0, fade: null, stutter: 0 },
  wren: { lx: 0, ly: -0.3, lr: 0.75, dark: 0.75, fade: [0.3, 0.78], stutter: 12 },
  weeper: { lx: 0, ly: -0.22, lr: 0.65, dark: 0.8, fade: [0.36, 0.8], stutter: 0 },
  hollow: { lx: 0, ly: -0.44, lr: 0.65, dark: 0.55, fade: [0.15, 0.78], stutter: 0 },
  whisperer: { lx: 0, ly: -0.33, lr: 0.75, dark: 0.55, fade: [0.0, 0.48], stutter: 0 },
  drowned: { lx: 0, ly: -0.3, lr: 0.55, dark: 0.85, fade: [0.08, 0.5], stutter: 0 },
  crawler: { lx: 0, ly: 0.22, lr: 0.75, dark: 0.7, fade: null, stutter: 9 },
  mimic: { lx: 0, ly: -0.38, lr: 0.6, dark: 0.85, fade: [-0.05, 0.52], stutter: 14 },
  grinner: { lx: 0, ly: -0.37, lr: 0.7, dark: 0.8, fade: [0.3, 0.8], stutter: 8 },
};

// ---------------------------------------------------------------------------
const buf = document.createElement('canvas');
const bctx = buf.getContext('2d');
const mask = document.createElement('canvas');
mask.width = 96; mask.height = 100;
const mctx = mask.getContext('2d');
const CAN_FILTER = 'filter' in CanvasRenderingContext2D.prototype;

// Alpha mask that eats away the lower body like smoke.
function erodeMask(fade, t) {
  const H = 100, toRow = (u) => ((u + 0.575) / 1.15) * H;
  mctx.globalCompositeOperation = 'source-over';
  mctx.clearRect(0, 0, 96, H);
  const g = mctx.createLinearGradient(0, toRow(fade[0]), 0, toRow(fade[1]));
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
  mctx.fillStyle = g;
  mctx.fillRect(0, 0, 96, H);
  mctx.globalCompositeOperation = 'destination-in';
  const sm = tex().smoke;
  const oy = (t * 9) % 128;
  for (const dy of [-128, 0]) mctx.drawImage(sm, 0, -oy - dy, 96, 128);
  mctx.globalCompositeOperation = 'source-over';
  const g2 = mctx.createLinearGradient(0, toRow(fade[0] + (fade[1] - fade[0]) * 0.6), 0, toRow(fade[1] + 0.05));
  g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)');
  mctx.fillStyle = g2;
  mctx.fillRect(0, 0, 96, H);
  return mask;
}

// Draw a ghost centred at (x, y), `size` px tall.
// opts: alpha, glitch, clip {x,y,w,h}, exclude [{x,y,w,h}] (things in front of it)
export function drawGhost(ctx, type, x, y, size, p, opts = {}) {
  const draw = DRAW[type];
  if (!draw || size < 4) return;
  const alpha = clamp(opts.alpha ?? 1, 0, 1);
  if (alpha <= 0.01) return;
  const L = LOOK[type];
  const glitch = opts.glitch || 0;
  const tt = L.stutter && !p.scare ? Math.floor(p.t * L.stutter) / L.stutter : p.t;
  const P = { ...p, t: tt, s: size };
  ctx.save();
  if (opts.clip || opts.exclude?.length) {
    ctx.beginPath();
    if (opts.clip) ctx.rect(opts.clip.x, opts.clip.y, opts.clip.w, opts.clip.h);
    else ctx.rect(-1e4, -1e4, 2e4, 2e4);
    for (const r of opts.exclude || []) ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip('evenodd');
  }
  if (size > 1400) {
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(size, size);
    draw(ctx, P);
    ctx.restore();
    return;
  }
  const bw = Math.ceil(size * 1.1), bh = Math.ceil(size * 1.15);
  if (buf.width < bw || buf.height < bh || buf.width > bw * 2) { buf.width = bw; buf.height = bh; }
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.globalCompositeOperation = 'source-over';
  bctx.globalAlpha = 1;
  bctx.clearRect(0, 0, buf.width, buf.height);
  bctx.save();
  bctx.translate(bw / 2, bh / 2);
  bctx.scale(size, size);
  draw(bctx, P);
  bctx.restore();
  // light it from the face; let everything else fall into darkness
  if (L.dark > 0) {
    bctx.globalCompositeOperation = 'source-atop';
    const cx = bw / 2 + L.lx * size, cy = bh / 2 + L.ly * size;
    const lg = bctx.createRadialGradient(cx, cy, size * L.lr * 0.12, cx, cy, size * L.lr);
    lg.addColorStop(0, 'rgba(0,0,0,0)');
    lg.addColorStop(0.5, `rgba(0,0,0,${L.dark * 0.45})`);
    lg.addColorStop(1, `rgba(0,0,0,${L.dark})`);
    bctx.fillStyle = lg;
    bctx.fillRect(0, 0, bw, bh);
  }
  if (L.fade) {
    bctx.globalCompositeOperation = 'destination-out';
    bctx.drawImage(erodeMask(L.fade, p.t), 0, 0, bw, bh);
  }
  bctx.globalCompositeOperation = 'source-over';

  ctx.globalAlpha = alpha;
  const ox = x - bw / 2, oy = y - bh / 2;
  if (CAN_FILTER) {
    const blur = clamp(size / 650, 0.35, 1.4) + (1 - alpha) * 2.5;
    // soften and desaturate to sit in the camera image (reds survive)
    ctx.filter = `blur(${blur.toFixed(2)}px) saturate(0.7) contrast(1.05)`;
  }
  if (glitch > 0.05) {
    const slices = 6 + Math.floor(glitch * 10);
    for (let i = 0; i < slices; i++) {
      const sy = (i / slices) * bh, sh = bh / slices + 1;
      const dx = Math.random() < glitch * 0.6 ? (Math.random() - 0.5) * glitch * size * 0.12 : 0;
      ctx.drawImage(buf, 0, sy, bw, sh, ox + dx, oy + sy, bw, sh);
    }
  } else {
    ctx.drawImage(buf, 0, 0, bw, bh, ox, oy, bw, bh);
  }
  // faint double image, like a long exposure
  if (glitch > 0.2 || L.stutter) {
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = alpha * (0.08 + glitch * 0.25);
    ctx.drawImage(buf, 0, 0, bw, bh, ox + size * 0.012 + glitch * 6, oy, bw, bh);
  }
  ctx.restore();
}

// Pale fingers curling over the edge of something (used while emerging).
export function drawEdgeHands(ctx, box, progress, t) {
  const sz = Math.min(box.w, box.h) * 0.5 * clamp(progress * 3, 0, 1);
  if (sz < 3) return;
  for (let i = 0; i < 2; i++) {
    const hx = box.x + box.w * (0.3 + i * 0.4) + Math.sin(t * 3 + i) * 2;
    const hy = box.y + box.h * 0.02;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.scale(sz, sz);
    hand(ctx, 0, -0.08, Math.PI / 2 + (i ? -0.2 : 0.2), 0.42, { skin: [170, 176, 172], w: 0.05, curl: i ? -0.45 : 0.45, long: 1.1 });
    ctx.restore();
  }
}

// Full-screen face, cut in hard, stuttering.
export function drawScare(ctx, type, w, h, t, k) {
  if (k < 0.04) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); return; }
  const f = FACE[type] || [0, 0, 0.2];
  const frame = Math.floor(t * 15) % 4;
  const size = (h * (0.95 + k * 0.45 + (frame === 1 ? 0.15 : 0))) / f[2];
  const jx = (Math.random() - 0.5) * 34 * k, jy = (Math.random() - 0.5) * 34 * k;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (frame === 3 && Math.random() < 0.5) { ctx.restore(); return; } // cut to black
  const drawAt = (scale, alpha, rot) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(w / 2 + jx, h / 2 + jy);
    ctx.rotate(rot);
    ctx.translate(-f[0] * size * scale, -f[1] * size * scale);
    ctx.scale(size * scale, size * scale);
    DRAW[type](ctx, { t, agit: 1, s: size, speaking: true, moving: true, scare: true });
    ctx.restore();
  };
  drawAt(1, 1, (Math.random() - 0.5) * 0.06 * k);
  if (frame === 2) {
    ctx.globalCompositeOperation = 'screen';
    drawAt(1.08, 0.3, 0.05);
    ctx.globalCompositeOperation = 'source-over';
  }
  // only the face is lit
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.65);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.95)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  drawFX(ctx, w, h, { t, static: 1, fear: 1, flash: 0 });
  if (Math.random() < 0.18) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '140,0,0'},${0.12 + Math.random() * 0.25})`;
    ctx.fillRect(0, 0, w, h);
  }
}

// ---- screen effects --------------------------------------------------------
const grains = [];
function makeGrain() {
  for (let k = 0; k < 4; k++) {
    const g = document.createElement('canvas');
    g.width = g.height = 192;
    const x = g.getContext('2d');
    const im = x.createImageData(192, 192);
    for (let i = 0; i < im.data.length; i += 4) {
      const v = Math.random() * 255;
      im.data[i] = im.data[i + 1] = im.data[i + 2] = v;
      im.data[i + 3] = Math.random() * 90;
    }
    x.putImageData(im, 0, 0);
    grains.push(g);
  }
}

export function drawFX(ctx, w, h, fx) {
  if (!grains.length) makeGrain();
  // virtual flashlight / UV lamp when the phone has no controllable torch
  if (fx.beam) {
    const r = Math.min(w, h) * fx.beam.r;
    const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${fx.beam.dim})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // cold mist creeping in from the side something is on
  if (fx.mist && fx.mist.k > 0.02) {
    const { side, k } = fx.mist;
    const gx = side === 'left' ? 0 : side === 'right' ? w : w / 2;
    const gy = side === 'below' ? h : side === 'above' ? 0 : h / 2;
    const r = Math.max(w, h) * 0.6;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(170,210,230,${0.22 * k})`);
    g.addColorStop(1, 'rgba(170,210,230,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // grain
  ctx.save();
  ctx.globalAlpha = 0.35 + fx.static * 0.6;
  ctx.globalCompositeOperation = 'overlay';
  const gimg = grains[(Math.random() * grains.length) | 0];
  const ox = (Math.random() * 192) | 0, oy = (Math.random() * 192) | 0;
  for (let y = -oy; y < h; y += 192) for (let x = -ox; x < w; x += 192) ctx.drawImage(gimg, x, y);
  ctx.restore();
  // static tear lines
  if (fx.static > 0.2) {
    const n = Math.floor(fx.static * 6);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.12 * fx.static})`;
      ctx.fillRect(0, Math.random() * h, w, 1 + Math.random() * 3);
    }
  }
  // scanlines
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  // vignette, redder as nerve fails
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  const red = fx.fear > 0.6 ? (fx.fear - 0.6) * 2.5 * (0.6 + Math.sin(fx.t * 6) * 0.4) : 0;
  vg.addColorStop(1, `rgba(${Math.floor(red * 120)},0,0,${0.75 + red * 0.2})`);
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
  if (fx.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${fx.flash})`;
    ctx.fillRect(0, 0, w, h);
  }
}
