// Geography (where haunts are) and view math (where the phone is pointing).
import { hashStr, rng, DEG, norm360 } from './util.js';
import { GHOSTS, pickGhostType } from './ghosts.js';

const R_EARTH = 6371000;

export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return norm360(Math.atan2(y, x) / DEG);
}

export function compassName(deg) {
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[Math.round(norm360(deg) / 45) % 8];
}

const CELL = 0.0025; // ~250 m grid cells
// The dead move on. Haunts reshuffle every 3 hours.
export const timeSlot = (ts = Date.now()) => Math.floor(ts / (3 * 3600 * 1000));

function isNight(ts = Date.now()) {
  const h = new Date(ts).getHours();
  return h >= 20 || h < 6;
}

// Deterministic haunts around a position: everyone standing in the same
// place at the same time sees the same ghosts.
export function hauntsNear(lat, lon, ts = Date.now()) {
  const slot = timeSlot(ts);
  const cx = Math.floor(lat / CELL);
  const cy = Math.floor(lon / CELL);
  const night = isNight(ts);
  const out = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const r = rng(hashStr(`${cx + i}:${cy + j}:${slot}`));
      const n = r.int(1, night ? 4 : 2);
      for (let k = 0; k < n; k++) {
        const hLat = (cx + i + r()) * CELL;
        const hLon = (cy + j + r()) * CELL;
        const type = pickGhostType(r, night);
        out.push({
          id: `${cx + i}:${cy + j}:${slot}:${k}`,
          type,
          lat: hLat,
          lon: hLon,
          dist: distanceM(lat, lon, hLat, hLon),
          bearing: bearingDeg(lat, lon, hLat, hLon),
          strength: r.range(0.4, 1),
        });
      }
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

export const HAUNT_RANGE_M = 70;

// ---------------------------------------------------------------------------
// View math. World frame is East-North-Up. A view is a 3x3 matrix whose
// columns are the screen's right / up / out-of-screen axes in world coords.
// The back camera looks along -out.

export function dirFromAzEl(az, el) {
  const a = az * DEG, e = el * DEG;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

export function azElFromDir(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return { az: norm360(Math.atan2(v[0], v[1]) / DEG), el: Math.asin(v[2] / len) / DEG };
}

// W3C DeviceOrientation: R = Rz(alpha) * Rx(beta) * Ry(gamma); then account for
// the screen being rotated relative to the device body.
export function viewFromDeviceOrientation(alpha, beta, gamma, screenAngle = 0) {
  const a = alpha * DEG, b = beta * DEG, g = gamma * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // Row-major R
  const R = [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
  const t = screenAngle * DEG, ct = Math.cos(t), st = Math.sin(t);
  const Rz = [[ct, -st, 0], [st, ct, 0], [0, 0, 1]];
  return matMul(R, Rz);
}

export function viewFromYawPitch(yaw, pitch) {
  const y = yaw * DEG, p = pitch * DEG;
  const fwd = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
  const right = [Math.cos(y), -Math.sin(y), 0];
  const up = cross(right, fwd);
  return [
    [right[0], up[0], -fwd[0]],
    [right[1], up[1], -fwd[1]],
    [right[2], up[2], -fwd[2]],
  ];
}

// Rotate a view around world-up (used to correct compass drift).
export function yawRotate(M, deg) {
  const t = -deg * DEG, c = Math.cos(t), s = Math.sin(t);
  const Z = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  return matMul(Z, M);
}

function matMul(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return C;
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function viewForward(M) {
  return [-M[0][2], -M[1][2], -M[2][2]];
}

// Project a world direction to the screen. Returns null when behind the camera.
export function project(M, v, w, h, focal) {
  const sx = M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2];
  const sy = M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2];
  const sz = M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2];
  if (sz > -0.05) return null;
  return { x: w / 2 + (focal * sx) / -sz, y: h / 2 - (focal * sy) / -sz, depth: -sz };
}

// Screen point -> world direction.
export function unproject(M, px, py, w, h, focal) {
  const s = [px - w / 2, -(py - h / 2), -focal];
  const v = [
    M[0][0] * s[0] + M[0][1] * s[1] + M[0][2] * s[2],
    M[1][0] * s[0] + M[1][1] * s[1] + M[1][2] * s[2],
    M[2][0] * s[0] + M[2][1] * s[1] + M[2][2] * s[2],
  ];
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}

export function angleBetween(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
}

export { GHOSTS };
