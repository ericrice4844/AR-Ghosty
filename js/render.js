// Procedural ghost art. Every figure is drawn in "unit space": the figure
// spans y = -0.5 (top) .. 0.5 (bottom), centred on x = 0, then scaled to its
// on-screen height. p = { t, agit (0..1), s (pixel scale), speaking, moving, seed }
import { clamp } from './util.js';

const TAU = Math.PI * 2;
function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function noise1(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; }
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function ellipse(c, x, y, rx, ry, rot = 0) { c.beginPath(); c.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot, 0, TAU); }
function line(c, pts) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); }
function limb(c, a, b, d, w, col) {
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
  line(c, [a, b, d]); c.stroke();
}
// Tapered limb with a dark outline and knobbly joint, for the nastier ones.
function flesh(c, a, b, d, w0, w1, col) {
  for (const [w, cc] of [[1.25, 'rgba(30,30,28,0.85)'], [1, col]]) {
    c.strokeStyle = cc; c.lineCap = 'round'; c.lineJoin = 'round';
    c.lineWidth = w0 * w; line(c, [a, b]); c.stroke();
    c.lineWidth = w1 * w; line(c, [b, d]); c.stroke();
  }
}
function fingers(c, at, dir, len, spread, w, col, n = 4, claw = null) {
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const a = dir + (i - (n - 1) / 2) * spread;
    const ex = at[0] + Math.cos(a) * len, ey = at[1] + Math.sin(a) * len;
    c.beginPath(); c.moveTo(at[0], at[1]);
    c.quadraticCurveTo(at[0] + Math.cos(a) * len * 0.6 + Math.cos(a + 0.6) * len * 0.15, at[1] + Math.sin(a) * len * 0.6 + Math.sin(a + 0.6) * len * 0.15, ex, ey);
    c.stroke();
    if (claw) { c.fillStyle = claw; ellipse(c, ex, ey, w * 0.6, w * 0.6); c.fill(); }
  }
}
function hair(c, x0, x1, top, bottom, n, sway, t, col, w, gap = null, seed = 0) {
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const x = x0 + (x1 - x0) * u;
    if (gap && x > gap[0] && x < gap[1]) continue;
    const wob = (noise1(i * 3.1 + seed + t * 0.6) - 0.5) * 0.03;
    const len = bottom + (hash1(i + seed) - 0.5) * 0.06;
    c.beginPath();
    c.moveTo(x * 0.6, top + Math.abs(x) * 0.3);
    c.bezierCurveTo(x * 1.1, top + (len - top) * 0.3, x * 1.2 + sway * 0.5 + wob, top + (len - top) * 0.7, x * 1.25 + sway + wob * 2, len);
    c.stroke();
  }
}
function glowEyes(c, pts, r, col, s, blur = 0.02) {
  c.save();
  c.shadowColor = col; c.shadowBlur = Math.min(60, blur * s);
  c.fillStyle = col;
  for (const [x, y] of pts) { ellipse(c, x, y, r, r); c.fill(); }
  c.restore();
}

// ---------------------------------------------------------------------------
export const DRAW = {
  lantern(c, p) {
    const { t, agit } = p;
    const bob = Math.sin(t * 1.3) * 0.03;
    c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 5; k++) {
      let px = 0, py = bob - 0.08;
      for (let j = 1; j <= 12; j++) {
        const y = bob - 0.08 + j * 0.035;
        const x = Math.sin(t * 2 + k * 1.7 + j * 0.55) * 0.012 * j + (k - 2) * 0.006 * j;
        c.strokeStyle = `rgba(160,225,255,${0.3 * (1 - j / 13)})`;
        c.lineWidth = 0.03 * (1 - j / 14);
        c.beginPath(); c.moveTo(px, py); c.lineTo(x, y); c.stroke();
        px = x; py = y;
      }
    }
    const fl = 0.85 + noise1(t * 6) * 0.3;
    const g = c.createRadialGradient(0, bob - 0.12, 0, 0, bob - 0.12, 0.38 * fl);
    g.addColorStop(0, 'rgba(235,252,255,0.95)');
    g.addColorStop(0.12, 'rgba(170,230,255,0.7)');
    g.addColorStop(0.4, 'rgba(80,160,230,0.18)');
    g.addColorStop(1, 'rgba(40,90,160,0)');
    c.fillStyle = g;
    c.fillRect(-0.5, -0.5, 1, 1);
    c.globalCompositeOperation = 'source-over';
    const f = clamp(Math.sin(t * 0.7) * 2 - 1, 0, 1) * 0.55 + agit * 0.45;
    if (f > 0.02) {
      c.fillStyle = `rgba(10,30,50,${f})`;
      ellipse(c, -0.032, bob - 0.14, 0.013, 0.02); c.fill();
      ellipse(c, 0.032, bob - 0.14, 0.013, 0.02); c.fill();
      ellipse(c, 0, bob - 0.085, 0.012, 0.024 + agit * 0.02); c.fill();
    }
  },

  wren(c, p) {
    const { t, agit, s } = p;
    const sway = Math.sin(t * 0.8) * 0.012;
    c.translate(0, Math.sin(t * 1.1) * 0.012);
    // legs, feet just off the floor
    c.strokeStyle = 'rgba(200,204,210,0.85)'; c.lineWidth = 0.02; c.lineCap = 'round';
    line(c, [[-0.04, 0.28], [-0.045, 0.46]]); c.stroke();
    line(c, [[0.04, 0.28], [0.036, 0.47]]); c.stroke();
    // nightgown
    const gg = c.createLinearGradient(0, -0.25, 0, 0.34);
    gg.addColorStop(0, 'rgba(236,238,240,0.95)');
    gg.addColorStop(0.7, 'rgba(210,216,222,0.75)');
    gg.addColorStop(1, 'rgba(190,200,210,0.25)');
    c.fillStyle = gg;
    c.beginPath();
    c.moveTo(-0.085, -0.25);
    c.quadraticCurveTo(-0.13, 0.05, -0.2 + sway, 0.31);
    for (let i = 0; i <= 14; i++) {
      const x = -0.2 + (0.4 * i) / 14 + sway;
      c.lineTo(x, 0.31 + (i % 2 ? 0.035 : 0) + (noise1(i * 2.3 + t * 0.4) - 0.5) * 0.03);
    }
    c.quadraticCurveTo(0.13, 0.05, 0.085, -0.25);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(120,128,138,0.25)'; c.lineWidth = 0.006;
    for (const x of [-0.07, -0.02, 0.03, 0.08]) { line(c, [[x * 0.5, -0.15], [x * 1.4 + sway, 0.3]]); c.stroke(); }
    // arms, a little too long
    const handY = 0.13 + agit * 0.02;
    limb(c, [-0.085, -0.23], [-0.115, -0.05], [-0.13, handY], 0.024, 'rgba(214,218,222,0.95)');
    limb(c, [0.085, -0.23], [0.11, -0.05], [0.125, handY], 0.024, 'rgba(214,218,222,0.95)');
    fingers(c, [-0.13, handY], Math.PI / 2, 0.035, 0.18, 0.008, 'rgba(214,218,222,0.95)');
    fingers(c, [0.125, handY], Math.PI / 2, 0.035, 0.18, 0.008, 'rgba(214,218,222,0.95)');
    // head, tilted; snaps when upset
    const jerk = agit > 0.5 ? (noise1(t * 7) > 0.7 ? 0.5 : 0) : 0;
    const tilt = 0.2 + Math.sin(t * 0.45) * 0.06 + jerk + agit * 0.15;
    c.save();
    c.translate(0, -0.33);
    c.rotate(tilt);
    const hg = c.createRadialGradient(-0.02, -0.02, 0.01, 0, 0, 0.08);
    hg.addColorStop(0, 'rgb(222,226,228)'); hg.addColorStop(1, 'rgb(170,176,182)');
    c.fillStyle = hg; ellipse(c, 0, 0, 0.072, 0.082); c.fill();
    // face, mostly hidden
    c.fillStyle = 'rgba(8,8,10,0.95)';
    ellipse(c, -0.026, 0.005, 0.012, 0.016); c.fill();
    ellipse(c, 0.026, 0.005, 0.012, 0.016); c.fill();
    if (agit > 0.55) glowEyes(c, [[0.026, 0.006]], 0.004, 'rgba(255,255,255,0.95)', s);
    c.fillStyle = 'rgba(30,20,20,0.8)';
    ellipse(c, 0, 0.045, 0.012, 0.004 + agit * 0.016); c.fill();
    hair(c, -0.085, 0.085, -0.08, 0.2, 30, sway * 3, t, 'rgba(12,9,9,0.92)', 0.01, [0.012, 0.042], 3);
    c.restore();
  },

  weeper(c, p) {
    const { t, agit, s } = p;
    const lift = sstep(0.4, 0.92, agit);
    const sob = (Math.sin(t * 18) * 0.5 + 0.5) * Math.max(0, Math.sin(t * 1.7)) * (1 - lift);
    c.translate(Math.sin(t * 23) * 0.003 * (1 + agit * 3), sob * 0.008);
    if (agit > 0.3) {
      const rg = c.createRadialGradient(0, 0, 0.05, 0, 0, 0.55);
      rg.addColorStop(0, `rgba(160,10,10,${agit * 0.35})`); rg.addColorStop(1, 'rgba(80,0,0,0)');
      c.fillStyle = rg; c.fillRect(-0.55, -0.55, 1.1, 1.1);
    }
    c.fillStyle = 'rgba(0,0,0,0.5)'; ellipse(c, 0, 0.47, 0.34, 0.04); c.fill();
    // shins
    limb(c, [-0.07, -0.02], [-0.09, 0.2], [-0.11, 0.45], 0.05, 'rgb(160,162,165)');
    limb(c, [0.07, -0.02], [0.09, 0.2], [0.11, 0.45], 0.05, 'rgb(150,152,156)');
    // ragged dress
    const dg = c.createLinearGradient(0, -0.2, 0, 0.47);
    dg.addColorStop(0, 'rgba(125,122,118,0.95)'); dg.addColorStop(1, 'rgba(60,58,56,0.9)');
    c.fillStyle = dg;
    c.beginPath();
    c.moveTo(-0.2, -0.06);
    c.quadraticCurveTo(-0.08, -0.22 + lift * -0.05, 0, -0.2 - lift * 0.05);
    c.quadraticCurveTo(0.08, -0.22 + lift * -0.05, 0.2, -0.06);
    c.quadraticCurveTo(0.3, 0.2, 0.29, 0.46);
    for (let i = 0; i <= 16; i++) c.lineTo(0.29 - (0.58 * i) / 16, 0.46 + (i % 2 ? 0.02 : -0.01) + hash1(i) * 0.02);
    c.quadraticCurveTo(-0.3, 0.2, -0.2, -0.06);
    c.closePath(); c.fill();
    // head
    const hy = -0.13 - lift * 0.18;
    const hairBottom = 0.42 - lift * 0.15;
    c.fillStyle = 'rgb(176,178,180)'; ellipse(c, 0, hy, 0.075, 0.085); c.fill();
    if (lift > 0.15) {
      c.globalAlpha = lift;
      c.fillStyle = 'rgb(205,206,204)'; ellipse(c, 0, hy + 0.01, 0.066, 0.08); c.fill();
      c.fillStyle = '#050303';
      ellipse(c, -0.026, hy, 0.017, 0.013); c.fill();
      ellipse(c, 0.026, hy, 0.017, 0.013); c.fill();
      ellipse(c, 0, hy + 0.05, 0.022, 0.012 + lift * 0.035); c.fill();
      glowEyes(c, [[-0.026, hy], [0.026, hy]], 0.0055, 'rgba(255,90,70,1)', s, 0.03);
      c.globalAlpha = 1;
    }
    // hair — parts as she looks up
    const gapW = lift * 0.07;
    hair(c, -0.2, 0.2, hy - 0.08, hairBottom, 46, Math.sin(t * 0.7) * 0.01, t, 'rgba(6,5,5,0.95)', 0.012, lift > 0.15 ? [-gapW, gapW] : null, 7);
    // arms wrapped around the head; claws drop when she rises
    const hl = [-0.04 - lift * 0.1, hy + 0.02 + lift * 0.2], hr = [0.04 + lift * 0.1, hy + 0.02 + lift * 0.2];
    limb(c, [-0.18, -0.05], [-0.24, 0.06 - lift * 0.05], hl, 0.028, 'rgb(190,190,188)');
    limb(c, [0.18, -0.05], [0.24, 0.06 - lift * 0.05], hr, 0.028, 'rgb(186,186,184)');
    const fdir = lift > 0.5 ? Math.PI / 2 : -Math.PI / 2;
    fingers(c, hl, fdir + 0.4, 0.07, 0.17, 0.008, 'rgb(196,196,194)', 4, 'rgba(30,20,20,0.9)');
    fingers(c, hr, fdir - 0.4, 0.07, 0.17, 0.008, 'rgb(196,196,194)', 4, 'rgba(30,20,20,0.9)');
  },

  hollow(c, p) {
    const { t, agit, s } = p;
    c.rotate(Math.sin(t * 0.3) * 0.012);
    for (let i = 0; i < 16; i++) {
      const age = (t * 0.06 + i * 0.0625) % 1;
      const x = Math.sin(i * 12.9) * 0.08 + (noise1(i + t * 0.3) - 0.5) * 0.05;
      c.fillStyle = `rgba(14,12,20,${0.35 * (1 - age)})`;
      ellipse(c, x, 0.45 - age * 0.95, 0.02 + age * 0.04, 0.02 + age * 0.04); c.fill();
    }
    c.save();
    c.shadowColor = `rgba(130,110,190,${0.45 + agit * 0.3})`;
    c.shadowBlur = Math.min(50, 0.03 * s);
    const col = 'rgba(4,4,7,0.97)';
    c.fillStyle = col;
    const ht = Math.sin(t * 0.4) * 0.15 + agit * 0.25;
    c.save(); c.translate(0, -0.44); c.rotate(ht); ellipse(c, 0, 0, 0.034, 0.055); c.fill(); c.restore();
    c.fillRect(-0.008, -0.4, 0.016, 0.05);
    c.beginPath();
    c.moveTo(-0.075, -0.36); c.lineTo(0.075, -0.36);
    c.quadraticCurveTo(0.06, -0.15, 0.04, 0.03); c.lineTo(-0.04, 0.03);
    c.quadraticCurveTo(-0.06, -0.15, -0.075, -0.36);
    c.fill();
    const sw = Math.sin(t * 0.5) * 0.01;
    limb(c, [-0.07, -0.35], [-0.095, -0.05], [-0.1 + sw, 0.27], 0.02, col);
    limb(c, [0.07, -0.35], [0.095, -0.05], [0.1 + sw, 0.27], 0.02, col);
    fingers(c, [-0.1 + sw, 0.27], Math.PI / 2 + 0.05, 0.09, 0.09, 0.008, col);
    fingers(c, [0.1 + sw, 0.27], Math.PI / 2 - 0.05, 0.09, 0.09, 0.008, col);
    limb(c, [-0.025, 0.02], [-0.032, 0.26], [-0.04, 0.5], 0.026, col);
    limb(c, [0.025, 0.02], [0.032, 0.26], [0.04, 0.5], 0.026, col);
    c.restore();
    c.save(); c.translate(0, -0.44); c.rotate(ht);
    glowEyes(c, [[-0.012, -0.006], [0.012, -0.006]], 0.0045 + agit * 0.002, 'rgba(255,255,255,0.95)', s, 0.025);
    if (agit > 0.25) {
      c.strokeStyle = `rgba(230,230,240,${agit})`; c.lineWidth = 0.003;
      c.beginPath(); c.moveTo(-0.024, 0.02); c.quadraticCurveTo(0, 0.04 + agit * 0.015, 0.024, 0.02); c.stroke();
    }
    c.restore();
  },

  whisperer(c, p) {
    const { t, agit } = p;
    const wave = (y) => Math.sin(t * 1.5 + y * 9) * 0.012 * (y + 0.5);
    const sg = c.createLinearGradient(0, -0.45, 0, 0.45);
    sg.addColorStop(0, 'rgba(190,210,195,0.75)'); sg.addColorStop(0.6, 'rgba(150,170,160,0.45)'); sg.addColorStop(1, 'rgba(120,140,130,0)');
    c.fillStyle = sg;
    c.beginPath();
    c.moveTo(0, -0.44);
    c.bezierCurveTo(0.09, -0.44, 0.1, -0.3, 0.12 + wave(-0.25), -0.25);
    c.bezierCurveTo(0.2, -0.2, 0.22 + wave(0.1), 0.1, 0.25 + wave(0.45), 0.45);
    for (let i = 0; i <= 12; i++) c.lineTo(0.25 - (0.5 * i) / 12 + wave(0.45), 0.45 + Math.sin(i * 1.7 + t * 2) * 0.02);
    c.bezierCurveTo(-0.22 + wave(0.1), 0.1, -0.2, -0.2, -0.12 + wave(-0.25), -0.25);
    c.bezierCurveTo(-0.1, -0.3, -0.09, -0.44, 0, -0.44);
    c.fill();
    c.strokeStyle = 'rgba(80,100,90,0.25)'; c.lineWidth = 0.006;
    for (const x of [-0.12, -0.05, 0.04, 0.11]) { c.beginPath(); c.moveTo(x * 0.5, -0.22); c.quadraticCurveTo(x + wave(0), 0.1, x * 1.6 + wave(0.4), 0.42); c.stroke(); }
    const fg = c.createRadialGradient(0, -0.33, 0.005, 0, -0.33, 0.085);
    fg.addColorStop(0, 'rgba(235,245,238,0.75)'); fg.addColorStop(1, 'rgba(200,220,210,0)');
    c.fillStyle = fg; ellipse(c, 0, -0.33, 0.07, 0.09); c.fill();
    c.fillStyle = `rgba(25,40,32,${0.55 + agit * 0.3})`;
    ellipse(c, -0.026, -0.345, 0.017, 0.012 + agit * 0.004); c.fill();
    ellipse(c, 0.026, -0.345, 0.017, 0.012 + agit * 0.004); c.fill();
    c.fillStyle = 'rgba(240,250,244,0.5)'; ellipse(c, 0, -0.325, 0.006, 0.018); c.fill();
    const mo = p.speaking ? 0.006 + Math.abs(Math.sin(t * 11)) * 0.018 : 0.005 + agit * 0.012;
    c.fillStyle = 'rgba(20,30,25,0.75)'; ellipse(c, 0, -0.29, 0.016 + agit * 0.006, mo); c.fill();
    for (const sx of [-1, 1]) {
      const hx = sx * (0.1 + Math.sin(t * 0.9 + sx) * 0.01), hy = -0.12;
      c.fillStyle = 'rgba(225,240,230,0.35)'; ellipse(c, hx, hy, 0.03, 0.04); c.fill();
      c.strokeStyle = 'rgba(225,240,230,0.35)'; c.lineWidth = 0.008;
      for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(hx + (i - 1.5) * 0.013, hy - 0.03); c.lineTo(hx + (i - 1.5) * 0.017, hy - 0.08); c.stroke(); }
    }
  },

  drowned(c, p) {
    const { t, agit, s } = p;
    c.translate(0, Math.sin(t * 0.9) * 0.006);
    const skin = 'rgb(138,160,164)';
    const cg = c.createLinearGradient(0, -0.2, 0, 0.5);
    cg.addColorStop(0, 'rgba(25,40,45,0.95)'); cg.addColorStop(0.6, 'rgba(25,40,45,0.8)'); cg.addColorStop(1, 'rgba(25,40,45,0)');
    c.fillStyle = cg;
    c.beginPath();
    c.moveTo(-0.07, -0.19); c.quadraticCurveTo(-0.24, -0.15, -0.26, 0.1); c.lineTo(-0.23, 0.5); c.lineTo(0.23, 0.5); c.lineTo(0.26, 0.1);
    c.quadraticCurveTo(0.24, -0.15, 0.07, -0.19); c.closePath(); c.fill();
    c.fillStyle = skin; c.beginPath(); c.moveTo(-0.06, -0.2); c.lineTo(0, -0.08); c.lineTo(0.06, -0.2); c.closePath(); c.fill();
    const reach = 0.5 + agit * 0.5;
    const hl = [-0.3, -0.05 - reach * 0.12], hr = [0.3, -0.04 - reach * 0.1];
    limb(c, [-0.21, -0.12], [-0.3, 0.06], hl, 0.06, skin);
    limb(c, [0.21, -0.12], [0.31, 0.07], hr, 0.06, skin);
    fingers(c, hl, -Math.PI / 2 - 0.3, 0.06, 0.25, 0.018, skin, 4, 'rgba(40,50,50,0.9)');
    fingers(c, hr, -Math.PI / 2 + 0.3, 0.06, 0.25, 0.018, skin, 4, 'rgba(40,50,50,0.9)');
    const hg = c.createRadialGradient(-0.03, -0.33, 0.02, 0, -0.3, 0.13);
    hg.addColorStop(0, 'rgb(170,190,192)'); hg.addColorStop(1, 'rgb(95,118,124)');
    c.fillStyle = hg; ellipse(c, 0, -0.3, 0.1, 0.118); c.fill();
    for (let i = 0; i < 7; i++) {
      const bx = (hash1(i * 3) - 0.5) * 0.16, by = -0.3 + (hash1(i * 7) - 0.5) * 0.18;
      const bg = c.createRadialGradient(bx, by, 0, bx, by, 0.03);
      bg.addColorStop(0, 'rgba(70,50,90,0.45)'); bg.addColorStop(1, 'rgba(70,50,90,0)');
      c.fillStyle = bg; ellipse(c, bx, by, 0.03, 0.03); c.fill();
    }
    c.fillStyle = '#060808';
    ellipse(c, -0.037, -0.32, 0.024, 0.02); c.fill();
    ellipse(c, 0.037, -0.32, 0.024, 0.02); c.fill();
    c.fillStyle = 'rgba(210,225,225,0.92)';
    ellipse(c, -0.037, -0.32, 0.016, 0.013); c.fill();
    ellipse(c, 0.037, -0.32, 0.016, 0.013); c.fill();
    c.fillStyle = '#000'; ellipse(c, -0.034, -0.318, 0.003, 0.003); c.fill(); ellipse(c, 0.04, -0.318, 0.003, 0.003); c.fill();
    const mo = 0.04 + agit * 0.025 + (p.speaking ? Math.abs(Math.sin(t * 7)) * 0.01 : 0);
    c.fillStyle = '#030505'; ellipse(c, 0, -0.235, 0.032, mo); c.fill();
    c.strokeStyle = 'rgba(170,215,225,0.5)'; c.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      c.lineWidth = 0.008 + i * 0.002;
      c.beginPath(); c.moveTo((i - 1.5) * 0.012, -0.235 + mo * 0.6);
      for (let y = 0; y < 8; y++) c.lineTo((i - 1.5) * 0.014 + Math.sin(t * 6 + y + i) * 0.006, -0.2 + y * 0.04);
      c.stroke();
    }
    hair(c, -0.1, 0.1, -0.41, -0.18, 24, 0, t * 0.2, 'rgba(15,28,22,0.9)', 0.012, [-0.05, 0.05], 11);
    hair(c, -0.105, -0.07, -0.4, -0.05, 6, 0, t * 0.2, 'rgba(15,28,22,0.9)', 0.012, null, 13);
    hair(c, 0.07, 0.105, -0.4, -0.05, 6, 0, t * 0.2, 'rgba(15,28,22,0.9)', 0.012, null, 17);
    c.fillStyle = 'rgba(180,220,230,0.7)';
    for (let i = 0; i < 10; i++) {
      const age = (t * 0.7 + i * 0.1) % 1;
      const x = [-0.3, 0.3, -0.05, 0.05, 0, -0.08, 0.08, -0.2, 0.2, 0][i];
      const y0 = [-0.05, -0.04, -0.2, -0.2, -0.18, -0.12, -0.12, 0.02, 0.02, -0.18][i];
      ellipse(c, x, y0 + age * 0.5, 0.005, 0.009); c.fill();
    }
    void s;
  },

  crawler(c, p) {
    const { t, agit, s } = p;
    const mv = p.moving ? 1 : 0;
    const tw = !p.moving && noise1(t * 3 + 9) > 0.82 ? (noise1(t * 40) - 0.5) * 0.04 : 0;
    const g = (i) => mv * Math.sin(t * 16 + i * 1.6) * 0.03;
    const skin = 'rgb(182,182,176)', dark = 'rgb(120,120,116)';
    c.fillStyle = 'rgba(0,0,0,0.55)'; ellipse(c, 0, 0.45, 0.45, 0.05); c.fill();
    flesh(c, [-0.08, -0.05], [-0.3, -0.27 + g(2)], [-0.22, 0.38], 0.07, 0.04, dark);
    flesh(c, [0.08, -0.05], [0.3, -0.27 + g(3)], [0.22, 0.38], 0.07, 0.04, dark);
    const tg = c.createLinearGradient(0, -0.12, 0, 0.16);
    tg.addColorStop(0, 'rgb(200,200,194)'); tg.addColorStop(1, 'rgb(140,140,136)');
    c.fillStyle = tg;
    c.strokeStyle = 'rgba(40,40,38,0.7)'; c.lineWidth = 0.008;
    c.beginPath();
    c.moveTo(-0.1, -0.06); c.bezierCurveTo(-0.06, -0.15, 0.06, -0.15, 0.1, -0.06);
    c.bezierCurveTo(0.16, 0.02, 0.17, 0.1, 0.13, 0.14); c.quadraticCurveTo(0, 0.2, -0.13, 0.14);
    c.bezierCurveTo(-0.17, 0.1, -0.16, 0.02, -0.1, -0.06); c.closePath(); c.fill(); c.stroke();
    c.strokeStyle = 'rgba(70,70,66,0.55)'; c.lineWidth = 0.007;
    for (let i = 0; i < 6; i++) { const y = -0.07 + i * 0.03, ww = 0.08 + Math.sin((i / 5) * Math.PI) * 0.035; c.beginPath(); c.moveTo(-ww, y + 0.012); c.quadraticCurveTo(0, y - 0.022, ww, y + 0.012); c.stroke(); }
    c.strokeStyle = 'rgba(60,60,58,0.6)'; c.lineWidth = 0.01;
    c.beginPath(); c.moveTo(0, -0.12); c.lineTo(0, 0.15); c.stroke();
    const hL = [-0.34 + g(0) * 0.5, 0.44], hR = [0.34 - g(1) * 0.5, 0.44];
    flesh(c, [-0.13, 0.11], [-0.4 + tw, -0.02 + g(0)], hL, 0.065, 0.035, skin);
    flesh(c, [0.13, 0.11], [0.4 - tw, -0.02 + g(1)], hR, 0.065, 0.035, skin);
    c.fillStyle = dark;
    for (const j of [[-0.4 + tw, -0.02 + g(0)], [0.4 - tw, -0.02 + g(1)], [-0.3, -0.27 + g(2)], [0.3, -0.27 + g(3)]]) { ellipse(c, j[0], j[1], 0.03, 0.03); c.fill(); }
    fingers(c, hL, Math.PI - 0.2, 0.09, 0.35, 0.012, skin, 4, '#222');
    fingers(c, hR, 0.2, 0.09, 0.35, 0.012, skin, 4, '#222');
    const hx = tw * 2, hy = 0.27;
    c.save(); c.translate(hx, hy); c.rotate(Math.PI + Math.sin(t * 0.9) * 0.15 + tw * 5);
    hair(c, -0.08, 0.08, -0.07, -0.3, 22, 0, t, 'rgba(10,8,8,0.9)', 0.01, null, 21);
    c.fillStyle = 'rgb(196,196,190)'; ellipse(c, 0, 0, 0.085, 0.095); c.fill();
    c.fillStyle = '#fff';
    const er = 0.022 + agit * 0.006;
    ellipse(c, -0.034, -0.02, er, er); c.fill();
    ellipse(c, 0.034, -0.02, er, er); c.fill();
    c.fillStyle = '#000';
    ellipse(c, -0.034, -0.012, 0.004, 0.004); c.fill();
    ellipse(c, 0.034, -0.012, 0.004, 0.004); c.fill();
    c.fillStyle = '#120404';
    c.beginPath(); c.moveTo(-0.075, 0.025); c.quadraticCurveTo(0, 0.1 + agit * 0.03, 0.075, 0.025); c.quadraticCurveTo(0, 0.05, -0.075, 0.025); c.fill();
    c.fillStyle = 'rgb(236,230,210)';
    for (let i = 0; i < 13; i++) {
      const u = i / 12, x = -0.068 + u * 0.136, yTop = 0.03 + Math.sin(u * Math.PI) * 0.012;
      c.beginPath(); c.moveTo(x - 0.005, yTop); c.lineTo(x + 0.005, yTop); c.lineTo(x, yTop + 0.018); c.fill();
      const yBot = 0.03 + Math.sin(u * Math.PI) * (0.06 + agit * 0.03);
      c.beginPath(); c.moveTo(x - 0.005, yBot); c.lineTo(x + 0.005, yBot); c.lineTo(x, yBot - 0.016); c.fill();
    }
    c.restore();
    void s;
  },

  mimic(c, p) {
    const { t, agit, s } = p;
    const def = 0.3 + agit * 0.7;
    for (let k = 2; k >= 0; k--) {
      const ox = k * 0.025 * Math.sin(t * 2 + k), a = (k === 0 ? 0.85 : 0.25) * def;
      c.fillStyle = `rgba(140,128,116,${a})`;
      c.beginPath();
      c.moveTo(ox - 0.06, -0.3); c.quadraticCurveTo(ox - 0.17, -0.27, ox - 0.18, -0.15);
      c.lineTo(ox - 0.14, 0.15); c.quadraticCurveTo(ox - 0.1, 0.4, ox - 0.05, 0.5); c.lineTo(ox + 0.05, 0.5);
      c.quadraticCurveTo(ox + 0.1, 0.4, ox + 0.14, 0.15); c.lineTo(ox + 0.18, -0.15);
      c.quadraticCurveTo(ox + 0.17, -0.27, ox + 0.06, -0.3); c.closePath(); c.fill();
    }
    const fg = c.createLinearGradient(0, -0.48, 0, -0.28);
    fg.addColorStop(0, 'rgb(238,230,220)'); fg.addColorStop(1, 'rgb(200,190,180)');
    c.fillStyle = fg; ellipse(c, 0, -0.38, 0.07, 0.092); c.fill();
    if (agit > 0.3) {
      c.fillStyle = `rgba(60,50,45,${(agit - 0.3) * 0.9})`;
      ellipse(c, -0.026, -0.4, 0.014, 0.008); c.fill();
      ellipse(c, 0.026, -0.4, 0.014, 0.008); c.fill();
    }
    const open = p.speaking ? 0.02 + Math.abs(Math.sin(t * 13)) * 0.05 : 0.002;
    c.fillStyle = '#060404';
    c.beginPath();
    c.moveTo(-0.055, -0.335);
    c.quadraticCurveTo(0, -0.335 - open * 0.3, 0.055, -0.335);
    c.quadraticCurveTo(0, -0.335 + open * 1.6, -0.055, -0.335);
    c.fill();
    c.strokeStyle = 'rgba(90,70,60,0.6)'; c.lineWidth = 0.003;
    c.beginPath(); c.moveTo(-0.06, -0.336); c.quadraticCurveTo(0, -0.33, 0.06, -0.336); c.stroke();
    void s;
  },

  grinner(c, p) {
    const { t, agit, s } = p;
    c.rotate(Math.sin(t * 0.35) * 0.04);
    limb(c, [-0.045, 0.1], [-0.05, 0.3], [-0.055, 0.5], 0.05, 'rgb(20,18,20)');
    limb(c, [0.045, 0.1], [0.05, 0.3], [0.055, 0.5], 0.05, 'rgb(20,18,20)');
    c.fillStyle = 'rgb(26,23,25)';
    c.beginPath(); c.moveTo(-0.15, -0.26); c.lineTo(0.15, -0.26); c.lineTo(0.13, 0.16); c.lineTo(-0.13, 0.16); c.closePath(); c.fill();
    c.fillStyle = 'rgb(210,206,198)'; c.beginPath(); c.moveTo(-0.045, -0.27); c.lineTo(0, -0.1); c.lineTo(0.045, -0.27); c.closePath(); c.fill();
    c.fillStyle = 'rgb(110,20,22)'; c.beginPath(); c.moveTo(-0.012, -0.25); c.lineTo(0.012, -0.25); c.lineTo(0.006, -0.12); c.lineTo(0, -0.105); c.lineTo(-0.006, -0.12); c.fill();
    c.strokeStyle = 'rgba(90,85,90,0.8)'; c.lineWidth = 0.006;
    line(c, [[-0.045, -0.27], [-0.075, -0.15], [-0.02, -0.08]]); c.stroke();
    line(c, [[0.045, -0.27], [0.075, -0.15], [0.02, -0.08]]); c.stroke();
    limb(c, [-0.14, -0.24], [-0.17, -0.06], [-0.165, 0.1], 0.045, 'rgb(26,23,25)');
    limb(c, [0.14, -0.24], [0.17, -0.06], [0.165, 0.1], 0.045, 'rgb(26,23,25)');
    fingers(c, [-0.165, 0.12], Math.PI / 2, 0.06, 0.12, 0.009, 'rgb(220,214,204)');
    fingers(c, [0.165, 0.12], Math.PI / 2, 0.06, 0.12, 0.009, 'rgb(220,214,204)');
    c.save(); c.translate(0, -0.37); c.rotate(Math.sin(t * 0.5) * 0.1 + agit * 0.25);
    c.fillStyle = 'rgb(226,220,210)'; ellipse(c, 0, 0, 0.068, 0.09); c.fill();
    c.fillStyle = 'rgb(12,10,10)';
    c.beginPath(); c.ellipse(0, -0.045, 0.069, 0.05, 0, Math.PI, TAU); c.lineTo(0.069, -0.045);
    c.quadraticCurveTo(0.03, -0.065, 0, -0.05); c.quadraticCurveTo(-0.03, -0.065, -0.069, -0.045); c.fill();
    c.strokeStyle = 'rgb(20,16,16)'; c.lineWidth = 0.006;
    for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(sx * 0.012, -0.034); c.quadraticCurveTo(sx * 0.03, -0.05, sx * 0.045, -0.036); c.stroke(); }
    c.fillStyle = 'rgba(90,70,70,0.35)';
    ellipse(c, -0.026, -0.018, 0.016, 0.012); c.fill(); ellipse(c, 0.026, -0.018, 0.016, 0.012); c.fill();
    c.fillStyle = '#000';
    ellipse(c, -0.026, -0.02, 0.009, 0.009); c.fill();
    ellipse(c, 0.026, -0.02, 0.009, 0.009); c.fill();
    glowEyes(c, [[-0.024, -0.023], [0.028, -0.023]], 0.0025, 'rgba(255,255,255,1)', s, 0.01);
    const w = 0.11 + agit * 0.02, d = 0.06 + agit * 0.02;
    c.fillStyle = 'rgb(60,8,12)';
    c.beginPath(); c.moveTo(-w, 0.01); c.quadraticCurveTo(0, 0.035, w, 0.01); c.quadraticCurveTo(0, 0.02 + d * 1.6, -w, 0.01); c.fill();
    c.fillStyle = 'rgb(240,236,222)';
    for (let i = 0; i < 18; i++) {
      const u = i / 17, x = -w * 0.92 + u * w * 1.84;
      const yt = 0.012 + Math.sin(u * Math.PI) * 0.012;
      c.fillRect(x - 0.005, yt, 0.009, 0.014);
      const yb = 0.012 + Math.sin(u * Math.PI) * d * 0.78;
      c.fillRect(x - 0.005, yb - 0.013, 0.009, 0.013);
    }
    c.strokeStyle = 'rgba(120,100,95,0.5)'; c.lineWidth = 0.003;
    for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(sx * w, 0.01); c.quadraticCurveTo(sx * (w + 0.015), -0.01, sx * (w + 0.01), -0.03); c.stroke(); }
    c.restore();
  },
};

// Where each face is (for the jumpscare) and how big it is, in unit space.
export const FACE = {
  lantern: [0, -0.12, 0.25], wren: [0, -0.33, 0.2], weeper: [0, -0.3, 0.22], hollow: [0, -0.44, 0.13],
  whisperer: [0, -0.33, 0.2], drowned: [0, -0.29, 0.26], crawler: [0, 0.27, 0.22], mimic: [0, -0.37, 0.2], grinner: [0, -0.37, 0.24],
};

// ---------------------------------------------------------------------------
const buf = document.createElement('canvas');
const bctx = buf.getContext('2d');

// Draw a ghost centred at (x, y), `size` px tall, with glitch and clipping.
export function drawGhost(ctx, type, x, y, size, p, opts = {}) {
  const draw = DRAW[type];
  if (!draw || size < 4) return;
  const alpha = clamp(opts.alpha ?? 1, 0, 1);
  if (alpha <= 0.01) return;
  const glitch = opts.glitch || 0;
  const P = { ...p, s: size };
  const direct = size > 1400;
  ctx.save();
  if (opts.clip) {
    ctx.beginPath();
    ctx.rect(opts.clip.x, opts.clip.y, opts.clip.w, opts.clip.h);
    ctx.clip();
  }
  if (direct) {
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
  bctx.clearRect(0, 0, buf.width, buf.height);
  bctx.translate(bw / 2, bh / 2);
  bctx.scale(size, size);
  bctx.save();
  draw(bctx, P);
  bctx.restore();
  ctx.globalAlpha = alpha;
  const ox = x - bw / 2, oy = y - bh / 2;
  if (glitch > 0.05) {
    const slices = 6 + Math.floor(glitch * 10);
    for (let i = 0; i < slices; i++) {
      const sy = (i / slices) * bh, sh = bh / slices + 1;
      const dx = Math.random() < glitch * 0.6 ? (Math.random() - 0.5) * glitch * size * 0.12 : 0;
      ctx.drawImage(buf, 0, sy, bw, sh, ox + dx, oy + sy, bw, sh);
    }
    if (glitch > 0.3) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * glitch * 0.35;
      ctx.drawImage(buf, 0, 0, bw, bh, ox + glitch * 8, oy, bw, bh);
      ctx.globalCompositeOperation = 'source-over';
    }
  } else {
    ctx.drawImage(buf, 0, 0, bw, bh, ox, oy, bw, bh);
  }
  ctx.restore();
}

// Pale hands curling over the edge of something (used while emerging).
export function drawEdgeHands(ctx, box, progress, t) {
  const n = 2;
  for (let i = 0; i < n; i++) {
    const hx = box.x + box.w * (0.3 + i * 0.4);
    const hy = box.y + box.h * 0.02;
    const sz = Math.min(box.w, box.h) * 0.22 * clamp(progress * 3, 0, 1);
    if (sz < 2) continue;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.scale(sz, sz);
    ctx.fillStyle = 'rgb(176,180,178)';
    ellipse(ctx, 0, 0.15, 0.3, 0.2); ctx.fill();
    ctx.strokeStyle = 'rgb(176,180,178)'; ctx.lineCap = 'round'; ctx.lineWidth = 0.12;
    for (let f = 0; f < 4; f++) {
      const fx = -0.24 + f * 0.16 + Math.sin(t * 3 + f + i) * 0.01;
      ctx.beginPath(); ctx.moveTo(fx, 0.05); ctx.quadraticCurveTo(fx, -0.25, fx + 0.03, 0.25 + Math.sin(t * 2 + f) * 0.03); ctx.stroke();
      ctx.fillStyle = 'rgba(30,25,25,0.9)'; ellipse(ctx, fx + 0.03, 0.27, 0.04, 0.04); ctx.fill();
    }
    ctx.restore();
  }
}

// Full-screen face rushing at you.
export function drawScare(ctx, type, w, h, t, k) {
  const f = FACE[type] || [0, 0, 0.2];
  const size = (h * (0.45 + k * 0.75)) / f[2];
  const jx = (Math.random() - 0.5) * 30 * k, jy = (Math.random() - 0.5) * 30 * k;
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${0.6 + k * 0.4})`;
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2 + jx, h / 2 + jy);
  ctx.rotate((Math.random() - 0.5) * 0.08 * k);
  ctx.translate(-f[0] * size, -f[1] * size);
  ctx.scale(size, size);
  DRAW[type](ctx, { t, agit: 1, s: size, speaking: true, moving: true });
  ctx.restore();
  // crush it into the dark and the static
  drawFX(ctx, w, h, { t, static: 1, fear: 1, flash: 0 });
  if (Math.random() < 0.2) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '160,0,0'},${0.15 + Math.random() * 0.3})`;
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
