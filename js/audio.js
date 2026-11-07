// Procedural audio. Nothing is a sample file: every sob, whisper and scream is
// synthesized, so each one is a little different. Ghost sounds are placed in
// 3D with HRTF panning, which is what makes headphone-only ghosts findable.
import { rand, DEG } from './util.js';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.9;
  }

  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(3.2, 2.6);
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 0.55;
    this.reverbIn.connect(this.reverb).connect(this.master);

    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.distCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      this.distCurve[i] = Math.tanh(x * 4);
    }
    return ctx;
  }

  async unlock() {
    this.init();
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* needs gesture */ }
    }
    return this.ctx && this.ctx.state === 'running';
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  now() { return this.ctx.currentTime; }

  _noiseSrc(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.1);
    return s;
  }

  _env(g, t, a, peak, hold, r) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    g.gain.setValueAtTime(Math.max(peak, 0.0002), t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + r);
  }

  _bp(freq, q) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  _filt(type, freq, q = 0.7) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  // ---- spatial voices --------------------------------------------------------
  makeVoice() {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.2;
    panner.rolloffFactor = 1;
    input.connect(panner).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.45;
    input.connect(send).connect(this.reverbIn);
    return { input, panner, send };
  }

  // rel: degrees relative to where the phone faces (+ right), el: degrees up.
  placeVoice(v, rel, el, dist) {
    const x = Math.sin(rel * DEG) * Math.cos(el * DEG) * dist;
    const z = -Math.cos(rel * DEG) * Math.cos(el * DEG) * dist;
    const y = Math.sin(el * DEG) * dist;
    const p = v.panner;
    if (p.positionX) {
      const t = this.ctx.currentTime;
      p.positionX.setTargetAtTime(x, t, 0.05);
      p.positionY.setTargetAtTime(y, t, 0.05);
      p.positionZ.setTargetAtTime(z, t, 0.05);
    } else {
      p.setPosition(x, y, z);
    }
  }

  dropVoice(v) {
    try { v.input.disconnect(); v.panner.disconnect(); v.send.disconnect(); } catch { /* already gone */ }
  }

  // ---- ghost sounds ---------------------------------------------------------
  // Each returns the duration in seconds.

  sob(dest, intensity = 1) {
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.05;
    const out = ctx.createGain();
    out.gain.value = 0.9 * intensity;
    out.connect(dest);

    // ragged inhale
    const inh = this._noiseSrc(t, 0.5);
    const inhF = this._bp(1600, 1.2);
    inhF.frequency.setValueAtTime(900, t);
    inhF.frequency.linearRampToValueAtTime(2600, t + 0.4);
    const inhG = ctx.createGain();
    this._env(inhG, t, 0.25, 0.22, 0.05, 0.12);
    inh.connect(inhF).connect(inhG).connect(out);
    t += 0.5;

    const pulses = rand.int(3, 6);
    const f0 = rand.range(330, 430);
    for (let i = 0; i < pulses; i++) this._voiced(out, t + i * rand.range(0.2, 0.3), f0 * (1 - i * 0.03), rand.range(0.13, 0.2), 0.5, 'u');
    t += pulses * 0.27;

    if (rand.chance(0.6)) {
      // the long, keening wail
      const dur = rand.range(1.1, 2);
      this._voiced(out, t + 0.1, f0 * 1.15, dur, 0.55, 'a', { fall: 0.7, vib: 7, vibDepth: 18 });
      t += dur + 0.3;
    }
    // sniffle
    for (let i = 0; i < 2; i++) {
      const s = this._noiseSrc(t, 0.2);
      const hp = this._filt('highpass', 3200);
      const g = ctx.createGain();
      this._env(g, t, 0.02, 0.12, 0.04, 0.06);
      s.connect(hp).connect(g).connect(out);
      t += 0.18;
    }
    return t - ctx.currentTime;
  }

  // A crude vowel: saw + noise through two formant filters.
  _voiced(dest, t, freq, dur, peak, vowel = 'a', o = {}) {
    const ctx = this.ctx;
    const F = { a: [800, 1200], u: [450, 900], e: [500, 2300], i: [300, 2600], m: [250, 900] }[vowel];
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * (o.fall ?? 0.85), t + dur);
    if (o.vib) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.vib;
      const lg = ctx.createGain();
      lg.gain.value = o.vibDepth ?? 10;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.2);
    }
    const breath = this._noiseSrc(t, dur);
    const bg = ctx.createGain();
    bg.gain.value = o.breath ?? 0.35;
    const mix = ctx.createGain();
    osc.connect(mix);
    breath.connect(bg).connect(mix);
    const g = ctx.createGain();
    this._env(g, t, Math.min(0.05, dur * 0.2), peak, dur * 0.5, dur * 0.4);
    for (const f of F) {
      const bp = this._bp(f * (o.formantShift ?? 1), 6);
      mix.connect(bp).connect(g);
    }
    g.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }

  hum(dest) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    // A small, sad, slightly-wrong lullaby.
    const tune = [[0, 0.6], [3, 0.6], [7, 0.9], [5, 0.45], [3, 0.45], [2, 0.9], [0, 0.6], [-2, 0.6], [-5, 1.4]];
    const base = 523.25 * Math.pow(2, rand.int(-2, 1) / 12);
    const out = ctx.createGain();
    out.gain.value = 0.22;
    const lp = this._filt('lowpass', 1100);
    out.connect(lp).connect(dest);
    let t = t0;
    for (const [semi, dur] of tune) {
      const f = base * Math.pow(2, (semi + rand.range(-0.25, 0.25)) / 12);
      for (const [type, mul, amp] of [['triangle', 1, 0.6], ['sine', 2, 0.15]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mul;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5.5;
        const lg = ctx.createGain();
        lg.gain.value = f * 0.012;
        lfo.connect(lg).connect(o.frequency);
        const g = ctx.createGain();
        this._env(g, t, 0.08, amp, dur * 0.6, dur * 0.5);
        o.connect(g).connect(out);
        o.start(t); lfo.start(t);
        o.stop(t + dur + 0.6); lfo.stop(t + dur + 0.6);
      }
      t += dur;
    }
    return t - t0;
  }

  giggle(dest, deep = false) {
    const t0 = this.ctx.currentTime + 0.05;
    const n = rand.int(4, 7);
    let f = deep ? rand.range(260, 320) : rand.range(620, 820);
    let t = t0;
    for (let i = 0; i < n; i++) {
      this._voiced(dest, t, f, 0.09, 0.5, deep ? 'e' : 'i', { fall: 0.92, breath: 0.6 });
      t += rand.range(0.12, 0.17);
      f *= 0.96;
    }
    return t - t0;
  }

  whisper(dest, dur = rand.range(1.4, 2.6)) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const src = this._noiseSrc(t0, dur);
    const hp = this._filt('highpass', 900);
    const bp = this._bp(2400, 2.5);
    const amp = ctx.createGain();
    amp.gain.value = 0.0001;
    src.connect(hp).connect(bp).connect(amp).connect(dest);
    let t = t0;
    while (t < t0 + dur) {
      const syl = rand.range(0.07, 0.2);
      bp.frequency.setValueAtTime(rand.range(1400, 4200), t);
      amp.gain.setTargetAtTime(rand.range(0.3, 0.9), t, 0.02);
      amp.gain.setTargetAtTime(0.0001, t + syl, 0.03);
      t += syl + rand.range(0.02, 0.12);
    }
    return dur;
  }

  groan(dest) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const dur = rand.range(2.2, 3.4);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = rand.range(48, 66);
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * 1.2, t + dur * 0.3);
    o.frequency.linearRampToValueAtTime(f * 0.75, t + dur);
    const sub = ctx.createOscillator();
    sub.frequency.value = f / 2;
    const lp = this._filt('lowpass', 380, 4);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rand.range(0.8, 2);
    const lg = ctx.createGain();
    lg.gain.value = 180;
    lfo.connect(lg).connect(lp.frequency);
    const sh = ctx.createWaveShaper();
    sh.curve = this.distCurve;
    const g = ctx.createGain();
    this._env(g, t, 0.6, 0.5, dur * 0.5, dur * 0.4);
    o.connect(sh).connect(lp);
    sub.connect(lp);
    lp.connect(g).connect(dest);
    for (const n of [o, sub, lfo]) { n.start(t); n.stop(t + dur + 0.2); }
    // a few knuckle-cracks
    if (rand.chance(0.5)) this.skitter(dest, 4, 0.6);
    return dur;
  }

  drip(dest) {
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.05;
    const n = rand.int(2, 5);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      const f = rand.range(900, 1700);
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.35, t + 0.07);
      const g = ctx.createGain();
      this._env(g, t, 0.003, 0.35, 0.01, 0.08);
      o.connect(g).connect(dest);
      o.start(t); o.stop(t + 0.15);
      t += rand.range(0.25, 0.9);
    }
    return t - ctx.currentTime;
  }

  gurgle(dest) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const dur = rand.range(1, 1.8);
    const src = this._noiseSrc(t, dur);
    const lp = this._filt('lowpass', 420, 8);
    const am = ctx.createGain();
    am.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = rand.range(9, 16);
    const lg = ctx.createGain();
    lg.gain.value = 0.6;
    lfo.connect(lg).connect(am.gain);
    const g = ctx.createGain();
    this._env(g, t, 0.15, 0.9, dur * 0.6, dur * 0.3);
    src.connect(lp).connect(am).connect(g).connect(dest);
    lfo.start(t); lfo.stop(t + dur + 0.1);
    // a drowned moan underneath
    this._voiced(dest, t + 0.2, rand.range(110, 140), dur, 0.25, 'u', { fall: 0.7, breath: 0.8 });
    return dur;
  }

  skitter(dest, n = rand.int(10, 26), peak = 0.7) {
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.05;
    for (let i = 0; i < n; i++) {
      const s = this._noiseSrc(t, 0.03);
      const bp = this._bp(rand.range(1500, 4200), 3);
      const g = ctx.createGain();
      this._env(g, t, 0.001, rand.range(0.2, 1) * peak, 0.004, 0.02);
      s.connect(bp).connect(g).connect(dest);
      t += rand.range(0.02, 0.09);
    }
    return t - ctx.currentTime;
  }

  chime(dest) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const f = rand.range(820, 1400);
    for (const [ratio, amp] of [[1, 0.3], [2.76, 0.12], [5.4, 0.06]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      this._env(g, t, 0.005, amp, 0.01, 2.2);
      o.connect(g).connect(dest);
      o.start(t); o.stop(t + 2.4);
    }
    return 2.4;
  }

  // Play a recorded AudioBuffer (the Mimic uses your own voice).
  playBuffer(buf, dest, { reverse = false, rate = 0.85, gain = 1.2 } = {}) {
    const ctx = this.ctx;
    let b = buf;
    if (reverse) {
      b = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const src = buf.getChannelData(c), dst = b.getChannelData(c);
        for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
      }
    }
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const bp = this._filt('peaking', 1800, 1);
    bp.gain.value = 6;
    s.connect(bp).connect(g).connect(dest);
    s.start();
    return b.duration / rate;
  }

  // ---- non-spatial effects ---------------------------------------------------
  shriek(volume = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const dur = 1.5;
    const out = ctx.createGain();
    this._env(out, t, 0.015, 0.9 * volume, dur * 0.7, dur * 0.3);
    const sh = ctx.createWaveShaper();
    sh.curve = this.distCurve;
    out.connect(this.master);
    sh.connect(out);
    for (let i = 0; i < 5; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f = rand.range(500, 1500);
      o.frequency.setValueAtTime(f * 0.6, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.25);
      o.frequency.exponentialRampToValueAtTime(f * 0.5, t + dur);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand.range(12, 30);
      const lg = ctx.createGain();
      lg.gain.value = f * 0.08;
      lfo.connect(lg).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(g).connect(sh);
      o.start(t); lfo.start(t);
      o.stop(t + dur + 0.1); lfo.stop(t + dur + 0.1);
    }
    const n = this._noiseSrc(t, dur);
    const ng = ctx.createGain();
    ng.gain.value = 0.5;
    n.connect(this._filt('highpass', 1200)).connect(ng).connect(out);
    this.thump(1.2 * volume);
  }

  thump(vol = 1) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.5);
    const g = ctx.createGain();
    this._env(g, t, 0.005, vol, 0.05, 0.7);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.9);
  }

  // Short dissonant sting when something shows itself.
  sting(vol = 0.6) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    this._env(out, t, 0.02, vol, 0.4, 1.2);
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    out.connect(send).connect(this.reverbIn);
    for (const f of [1244.5, 1318.5, 1864.7, 622]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.97, t);
      o.frequency.linearRampToValueAtTime(f * 1.01, t + 1.5);
      const g = ctx.createGain();
      g.gain.value = 0.06;
      o.connect(this._bp(f, 4)).connect(g).connect(out);
      o.start(t); o.stop(t + 1.8);
    }
  }

  shutter() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    for (const dt of [0, 0.07]) {
      const s = this._noiseSrc(t + dt, 0.03);
      const g = ctx.createGain();
      this._env(g, t + dt, 0.001, 0.5, 0.01, 0.03);
      s.connect(this._filt('highpass', 2000)).connect(g).connect(this.master);
    }
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70, t + 0.12);
    o.frequency.linearRampToValueAtTime(110, t + 0.5);
    const g = ctx.createGain();
    this._env(g, t + 0.12, 0.02, 0.08, 0.3, 0.1);
    o.connect(this._filt('lowpass', 500)).connect(g).connect(this.master);
    o.start(t + 0.12); o.stop(t + 0.7);
  }

  heartbeat(vol = 0.5) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    for (const [dt, v] of [[0, 1], [0.22, 0.7]]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(70, t + dt);
      o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.15);
      const g = ctx.createGain();
      this._env(g, t + dt, 0.01, vol * v, 0.02, 0.18);
      o.connect(g).connect(this.master);
      o.start(t + dt); o.stop(t + dt + 0.3);
    }
  }

  // Continuous bed: low drone + radio static. Levels are set every frame.
  startAmbience() {
    if (!this.ctx || this.amb) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(this.master);
    const lp = this._filt('lowpass', 220, 2);
    lp.connect(out);
    const oscs = [49, 49.6, 73.4, 98.7].map((f) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.type = f > 90 ? 'triangle' : 'sine';
      o.connect(lp);
      o.start();
      return o;
    });
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 120;
    lfo.connect(lg).connect(lp.frequency);
    lfo.start();

    const stat = ctx.createBufferSource();
    stat.buffer = this.noise;
    stat.loop = true;
    const sg = ctx.createGain();
    sg.gain.value = 0.0001;
    stat.connect(this._bp(3000, 0.6)).connect(sg).connect(this.master);
    stat.start();

    // high, thin, dissonant shimmer for dread
    const hi = ctx.createOscillator();
    hi.frequency.value = 1975;
    const hi2 = ctx.createOscillator();
    hi2.frequency.value = 2093;
    const hg = ctx.createGain();
    hg.gain.value = 0.0001;
    hi.connect(hg); hi2.connect(hg);
    hg.connect(this.reverbIn);
    hi.start(); hi2.start();
    this.amb = { out, sg, hg, nodes: [...oscs, lfo, stat, hi, hi2] };
  }

  setAmbience(dread, staticLevel) {
    if (!this.amb) return;
    const t = this.ctx.currentTime;
    this.amb.out.gain.setTargetAtTime(0.06 + dread * 0.12, t, 0.3);
    this.amb.hg.gain.setTargetAtTime(0.0001 + dread * dread * 0.012, t, 0.5);
    const crackle = staticLevel * (0.4 + Math.random() * 0.6);
    this.amb.sg.gain.setTargetAtTime(0.0001 + crackle * 0.05, t, 0.03);
  }

  stopAmbience() {
    if (!this.amb) return;
    for (const n of this.amb.nodes) { try { n.stop(); } catch { /* fine */ } }
    this.amb.out.disconnect();
    this.amb.sg.disconnect();
    this.amb.hg.disconnect();
    this.amb = null;
  }

  // Knock on one side only, to check for headphones.
  knock(side) {
    this.init();
    const ctx = this.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = side === 'left' ? -1 : 1;
    pan.connect(this.master);
    let t = ctx.currentTime + 0.05;
    for (let i = 0; i < 3; i++) {
      const s = this._noiseSrc(t, 0.08);
      const g = ctx.createGain();
      this._env(g, t, 0.002, 0.9, 0.01, 0.12);
      s.connect(this._filt('lowpass', 500, 3)).connect(g).connect(pan);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.1);
      const og = ctx.createGain();
      this._env(og, t, 0.002, 0.6, 0.01, 0.1);
      o.connect(og).connect(pan);
      o.start(t); o.stop(t + 0.2);
      t += 0.32;
    }
  }

  testTone() {
    this.init();
    this.chime(this.master);
  }
}

export const audio = new AudioEngine();
