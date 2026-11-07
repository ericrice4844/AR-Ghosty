// Finds doors, windows and framed panels (mirrors, pictures, glass) in the
// camera image. The object detector doesn't know these, so this looks for
// rectangles: long vertical edges paired up and closed by horizontal edges,
// then classifies them by shape, position and how bright they are inside.
//
// It's a heuristic. It will sometimes call a wardrobe a door or a picture a
// mirror; for a ghost game, a painting with something moving inside it works
// just as well.

const W = 120;
const cv = document.createElement('canvas');
const cx = cv.getContext('2d', { willReadFrequently: true });

function grab(src, w, h) {
  const sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight;
  if (!sw || !sh) return null;
  const H = Math.round((W * h) / w);
  cv.width = W; cv.height = H;
  const s = Math.max(W / sw, H / sh);
  cx.drawImage(src, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
  const d = cx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  // light blur
  const b = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let s2 = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s2 += g[(y + j) * W + x + i];
    b[y * W + x] = s2 / 9;
  }
  return { g: b, H };
}

function runs(edge, len, outer, inner, minLen, along) {
  // along = 'y': runs down each column; 'x': runs across each row
  const out = [];
  for (let o = 1; o < outer - 1; o++) {
    let start = -1, gap = 0;
    for (let i = 1; i <= inner; i++) {
      const on = i < inner && (along === 'y' ? edge[i * len + o] : edge[o * len + i]);
      if (on) { if (start < 0) start = i; gap = 0; }
      else if (start >= 0) {
        if (++gap > 2 || i === inner) {
          const end = i - gap;
          if (end - start >= minLen) out.push({ p: o, a: start, b: end });
          start = -1; gap = 0;
        }
      }
    }
  }
  // keep the strongest of near-duplicate parallel runs
  out.sort((r, s) => (s.b - s.a) - (r.b - r.a));
  const kept = [];
  for (const r of out) {
    if (kept.some((k) => Math.abs(k.p - r.p) <= 2 && Math.min(k.b, r.b) - Math.max(k.a, r.a) > (r.b - r.a) * 0.5)) continue;
    kept.push(r);
  }
  return kept;
}

function meanIn(g, H, x0, y0, x1, y1) {
  let s = 0, n = 0;
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) { s += g[y * W + x]; n++; }
  return n ? s / n : 0;
}

// Returns [{ kind: 'door'|'window'|'panel', x, y, w, h, score }] in screen px.
export function findSurfaces(src, w, h) {
  const f = grab(src, w, h);
  if (!f) return [];
  const { g, H } = f;
  const mag = new Float32Array(W * H), gxA = new Float32Array(W * H), gyA = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1];
    const gy = g[i + W - 1] + 2 * g[i + W] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - W] - g[i - W + 1];
    gxA[i] = gx; gyA[i] = gy; mag[i] = Math.hypot(gx, gy);
  }
  const sorted = Array.from(mag).sort((a, b) => a - b);
  const T = Math.max(0.06, sorted[Math.floor(sorted.length * 0.86)]);
  const vE = new Uint8Array(W * H), hE = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (mag[i] < T) continue;
    const ax = Math.abs(gxA[i]), ay = Math.abs(gyA[i]);
    if (ax > ay * 1.4) vE[i] = 1;
    else if (ay > ax * 1.4) hE[i] = 1;
  }
  const vr = runs(vE, W, W, H, Math.round(H * 0.07), 'y');
  const hr = runs(hE, W, H, W, Math.round(W * 0.06), 'x');

  const hSupport = (y, x0, x1) => {
    let best = null;
    for (const r of hr) {
      if (Math.abs(r.p - y) > 5) continue;
      const ov = Math.min(r.b, x1) - Math.max(r.a, x0);
      if (ov >= (x1 - x0) * 0.55 && (!best || Math.abs(r.p - y) < Math.abs(best.p - y))) best = r;
    }
    return best;
  };

  const cands = [];
  for (let i = 0; i < vr.length; i++) for (let j = 0; j < vr.length; j++) {
    const a = vr[i], b = vr[j];
    const dx = b.p - a.p;
    if (dx < W * 0.07 || dx > W * 0.75) continue;
    const y0 = Math.max(a.a, b.a), y1 = Math.min(a.b, b.b);
    const ov = y1 - y0;
    if (ov < H * 0.07 || ov < Math.min(a.b - a.a, b.b - b.a) * 0.55) continue;
    const top = hSupport(y0, a.p, b.p), bot = hSupport(y1, a.p, b.p);
    // two long parallel uprights reaching low in the frame are a door frame even without a lintel
    const doorish = ov > H * 0.38 && ov / dx > 1.5 && y1 > H * 0.68;
    if (!top && !bot && !doorish) continue;
    const ry0 = top ? top.p : y0, ry1 = bot ? bot.p : y1;
    cands.push({ x: a.p, y: ry0, w: dx, h: ry1 - ry0, top: !!top, bot: !!bot, score: ov / H + (top ? 0.3 : 0) + (bot ? 0.3 : 0) + (doorish ? 0.2 : 0) });
  }
  cands.sort((p, q) => q.score - p.score);
  const picked = [];
  for (const c of cands) {
    if (picked.some((p) => iou(p, c) > 0.3 || contains(p, c) || contains(c, p))) continue;
    picked.push(c);
    if (picked.length >= 8) break;
  }

  const out = [];
  for (const c of picked) {
    const aspect = c.h / c.w;
    const area = (c.w * c.h) / (W * H);
    const bottom = (c.y + c.h) / H;
    const ix = c.w * 0.15, iy = c.h * 0.15;
    const inner = meanIn(g, H, c.x + ix, c.y + iy, c.x + c.w - ix, c.y + c.h - iy);
    const bw = c.w * 0.15;
    const outer = (meanIn(g, H, c.x - bw, c.y, c.x, c.y + c.h) + meanIn(g, H, c.x + c.w, c.y, c.x + c.w + bw, c.y + c.h)) / 2;
    let kind = null;
    if (c.h >= H * 0.38 && aspect > 1.6 && aspect < 3.9 && bottom > 0.68) kind = 'door';
    else if (inner - outer > 0.12 && aspect > 0.45 && aspect < 2.6 && c.y < H * 0.55) kind = 'window';
    else if (c.top && c.bot && aspect > 0.4 && aspect < 3 && area > 0.008 && area < 0.4 && bottom < 0.93) kind = 'panel';
    if (!kind) continue;
    const k = w / W;
    out.push({ kind, x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k, score: c.score });
  }
  return out;
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i);
}
function contains(a, b) {
  return b.x >= a.x - 2 && b.y >= a.y - 2 && b.x + b.w <= a.x + a.w + 2 && b.y + b.h <= a.y + a.h + 2;
}
