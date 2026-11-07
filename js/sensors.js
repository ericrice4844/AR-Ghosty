// Camera, flashlight, light meter, motion/compass and GPS.
import { viewFromDeviceOrientation, viewFromYawPitch, yawRotate, viewForward, azElFromDir } from './world.js';
import { angDiff, clamp } from './util.js';

export const sensors = {
  video: null,
  stream: null,
  track: null,
  torchSupported: false,
  torchOn: false,
  light: { overall: 0.5, center: 0.5, edge: 0.5, ready: false },
  orient: { alpha: null, beta: null, gamma: null, absolute: false, compass: null, last: 0 },
  manual: { yaw: 0, pitch: 0, active: false },
  yawOffset: null,
  geo: null,
  geoError: null,
  _sampler: null,
};

// ---- camera ------------------------------------------------------------------
export async function startCamera(videoEl) {
  sensors.video = videoEl;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API not available (the page must be served over HTTPS).');
  const tries = [
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { video: { facingMode: { ideal: 'environment' } } },
    { video: true },
  ];
  let lastErr;
  for (const c of tries) {
    try {
      sensors.stream = await navigator.mediaDevices.getUserMedia({ ...c, audio: false });
      break;
    } catch (e) { lastErr = e; if (e.name === 'NotAllowedError') break; }
  }
  if (!sensors.stream) throw lastErr;
  videoEl.srcObject = sensors.stream;
  videoEl.setAttribute('playsinline', '');
  videoEl.muted = true;
  await videoEl.play().catch(() => {});
  sensors.track = sensors.stream.getVideoTracks()[0];
  // Torch capability is often only reported after the track has started.
  await new Promise((r) => setTimeout(r, 400));
  try {
    const caps = sensors.track.getCapabilities?.() || {};
    sensors.torchSupported = !!caps.torch;
  } catch { sensors.torchSupported = false; }
  startLightMeter();
  return sensors.stream;
}

export function stopCamera() {
  clearInterval(sensors._sampler);
  sensors._sampler = null;
  if (sensors.stream) for (const t of sensors.stream.getTracks()) t.stop();
  sensors.stream = null;
  sensors.track = null;
  sensors.torchOn = false;
  sensors.light.ready = false;
}

export async function setTorch(on) {
  if (!sensors.torchSupported || !sensors.track) return false;
  try {
    await sensors.track.applyConstraints({ advanced: [{ torch: on }] });
    sensors.torchOn = on;
    return true;
  } catch {
    return false;
  }
}

// Samples the camera feed a few times a second. In a dark room with only the
// flashlight on, the edges of the frame stay dark even though the centre is
// lit — that's what "dark enough" checks.
function startLightMeter() {
  const c = document.createElement('canvas');
  c.width = 48; c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true });
  clearInterval(sensors._sampler);
  sensors._sampler = setInterval(() => {
    const v = sensors.video;
    if (!v || v.readyState < 2) return;
    try { g.drawImage(v, 0, 0, 48, 64); } catch { return; }
    const d = g.getImageData(0, 0, 48, 64).data;
    let all = 0, cen = 0, edge = 0, nc = 0, ne = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 48; x++) {
        const i = (y * 48 + x) * 4;
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        all += l;
        const dx = (x - 24) / 24, dy = (y - 32) / 32;
        const r = dx * dx + dy * dy;
        if (r < 0.2) { cen += l; nc++; } else if (r > 0.55) { edge += l; ne++; }
      }
    }
    const L = sensors.light;
    const k = L.ready ? 0.35 : 1;
    L.overall += (all / (48 * 64) - L.overall) * k;
    L.center += (cen / nc - L.center) * k;
    L.edge += (edge / ne - L.edge) * k;
    L.ready = true;
  }, 250);
}

// Darkness 0 (bright) .. 1 (pitch black), weighted toward the frame edges.
export function darkness(cal) {
  const L = sensors.light;
  if (!L.ready) return 0;
  const lum = L.edge * 0.75 + L.overall * 0.25;
  const bright = cal?.bright ?? 0.45;
  const dark = cal?.dark ?? 0.08;
  return clamp(1 - (lum - dark) / Math.max(0.05, bright - dark), 0, 1);
}

// ---- motion -------------------------------------------------------------------
export async function requestMotionPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      const r = await DOE.requestPermission();
      return r === 'granted';
    } catch { return false; }
  }
  return !!DOE;
}

let orientBound = false;
export function startOrientation() {
  if (orientBound) return;
  orientBound = true;
  const handle = (absolute) => (e) => {
    if (e.alpha == null && e.beta == null) return;
    if (!absolute && sensors.orient.absolute && performance.now() - sensors.orient.last < 500) return;
    const o = sensors.orient;
    o.alpha = e.alpha ?? 0;
    o.beta = e.beta ?? 0;
    o.gamma = e.gamma ?? 0;
    o.absolute = absolute || e.absolute === true;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) o.compass = e.webkitCompassHeading;
    o.last = performance.now();
  };
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handle(true));
  window.addEventListener('deviceorientation', handle(false));
}

export const hasMotion = () => sensors.orient.last > 0 && performance.now() - sensors.orient.last < 2000;

function screenAngle() {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return typeof a === 'number' ? a : 0;
}

// The current view matrix (see world.js).
export function currentView(dt = 0.016) {
  if (hasMotion() && !sensors.manual.active) {
    const o = sensors.orient;
    let M = viewFromDeviceOrientation(o.alpha, o.beta, o.gamma, screenAngle());
    if (!o.absolute && o.compass != null) {
      // iOS: alpha is relative, so steer it toward the compass heading.
      const yaw = azElFromDir(viewForward(M)).az;
      const want = angDiff(o.compass, yaw);
      sensors.yawOffset = sensors.yawOffset == null ? want : sensors.yawOffset + angDiff(want, sensors.yawOffset) * Math.min(1, dt * 0.8);
      M = yawRotate(M, sensors.yawOffset);
    }
    return M;
  }
  return viewFromYawPitch(sensors.manual.yaw, sensors.manual.pitch);
}

// Drag-to-look for desktops and phones without motion sensors.
export function bindManualLook(target) {
  let down = null;
  target.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, moved: 0 }; });
  window.addEventListener('pointermove', (e) => {
    if (!down || hasMotion()) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    down.moved += Math.abs(dx) + Math.abs(dy);
    down.x = e.clientX; down.y = e.clientY;
    sensors.manual.active = true;
    sensors.manual.yaw = (sensors.manual.yaw - dx * 0.25 + 360) % 360;
    sensors.manual.pitch = clamp(sensors.manual.pitch + dy * 0.2, -60, 60);
  });
  window.addEventListener('pointerup', () => { down = null; });
  window.addEventListener('keydown', (e) => {
    const m = sensors.manual;
    const step = { ArrowLeft: [-6, 0], ArrowRight: [6, 0], ArrowUp: [0, 4], ArrowDown: [0, -4] }[e.key];
    if (!step) return;
    m.active = true;
    m.yaw = (m.yaw + step[0] + 360) % 360;
    m.pitch = clamp(m.pitch + step[1], -60, 60);
  });
  return () => down && down.moved > 12; // "was that a drag?" for tap handling
}

// ---- GPS -----------------------------------------------------------------------
let geoWatch = null;
export function startGeo(onUpdate) {
  if (!navigator.geolocation) { sensors.geoError = 'Geolocation not supported'; return false; }
  if (geoWatch != null) return true;
  geoWatch = navigator.geolocation.watchPosition(
    (p) => {
      sensors.geo = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp };
      sensors.geoError = null;
      onUpdate && onUpdate(sensors.geo);
    },
    (err) => { sensors.geoError = err.message || 'Location unavailable'; onUpdate && onUpdate(null); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  return true;
}

// ---- headphones -------------------------------------------------------------------
// Browsers only reveal device labels after a media permission is granted, and
// many only list the default output. A positive match here is a strong hint;
// the in-app left/right knock test is the real check.
export async function detectHeadphones() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const re = /headphone|headset|earbud|earphone|airpods|buds|bluetooth|hands-?free|wired|beats|bose|sony wh|jabra/i;
    return devs.some((d) => (d.kind === 'audiooutput' || d.kind === 'audioinput') && re.test(d.label));
  } catch {
    return false;
  }
}

