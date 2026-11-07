// How much room is there? Estimates the distance to walls and furniture in
// front of you, so a ghost never stands inside a wall.
//
// 1. A small depth model (Depth Anything V2, ~27 MB, loaded on demand) gives
//    relative depth for the camera image: what's nearer, what's further.
// 2. That depth has no units, but the floor does. The phone is about 1.4 m
//    above it, so for any pixel on the floor the tilt of the phone gives its
//    true distance. Fitting the depth map to the floor at the bottom of the
//    frame, then walking up each column until something rises off the floor,
//    tells us how far away the wall (or sofa) is in that direction.

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js';
const MODEL = 'onnx-community/depth-anything-v2-small';
const EYE_H = 1.4;
const MAX_FREE = 8;
const DEG = Math.PI / 180;

let pipe = null, T = null, loading = null, failed = false, busy = false;

export function loadDepth() {
  if (pipe || failed) return Promise.resolve(pipe);
  if (!loading) {
    loading = (async () => {
      try {
        T = await import(TRANSFORMERS);
        T.env.allowLocalModels = false;
        // only use the GPU if there really is one behind navigator.gpu
        let device = 'wasm';
        try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) device = 'webgpu'; } catch { /* no GPU */ }
        pipe = await T.pipeline('depth-estimation', MODEL, { dtype: 'q8', device });
        // a smaller input is plenty for "where is the wall" and much faster
        pipe.processor.image_processor.size = { height: 252, width: 252 };
      } catch (e) {
        console.warn('[depth] unavailable, ghosts will be placed by geometry alone', e);
        failed = true;
      }
      return pipe;
    })();
  }
  return loading;
}

export const depthState = () => (pipe ? 'ready' : failed ? 'unavailable' : loading ? 'loading' : 'idle');

const cv = document.createElement('canvas');
const cx = cv.getContext('2d', { willReadFrequently: true });

// Depth for what's on screen (object-fit: cover), as a grid of gw columns.
// Returns { gw, gh, d } with d = relative inverse depth (bigger = nearer).
export async function depthGrid(video, w, h, gw = 48) {
  if (!pipe || busy) return null;
  const vw = video.videoWidth || video.naturalWidth, vh = video.videoHeight || video.naturalHeight;
  if (!vw || !vh) return null;
  busy = true;
  try {
    const W = 256, H = Math.round((256 * h) / w);
    cv.width = W; cv.height = H;
    const s = Math.max(W / vw, H / vh);
    cx.drawImage(video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
    const out = await pipe(T.RawImage.fromCanvas(cv));
    const pd = out.predicted_depth;
    const [ph, pw] = pd.dims.slice(-2);
    const src = pd.data;
    const gh = Math.round((gw * h) / w);
    const d = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        // average the block of model pixels under this cell
        const x0 = Math.floor((x / gw) * pw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) / gw) * pw));
        const y0 = Math.floor((y / gh) * ph), y1 = Math.max(y0 + 1, Math.floor(((y + 1) / gh) * ph));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += src[yy * pw + xx]; n++; }
        d[y * gw + x] = sum / n;
      }
    }
    return { gw, gh, d };
  } catch (e) {
    console.warn('[depth]', e);
    return null;
  } finally {
    busy = false;
  }
}

// Turn the depth grid into metres of open floor per column.
// view: { w, h, focal, pitch } (pitch in degrees, + is up).
// Returns { floor: bool, free: Float32Array(gw) in metres, ahead: metres straight ahead }
export function roomFromDepth(g, view) {
  const { gw, gh, d } = g;
  const { h, focal, pitch } = view;
  // tan(angle below the horizon) for each row
  const tanDep = new Float32Array(gh);
  for (let y = 0; y < gh; y++) {
    const sy = ((y + 0.5) / gh) * h;
    const el = pitch + Math.atan((h / 2 - sy) / focal) / DEG;
    tanDep[y] = Math.tan(-el * DEG);
  }
  // Fit depth = a * tan + b to the floor near the bottom of the frame. Some of
  // those pixels will be furniture, so fit, throw out the worst, and refit.
  const minTan = Math.tan(6 * DEG);
  const rows = [];
  for (let y = gh - 1; y >= 0 && rows.length < Math.max(4, gh * 0.3); y--) if (tanDep[y] > minTan) rows.push(y);
  const free = new Float32Array(gw).fill(NaN);
  if (rows.length < 3) return { floor: false, free, ahead: NaN };
  let pts = [];
  for (const y of rows) for (let x = 0; x < gw; x++) pts.push([tanDep[y], d[y * gw + x]]);
  let a = 0, b = 0;
  const fit = (P) => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [X, Y] of P) { sx += X; sy += Y; sxx += X * X; sxy += X * Y; }
    const n = P.length;
    a = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
    b = (sy - a * sx) / n;
  };
  fit(pts);
  let mad = 0;
  for (let it = 0; it < 4; it++) {
    const r = pts.map(([X, Y]) => Math.abs(Y - (a * X + b)));
    const sorted = [...r].sort((p, q) => p - q);
    mad = sorted[Math.floor(sorted.length / 2)];
    const keep = pts.filter((_, i) => r[i] <= Math.max(mad * 2, 1e-6));
    if (keep.length < Math.max(8, pts.length * 0.3)) break;
    pts = keep;
    fit(pts);
  }
  if (!(a > 0)) return { floor: false, free, ahead: NaN };
  const tol = Math.max(mad * 1.4826 * 3, a * 0.03);

  // Walk up each column. On the floor, depth keeps changing at the rate the
  // floor fit predicts; where a wall or a piece of furniture rises off the
  // floor, that steady change stops (a wall) or reverses (something nearer).
  for (let x = 0; x < gw; x++) {
    let base = null, run = 0, open = false;
    for (let y = gh - 2; y >= 0; y--) {
      const tdBelow = tanDep[y + 1], td = tanDep[y];
      if (td <= Math.tan(2 * DEG)) { open = run === 0; if (!open && base == null) base = y + 1 + run; break; }
      if (tdBelow <= minTan * 0.5) continue; // too close to the horizon to judge the row below
      const expect = a * (tdBelow - td);
      const got = d[(y + 1) * gw + x] - d[y * gw + x];
      const nearer = d[y * gw + x] - (a * td + b) > tol * 2;
      if (got < expect * 0.35 || nearer) {
        if (++run === 1) base = y + 1;
        if (run >= 2) break;
      } else {
        run = 0;
        base = null;
      }
    }
    if (open || base == null) free[x] = MAX_FREE;
    else free[x] = Math.min(MAX_FREE, EYE_H / Math.max(tanDep[Math.min(gh - 1, base)], 0.01));
  }
  const mid = Array.from(free.slice(Math.floor(gw * 0.35), Math.ceil(gw * 0.65))).sort((p, q) => p - q);
  return { floor: true, free, ahead: mid[Math.floor(mid.length / 2)] };
}

// Open floor (m) in the direction of screen column px.
export function freeAt(room, px, w) {
  if (!room || !room.floor) return NaN;
  const gw = room.free.length;
  const i = Math.max(0, Math.min(gw - 1, Math.floor((px / w) * gw)));
  // be conservative: the nearest obstacle across a small span
  let m = Infinity;
  for (let k = Math.max(0, i - 1); k <= Math.min(gw - 1, i + 1); k++) m = Math.min(m, room.free[k]);
  return m;
}
