// Small shared helpers: seeded randomness, math, angles, DOM.

export function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic PRNG (mulberry32) so haunts at a location are stable.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(lo + next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  return next;
}

export const rand = rng((Date.now() ^ (Math.random() * 1e9)) >>> 0);

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
export const DEG = Math.PI / 180;

// Normalise an angle in degrees to [-180, 180).
export function angDiff(a, b) {
  let d = (a - b) % 360;
  if (d < -180) d += 360;
  if (d >= 180) d -= 360;
  return d;
}
export const norm360 = (a) => ((a % 360) + 360) % 360;

export function smoothAngle(cur, target, rate, dt) {
  return norm360(cur + angDiff(target, cur) * (1 - Math.exp(-rate * dt)));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Turn clean text into something that looks like it came through static.
export function corruptText(text, amount = 0.08, r = Math.random) {
  const glyphs = '̷̸̶̵̴̡̢̛̖̗̘̙̜̝̞̟̠̣̤̥̦̩̪̫̬̭̮̯̰̱̲̳';
  let out = '';
  for (const ch of text) {
    out += ch;
    if (ch !== ' ' && r() < amount) out += glyphs[Math.floor(r() * glyphs.length)];
  }
  return out;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function vibrate(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* unsupported */ }
}
