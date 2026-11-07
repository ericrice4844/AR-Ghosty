// Talking to the dead: microphone level, speech recognition (with a typed
// fallback), recording your voice for the Mimic, and ghost speech output.
import { audio } from './audio.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canRecognize = !!SR;
export const canSpeak = 'speechSynthesis' in window;

export const mic = {
  stream: null,
  analyser: null,
  level: 0, // smoothed RMS 0..1
  peak: 0, // peak during the current utterance
  ok: false,
};

export async function startMic() {
  if (mic.stream) return true;
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    const ctx = audio.init();
    const src = ctx.createMediaStreamSource(mic.stream);
    mic.analyser = ctx.createAnalyser();
    mic.analyser.fftSize = 1024;
    src.connect(mic.analyser);
    mic.buf = new Float32Array(mic.analyser.fftSize);
    mic.ok = true;
    return true;
  } catch {
    mic.ok = false;
    return false;
  }
}

export function stopMic() {
  if (mic.stream) for (const t of mic.stream.getTracks()) t.stop();
  mic.stream = null;
  mic.analyser = null;
  mic.ok = false;
}

export function sampleMic() {
  if (!mic.analyser) return 0;
  mic.analyser.getFloatTimeDomainData(mic.buf);
  let s = 0;
  for (let i = 0; i < mic.buf.length; i++) s += mic.buf[i] * mic.buf[i];
  const rms = Math.min(1, Math.sqrt(s / mic.buf.length) * 4);
  mic.level += (rms - mic.level) * 0.3;
  mic.peak = Math.max(mic.peak, rms);
  return mic.level;
}

// Grab a couple of seconds of whatever the room sounds like right now (the
// Mimic keeps the noises you make).
export function recordSnippet(seconds = 2.5) {
  return new Promise((resolve) => {
    if (!mic.stream || !window.MediaRecorder) { resolve(null); return; }
    let r;
    const parts = [];
    try { r = new MediaRecorder(mic.stream); } catch { resolve(null); return; }
    r.ondataavailable = (e) => e.data.size && parts.push(e.data);
    r.onstop = async () => {
      try { resolve(await audio.ctx.decodeAudioData(await new Blob(parts, { type: r.mimeType }).arrayBuffer())); } catch { resolve(null); }
    };
    r.start();
    setTimeout(() => { try { r.stop(); } catch { resolve(null); } }, seconds * 1000);
  });
}

// ---- listening -------------------------------------------------------------------
let rec = null;
let recorder = null;
let chunks = [];

// Push-to-talk. Resolves with { text, peak, buffer } when listening ends.
export function listen() {
  mic.peak = 0;
  startRecording();
  return new Promise((resolve) => {
    if (!SR) { resolve({ text: '', peak: mic.peak, unsupported: true }); return; }
    let finalText = '';
    let interim = '';
    let done = false;
    const finish = async (err) => {
      if (done) return;
      done = true;
      const buffer = await stopRecording();
      resolve({ text: (finalText || interim).trim(), peak: mic.peak, buffer, error: err });
    };
    try {
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += ' ' + r[0].transcript;
          else interim += ' ' + r[0].transcript;
        }
        listen.onInterim && listen.onInterim((finalText + interim).trim());
      };
      rec.onerror = (e) => finish(e.error);
      rec.onend = () => finish();
      rec.start();
    } catch (e) {
      finish(e.message);
    }
  });
}

export function stopListening() {
  try { rec && rec.stop(); } catch { /* already stopped */ }
}

function startRecording() {
  chunks = [];
  recorder = null;
  if (!mic.stream || !window.MediaRecorder) return;
  try {
    recorder = new MediaRecorder(mic.stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start();
  } catch { recorder = null; }
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') { resolve(null); return; }
    recorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const ab = await blob.arrayBuffer();
        const buf = await audio.ctx.decodeAudioData(ab);
        resolve(buf);
      } catch { resolve(null); }
    };
    try { recorder.stop(); } catch { resolve(null); }
  });
}

// ---- ghost speech -----------------------------------------------------------------
let voices = [];
function loadVoices() { voices = canSpeak ? speechSynthesis.getVoices() : []; }
if (canSpeak) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function pickVoice(pitch) {
  const lang = (navigator.language || 'en').slice(0, 2);
  const local = voices.filter((v) => v.lang && v.lang.startsWith(lang));
  const pool = local.length ? local : voices;
  if (!pool.length) return null;
  const female = /female|samantha|victoria|karen|moira|tessa|fiona|zira|susan|serena/i;
  const male = /male|daniel|alex|fred|david|mark|george|rishi|aaron/i;
  const pref = pitch > 1.2 ? pool.find((v) => female.test(v.name)) : pitch < 0.6 ? pool.find((v) => male.test(v.name)) : null;
  return pref || pool[0];
}

export function speak(text, { pitch = 1, rate = 1, volume = 1 } = {}) {
  return new Promise((resolve) => {
    if (!canSpeak || !audio.enabled) { setTimeout(resolve, 600 + text.length * 45); return; }
    const clean = text.replace(/\*[^*]*\*/g, ' ').trim();
    if (!clean) { setTimeout(resolve, 900); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.pitch = Math.max(0, Math.min(2, pitch));
    u.rate = rate;
    u.volume = volume;
    const v = pickVoice(pitch);
    if (v) u.voice = v;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    u.onend = done;
    u.onerror = done;
    setTimeout(done, 1500 + clean.length * 120);
    speechSynthesis.speak(u);
  });
}

export function hush() {
  if (canSpeak) speechSynthesis.cancel();
}
