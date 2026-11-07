// Menu music: an original, slow, melancholy retro-synth piece in D minor.
// Pulsing analog arpeggio, deep bass, wide detuned pads, a lonely lead, a
// ticking clock, warped-tape wobble — and things that don't belong in it.
// Everything is synthesized and scheduled live, so it never loops exactly.
import { audio } from './audio.js';
import { rand } from './util.js';

const BPM = 76;
// Everything sits a fourth lower than written (D minor -> A minor), and the
// lead drops a further octave: lower, heavier, less pretty.
const DOWN = -5;
const STEP = 60 / BPM / 4; // sixteenth note
const LOOP_BARS = 16;

const mtof = (m) => 440 * Math.pow(2, (m + DOWN - 69) / 12);

// Eight chords, two bars each. i – VI – iv – V – i – bII – VI – V
const CHORDS = [
  { tones: [62, 65, 69], bass: 38 }, // Dm
  { tones: [58, 62, 65], bass: 34 }, // Bb
  { tones: [55, 58, 62], bass: 43 }, // Gm
  { tones: [57, 61, 64], bass: 45 }, // A
  { tones: [62, 65, 69], bass: 38 }, // Dm
  { tones: [58, 63, 67], bass: 39 }, // Eb (the wrong-feeling one)
  { tones: [58, 62, 65], bass: 34 }, // Bb
  { tones: [57, 61, 64], bass: 33 }, // A
];

// Lead phrases per chord: [midi, length in beats]
const MELODY = [
  [[69, 4], [65, 2], [64, 2]],
  [[74, 6], [72, 2]],
  [[70, 4], [69, 2], [67, 2]],
  [[73, 6], [76, 2]],
  [[74, 8]],
  [[79, 4], [77, 2], [75, 2]],
  [[74, 4], [65, 4]],
  [[64, 6], [61, 2]],
];

const ARP = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 4, 5, 4, 2, 1];

class MenuMusic {
  constructor() {
    this.playing = false;
    this.timer = null;
  }

  start() {
    if (this.playing || !audio.running) return;
    audio.loadSamples();
    const ctx = audio.ctx;
    this.playing = true;

    // Bus: everything -> tape wobble -> gain -> master (and reverb)
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.out.gain.exponentialRampToValueAtTime(0.85, ctx.currentTime + 4);
    this.out.connect(audio.master);

    this.bus = ctx.createGain();
    const wow = ctx.createDelay(0.05);
    wow.delayTime.value = 0.012;
    const wowLfo = ctx.createOscillator();
    wowLfo.frequency.value = 0.35;
    const wowDepth = ctx.createGain();
    wowDepth.gain.value = 0.0022;
    wowLfo.connect(wowDepth).connect(wow.delayTime);
    const flutter = ctx.createOscillator();
    flutter.frequency.value = 5.3;
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 0.00025;
    flutter.connect(flutterDepth).connect(wow.delayTime);
    const tapeLp = audio._filt('lowpass', 7500, 0.5);
    this.bus.connect(wow).connect(tapeLp).connect(this.out);

    this.verb = ctx.createGain();
    this.verb.gain.value = 0.9;
    this.verb.connect(audio.reverbIn);

    // Dotted-eighth ping-pong delay for the arp
    this.delayIn = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(1), dr = ctx.createDelay(1);
    dl.delayTime.value = dr.delayTime.value = STEP * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const dlp = audio._filt('lowpass', 2600);
    this.delayIn.connect(dl);
    dl.connect(dlp).connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    const dGain = ctx.createGain();
    dGain.gain.value = 0.5;
    merger.connect(dGain).connect(this.bus);

    // Tape hiss
    const hiss = ctx.createBufferSource();
    hiss.buffer = audio.noise;
    hiss.loop = true;
    const hg = ctx.createGain();
    hg.gain.value = 0.012;
    hiss.connect(audio._filt('bandpass', 5000, 0.4)).connect(hg).connect(this.out);


    this.persistent = [wowLfo, flutter, hiss];
    for (const n of this.persistent) n.start();

    this.step = 0;
    this.next = ctx.currentTime + 0.15;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stop(fade = 1.5) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    const ctx = audio.ctx;
    const out = this.out, nodes = this.persistent;
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), ctx.currentTime);
    out.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + fade);
    setTimeout(() => {
      for (const n of nodes) { try { n.stop(); } catch { /* done */ } }
      out.disconnect();
    }, fade * 1000 + 200);
  }

  schedule() {
    const ctx = audio.ctx;
    if (!ctx || ctx.state !== 'running') return;
    while (this.next < ctx.currentTime + 0.2) {
      this.playStep(this.step, this.next);
      this.next += STEP;
      this.step++;
    }
  }

  playStep(step, t) {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const loop = Math.floor(bar / LOOP_BARS);
    const inLoop = bar % LOOP_BARS;
    const ci = Math.floor(inLoop / 2) % CHORDS.length;
    const chord = CHORDS[ci];
    const first = loop === 0;
    const breakdown = inLoop >= 14 && loop % 2 === 1; // the floor drops out

    if (s === 0 && bar % 2 === 0) this.pad(chord, t, STEP * 32);
    if ((!first || inLoop >= 4) && !breakdown) this.arp(chord, s, t, bar);
    if ((!first || inLoop >= 8) && s % 2 === 0 && !breakdown) this.bass(chord.bass, t, s);
    if (!first || inLoop >= 8) {
      if ((s === 0 || s === 8) && !breakdown) this.kick(t);
      if (s === 12 && bar % 2 === 1) this.snare(t);
    }
    if (s % 4 === 0) this.tick(t, s === 0);
    if (loop % 2 === 1 && s === 0 && bar % 2 === 0) this.lead(MELODY[ci], t);
    if (s === 0 && rand() < 0.14) this.haunt(t + rand.range(0, STEP * 12));
    // Something is wrong with the music: dissonant stings, never on a schedule.
    if (s === 0 && bar >= 4 && t > (this.nextSting ?? 0) && rand() < 0.3) {
      this.sting(t + STEP * rand.int(0, 8));
      this.nextSting = t + rand.range(9, 22);
    }
  }

  // ---- voices -------------------------------------------------------------------
  pad(chord, t, dur) {
    const ctx = audio.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 1.6);
    g.gain.setValueAtTime(0.05, t + dur - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1.4);
    const lp = audio._filt('lowpass', 900, 0.8);
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1300, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    lp.connect(g);
    g.connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 0.7;
    g.connect(send).connect(this.verb);
    for (const m of [...chord.tones, chord.tones[0] - 12]) {
      for (const det of [-9, 0, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = det + rand.range(-2, 2);
        const og = ctx.createGain();
        og.gain.value = 0.22;
        o.connect(og).connect(lp);
        o.start(t);
        o.stop(t + dur + 1.6);
      }
    }
  }

  arp(chord, s, t, bar) {
    const ctx = audio.ctx;
    const tones = [...chord.tones, ...chord.tones.map((m) => m + 12)];
    const m = tones[ARP[s]];
    const swell = 0.5 + 0.5 * Math.sin((bar / LOOP_BARS) * Math.PI * 2 - Math.PI / 2);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o2.type = 'square';
    o1.frequency.value = o2.frequency.value = mtof(m);
    o2.detune.value = 7;
    const lp = audio._filt('lowpass', 800, 7);
    const peak = 600 + swell * 1700;
    lp.frequency.setValueAtTime(peak, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + STEP * 1.6);
    const g = ctx.createGain();
    const v = s % 4 === 0 ? 0.075 : 0.05;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 1.8);
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    o1.connect(mix); o2.connect(mix);
    mix.connect(lp).connect(g);
    g.connect(this.bus);
    g.connect(this.delayIn);
    o1.start(t); o2.start(t);
    o1.stop(t + STEP * 2); o2.stop(t + STEP * 2);
  }

  bass(m, t, s) {
    const ctx = audio.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(m);
    const sub = ctx.createOscillator();
    sub.frequency.value = mtof(m - 12);
    const lp = audio._filt('lowpass', 260, 4);
    lp.frequency.setValueAtTime(s % 8 === 0 ? 520 : 380, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + STEP * 1.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 1.9);
    const sg = ctx.createGain();
    sg.gain.value = 0.7;
    o.connect(lp);
    sub.connect(sg).connect(lp);
    lp.connect(g).connect(this.bus);
    o.start(t); sub.start(t);
    o.stop(t + STEP * 2); sub.stop(t + STEP * 2);
  }

  kick(t) {
    const ctx = audio.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(audio._filt('lowpass', 180)).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.6);
  }

  // Big, gated, 80s-style snare — distant, mostly reverb.
  snare(t) {
    const ctx = audio.ctx;
    const n = ctx.createBufferSource();
    n.buffer = audio.noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.004);
    g.gain.setValueAtTime(0.1, t + 0.14);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(audio._bp(1700, 0.8)).connect(g);
    g.connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 1.6;
    g.connect(send).connect(this.verb);
    n.start(t, rand() * 2);
    n.stop(t + 0.25);
  }

  // A clock somewhere in the house.
  tick(t, tock) {
    const ctx = audio.ctx;
    const n = ctx.createBufferSource();
    n.buffer = audio.noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(tock ? 0.05 : 0.03, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(audio._bp(tock ? 2400 : 3600, 6)).connect(g);
    g.connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    g.connect(send).connect(this.verb);
    n.start(t, rand() * 2);
    n.stop(t + 0.05);
  }

  // A thin, wavering, half-sung lead, far away.
  lead(phrase, t) {
    const ctx = audio.ctx;
    const beat = STEP * 4;
    let at = t;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vd = ctx.createGain();
    vd.gain.setValueAtTime(0, t);
    vd.gain.linearRampToValueAtTime(9, t + 1.2);
    vib.connect(vd);
    vd.connect(o.detune); vd.connect(o2.detune);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    const total = phrase.reduce((s, [, b]) => s + b, 0) * beat;
    for (const [m, beats] of phrase) {
      const f = mtof(m - 12);
      o.frequency.setTargetAtTime(f, at, 0.04);
      o2.frequency.setTargetAtTime(f * 2, at, 0.04);
      g.gain.setTargetAtTime(0.06, at, 0.18);
      g.gain.setTargetAtTime(0.025, at + beats * beat * 0.7, 0.3);
      at += beats * beat;
    }
    g.gain.setTargetAtTime(0.0001, at - 0.2, 0.25);
    const og2 = ctx.createGain();
    og2.gain.value = 0.25;
    o.connect(g);
    o2.connect(og2).connect(g);
    const lp = audio._filt('lowpass', 1500, 1);
    g.connect(lp).connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 1.4;
    lp.connect(send).connect(this.verb);
    for (const n of [o, o2, vib]) { n.start(t); n.stop(t + total + 1.2); }
  }

  // ---- stings: the bad feeling -----------------------------------------------
  sting(t) {
    const kind = rand.pick(['cluster', 'tritone', 'screech', 'prepared', 'swell']);
    this[`sting_${kind}`](t);
  }

  // Semitone cluster that swells out of nothing and is cut off.
  sting_cluster(t) {
    const ctx = audio.ctx;
    const base = rand.int(62, 70);
    const dur = rand.range(1.4, 2.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.11, t + dur);
    g.gain.setValueAtTime(0.0001, t + dur + 0.02);
    const bp = audio._bp(mtof(base) * 2, 0.8);
    g.connect(bp).connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 1.2;
    bp.connect(send).connect(this.verb);
    for (const d of [0, 1, 2, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(base + d);
      o.detune.setValueAtTime(-15, t);
      o.detune.linearRampToValueAtTime(15, t + dur);
      const og = ctx.createGain();
      og.gain.value = 0.25;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  // Low brass-like stab on a tritone with a flat ninth.
  sting_tritone(t) {
    const ctx = audio.ctx;
    const root = rand.pick([33, 34, 39]);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    const lp = audio._filt('lowpass', 1400, 2);
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 2.2);
    const sh = ctx.createWaveShaper();
    sh.curve = audio.distCurve;
    g.connect(sh).connect(lp).connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    lp.connect(send).connect(this.verb);
    for (const d of [0, 6, 13, 12]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(root + d);
      o.detune.value = rand.range(-12, 12);
      const og = ctx.createGain();
      og.gain.value = 0.2;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + 2.7);
    }
    this.kick(t);
  }

  // A thin, high, bowed-metal screech that bends down.
  sting_screech(t) {
    const ctx = audio.ctx;
    const f = rand.range(1500, 2600);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.78, t + 1.4);
    const trem = ctx.createOscillator();
    trem.frequency.value = rand.range(9, 16);
    const tg = ctx.createGain();
    tg.gain.value = 0.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    trem.connect(tg).connect(g.gain);
    o.connect(audio._bp(f, 4)).connect(g);
    const send = ctx.createGain();
    send.gain.value = 2;
    g.connect(send).connect(this.verb);
    g.connect(this.bus);
    o.start(t); trem.start(t);
    o.stop(t + 1.7); trem.stop(t + 1.7);
  }

  // A detuned, inharmonic low piano note, as if from a broken piano downstairs.
  sting_prepared(t) {
    const ctx = audio.ctx;
    for (const m of [rand.int(28, 36)].flatMap((r) => [r, r + 1])) {
      for (const [ratio, amp] of [[1, 0.2], [2.03, 0.1], [3.11, 0.06], [4.9, 0.03]]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = mtof(m) * ratio;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5 / ratio);
        o.connect(g);
        g.connect(this.bus);
        const send = ctx.createGain();
        send.gain.value = 1;
        g.connect(send).connect(this.verb);
        o.start(t); o.stop(t + 3.6);
      }
    }
  }

  // Reversed swell rushing into silence.
  sting_swell(t) {
    const ctx = audio.ctx;
    const n = ctx.createBufferSource();
    n.buffer = audio.noise;
    const bp = audio._bp(800, 1.5);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(4000, t + 2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 2);
    g.gain.setValueAtTime(0.0001, t + 2.02);
    n.connect(bp).connect(g);
    g.connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    g.connect(send).connect(this.verb);
    n.start(t, rand() * 2); n.stop(t + 2.1);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(mtof(45), t);
    o.frequency.exponentialRampToValueAtTime(mtof(46), t + 2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.08, t + 2);
    og.gain.setValueAtTime(0.0001, t + 2.02);
    o.connect(audio._filt('lowpass', 900)).connect(og).connect(this.bus);
    o.start(t); o.stop(t + 2.1);
  }

  // Things that shouldn't be in the music.
  haunt(t) {
    const ctx = audio.ctx;
    const delay = Math.max(0, (t - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (!this.playing) return;
      const v = audio.makeVoice();
      const ang = rand.range(-180, 180);
      audio.placeVoice(v, ang, rand.range(-10, 20), rand.range(4, 9));
      v.input.gain.value = 0.35;
      const what = rand.pick(['whisper', 'sob', 'giggle', 'hum', 'drip', 'groan']);
      const dur = what === 'sob' ? audio.sobLayered(v.input, 0.45)
        : what === 'giggle' ? audio.giggle(v.input)
        : what === 'hum' ? audio.hum(v.input)
        : what === 'drip' ? audio.drip(v.input)
        : what === 'groan' ? audio.groan(v.input)
        : audio.whisper(v.input);
      setTimeout(() => audio.dropVoice(v), (dur + 4) * 1000);
    }, delay);
  }
}

export const music = new MenuMusic();
