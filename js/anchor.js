// Where a ghost should stand, given what the camera can see.
//
// Ghosts are placed against real objects found by the detector: beside the
// bed, behind the couch (with the couch hiding their legs), peeking around the
// fridge, behind a person in the room. The object's known real-world size gives
// the scale, and its bottom edge gives the floor, so the ghost stands on the
// floor at the right size instead of floating somewhere random.
import { clamp, rand } from './util.js';

// Typical real sizes: [height m, width m, which dimension to trust, touches floor]
const OBJ = {
  person: [1.7, 0.5, 'h', true],
  chair: [0.9, 0.5, 'h', true],
  couch: [0.85, 1.9, 'w', true],
  bed: [0.65, 1.6, 'w', true],
  'dining table': [0.75, 1.3, 'w', true],
  refrigerator: [1.75, 0.75, 'h', true],
  toilet: [0.75, 0.45, 'h', true],
  bench: [0.5, 1.3, 'w', true],
  'potted plant': [0.7, 0.45, 'h', true],
  suitcase: [0.65, 0.45, 'h', true],
  oven: [0.9, 0.6, 'h', true],
  tv: [0.6, 1.1, 'w', false],
};

// Fraction of a detected box (from its top) above the part that hides what's behind it.
const OCCLUDE_FROM = { bed: 0.4, 'dining table': 0.3, couch: 0.2, chair: 0.25, bench: 0.2 };

// How each ghost likes to place itself. `width` is its body width / height.
export const ANCHOR = {
  lantern: { modes: ['hover'], on: ['dining table', 'bed', 'couch', 'chair', 'tv', 'potted plant'], width: 0.5 },
  wren: { modes: ['beside', 'behind'], on: ['bed', 'couch', 'chair', 'dining table', 'toilet', 'suitcase'], width: 0.4 },
  weeper: { modes: ['beside'], on: ['bed', 'couch', 'dining table', 'chair', 'toilet', 'refrigerator', 'oven'], width: 0.62 },
  hollow: { modes: ['behind', 'beside'], on: ['person', 'refrigerator', 'couch', 'bed', 'chair', 'dining table'], width: 0.22 },
  mimic: { modes: ['behind', 'beside'], on: ['person', 'couch', 'bed', 'chair', 'dining table'], width: 0.36 },
  grinner: { modes: ['peek', 'behind'], on: ['refrigerator', 'person', 'couch', 'bed', 'chair', 'dining table'], width: 0.32 },
};

// What to say once something has taken its place.
export const PLACE_TEXT = {
  beside: (c) => `Something is crouched beside the ${c}.`,
  behind: (c) => (c === 'person' ? 'Something is standing right behind them.' : `Something is standing behind the ${c}.`),
  peek: (c) => (c === 'person' ? 'Something is looking over their shoulder.' : `Something is peeking out from behind the ${c}.`),
  hover: (c) => `A light hangs over the ${c}.`,
};

function pxPerMetre(o) {
  const spec = OBJ[o.cls];
  if (!spec) return null;
  const [H, W, trust] = spec;
  const byH = o.h / H, byW = o.w / W;
  // Trust the reliable dimension, nudged a little by the other.
  return trust === 'h' ? byH * 0.8 + byW * 0.2 : byW * 0.8 + byH * 0.2;
}

// objs: detector boxes in screen px. view: { w, h, nearX }
// Returns { kind, cls, x, footY, size, exclude: [rects] } or a { kind: 'dark', x } fallback.
export function placeGhost(type, heightM, objs, view) {
  const A = ANCHOR[type];
  const { w, h } = view;
  const nearX = view.nearX ?? w / 2;
  const shadow = objs.find((o) => o.cls === 'shadow');
  if (!A) return { kind: 'dark', x: shadow ? shadow.x + shadow.w / 2 : nearX };

  const cands = objs
    .filter((o) => A.on.includes(o.cls) && OBJ[o.cls] && o.w > w * 0.06 && o.h > h * 0.05)
    // the most confident ones, nearest to where the hints said it was
    .map((o) => ({ o, score: o.score - Math.abs(o.x + o.w / 2 - nearX) / w * 0.6 + (o.cls === 'person' ? 0.3 : 0) }))
    .sort((a, b) => b.score - a.score)
    .map((c) => c.o);

  for (const o of cands) {
    const ppm = pxPerMetre(o);
    if (!ppm) continue;
    const size = heightM * ppm;
    if (size < h * 0.12 || size > h * 1.6) continue;
    const gw = size * A.width;
    const floorY = o.y + o.h;
    const touchesFloor = OBJ[o.cls][3];
    const modes = o.cls === 'person' ? ['behind'] : A.modes;

    for (const mode of modes) {
      if (mode === 'hover') {
        const footY = o.y - size * 0.15;
        if (footY - size < -size * 0.2) continue;
        return { kind: 'hover', cls: o.cls, x: o.x + o.w / 2, footY, size, exclude: [] };
      }
      if (mode === 'beside' && touchesFloor) {
        const sides = [
          { x: o.x - gw * 0.55, room: o.x },
          { x: o.x + o.w + gw * 0.55, room: w - (o.x + o.w) },
        ].filter((s) => s.x > gw * 0.35 && s.x < w - gw * 0.35);
        if (!sides.length) continue;
        sides.sort((a, b) => b.room - a.room + (rand() - 0.5) * w * 0.2);
        // a touch further back than the object's front edge
        if (floorY - o.h * 0.06 - size * 0.97 < h * 0.02) continue;
        return { kind: 'beside', cls: o.cls, x: sides[0].x, footY: floorY - o.h * 0.06, size: size * 0.97, exclude: [] };
      }
      if (mode === 'behind') {
        if (o.cls === 'person') {
          // over their shoulder: taller than them, offset, hidden where they are
          const side = o.x + o.w / 2 < w / 2 ? 1 : -1;
          const x = o.x + o.w / 2 + side * o.w * 0.45;
          return { kind: 'behind', cls: o.cls, x, footY: floorY - o.h * 0.05, size: size * 0.95, exclude: [inset(o, 0.08)] };
        }
        const footY = floorY - o.h * 0.4;
        const sz = size * 0.9;
        const top = footY - sz;
        // Only the front of the furniture hides it. Deep things (beds, tables)
        // have a lot of box above the part that actually blocks the view.
        const occTop = o.y + o.h * (OCCLUDE_FROM[o.cls] ?? 0.12);
        // a decent part must show above it, and its head must be on screen
        if (occTop - top < sz * 0.3 || top < h * 0.02) continue;
        const x = o.x + o.w * (0.3 + rand() * 0.4);
        return { kind: 'behind', cls: o.cls, x, footY, size: sz, exclude: [{ x: o.x - 4, y: occTop, w: o.w + 8, h: floorY - occTop + 10 }] };
      }
      if (mode === 'peek') {
        // half hidden behind an edge
        const left = o.x + o.w / 2 > nearX;
        const x = left ? o.x + gw * 0.15 : o.x + o.w - gw * 0.15;
        const footY = floorY - o.h * 0.05;
        return { kind: 'peek', cls: o.cls, x, footY, size: size * 0.97, exclude: [inset(o, 0.03)] };
      }
    }
  }
  // Nothing suitable: stand in the darkest part of the room, on the floor.
  return { kind: 'dark', x: shadow ? shadow.x + shadow.w / 2 : clamp(nearX, w * 0.2, w * 0.8) };
}

function inset(o, k) {
  return { x: o.x + o.w * k, y: o.y + o.h * k * 0.5, w: o.w * (1 - 2 * k), h: o.h * (1 - k * 0.5) + 6 };
}
