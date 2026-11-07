// Finds real things in the camera image for ghosts to come out of.
// Uses the COCO-SSD object detector (loaded on demand from a CDN) and falls
// back to "the darkest patch of the frame" when that isn't available.

const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js';
const COCO = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

let model = null;
let loading = null;
let failed = false;
let busy = false;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.append(s);
  });
}

export function loadDetector() {
  if (model || failed) return Promise.resolve(model);
  if (!loading) {
    loading = (async () => {
      try {
        if (!window.tf) await loadScript(TFJS);
        if (!window.cocoSsd) await loadScript(COCO);
        model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
      } catch (e) {
        console.warn('[detect] object detection unavailable, using shadows instead', e);
        failed = true;
      }
      return model;
    })();
  }
  return loading;
}

export const detectorState = () => (model ? 'ready' : failed ? 'unavailable' : loading ? 'loading' : 'idle');

const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

// Draws the video exactly as it's displayed (object-fit: cover) so boxes are
// in screen coordinates.
function grabCover(video, w, h, scale) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return false;
  work.width = Math.round(w * scale);
  work.height = Math.round(h * scale);
  const s = Math.max(w / vw, h / vh);
  const dw = vw * s * scale, dh = vh * s * scale;
  wctx.drawImage(video, (work.width - dw) / 2, (work.height - dh) / 2, dw, dh);
  return true;
}

// Returns boxes in screen pixels: [{ cls, x, y, w, h, score }]
export async function findObjects(video, w, h, prefer = []) {
  if (busy) return null;
  busy = true;
  try {
    const scale = Math.min(1, 320 / Math.max(w, h));
    if (!grabCover(video, w, h, scale)) return [];
    const out = [];
    if (model) {
      const preds = await model.detect(work, 10, 0.35);
      for (const p of preds) {
        const [x, y, bw, bh] = p.bbox;
        out.push({ cls: p.class, x: x / scale, y: y / scale, w: bw / scale, h: bh / scale, score: p.score + (prefer.includes(p.class) ? 1 : 0) });
      }
    }
    if (!out.some((o) => prefer.includes(o.cls))) {
      const s = darkestPatch(scale);
      if (s) out.push({ ...s, cls: 'shadow', score: 0.5 });
    }
    return out.sort((a, b) => b.score - a.score);
  } catch (e) {
    console.warn('[detect]', e);
    return [];
  } finally {
    busy = false;
  }
}

function darkestPatch(scale) {
  const W = work.width, H = work.height;
  const gw = 8, gh = 12;
  const cw = W / gw, ch = H / gh;
  const d = wctx.getImageData(0, 0, W, H).data;
  const cells = new Float32Array(gw * gh);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      cells[Math.min(gh - 1, Math.floor(y / ch)) * gw + Math.min(gw - 1, Math.floor(x / cw))] += l;
    }
  }
  let best = Infinity, bx = 0, by = 0;
  // 3x2 windows, avoiding the very top of the frame (ghosts climb up and out)
  for (let y = 3; y < gh - 2; y++) {
    for (let x = 0; x < gw - 2; x++) {
      let s = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) s += cells[(y + j) * gw + x + i];
      // favour the middle of the screen a little
      s *= 1 + Math.abs(x + 1.5 - gw / 2) * 0.08;
      if (s < best) { best = s; bx = x; by = y; }
    }
  }
  return { x: (bx * cw) / scale, y: (by * ch) / scale, w: (3 * cw) / scale, h: (2 * ch) / scale };
}
