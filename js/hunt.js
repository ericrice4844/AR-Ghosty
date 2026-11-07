// One ghost hunt: the camera view, ghosts around you, hints, photos, talking.
import { $, rand, clamp, smooth, angDiff, norm360, vibrate, corruptText, fmtTime, DEG } from './util.js';
import { GHOSTS, pickGhostType, newLore, classify, dirPhrase, OUTCOME_TEXT } from './ghosts.js';
import { dirFromAzEl, azElFromDir, viewForward, project, unproject, angleBetween, HAUNT_RANGE_M } from './world.js';
import { sensors, startCamera, stopCamera, setTorch, darkness, currentView, hasMotion, bindManualLook, detectHeadphones } from './sensors.js';
import { audio } from './audio.js';
import { mic, startMic, sampleMic, listen, stopListening, speak, hush, canRecognize } from './voice.js';
import { drawGhost, drawEdgeHands, drawScare, drawFX } from './render.js';
import { findObjects, loadDetector } from './detect.js';
import { photos, settings, saveSettings, progress, saveProgress } from './storage.js';

const DEBUG = new URLSearchParams(location.search).has('debug');
const EYE_H = 1.4;
// figure height (m) and how high its centre floats above the floor (m)
const BODY = {
  lantern: [0.5, 1.55], wren: [1.15, 0.62], weeper: [0.95, 0.47], hollow: [2.45, 1.22], whisperer: [1.9, 1.05],
  drowned: [1.3, 0.65], crawler: [0.85, 0.4], mimic: [1.75, 0.88], grinner: [1.85, 0.93],
};
const FILM_CAP = 12;

export class Hunt {
  constructor(app, { haunts = [], night = false } = {}) {
    this.app = app;
    this.haunts = haunts;
    this.night = night;
    this.lore = newLore();
    this.filmMax = settings.film;
    this.film = settings.film;
    this.nerve = 100;
    this.score = 0;
    this.shots = [];
    this.events = [];
    this.ghosts = [];
    this.t = 0;
    this.flash = 0;
    this.scare = null;
    this.torchVirtual = false;
    this.nextHint = 4;
    this.lastSpeech = -999;
    this.mimicBuffer = null;
    this.hand = null;
    this.ended = false;
    this.headphones = settings.headphones;
    this.forceDark = false;
    this.toastQ = [];
  }

  // ---- lifecycle ----------------------------------------------------------------
  async start() {
    this.video = $('#cam');
    this.canvas = $('#view');
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.wasDrag = bindManualLook(this.canvas);
    this.bindUI();

    try {
      await startCamera(this.video);
      this.noCamera = false;
    } catch (e) {
      this.noCamera = true;
      this.toast('No camera — the spirit lens is blind. Drag to look around.', 6);
      console.warn(e);
    }
    await audio.unlock();
    audio.setEnabled(settings.sound);
    audio.startAmbience();
    await startMic();
    if (!this.headphones) this.headphones = await detectHeadphones();
    this.spawn();
    if (this.ghosts.some((g) => g.def.behavior === 'emerge' || g.def.behavior === 'stalker')) loadDetector();

    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
    this.toast(hasMotion() ? 'Move your phone slowly. Listen.' : 'Drag to look around. Listen.', 4);
    this.updateHud(true);
  }

  stop() {
    this.ended = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    for (const g of this.ghosts) if (g.voice) audio.dropVoice(g.voice);
    audio.stopAmbience();
    hush();
    stopListening();
    stopCamera();
    this.unbindUI?.();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.focal = Math.max(this.w, this.h) / (2 * Math.tan(31 * DEG));
  }

  // ---- spawning --------------------------------------------------------------------
  spawn() {
    const types = new Set();
    const add = (type, az, extra = {}) => {
      if (types.has(type)) return;
      types.add(type);
      const def = GHOSTS[type];
      const [hm, ch] = BODY[type];
      const dist = rand.range(2.2, 4.5);
      const g = {
        uid: `${type}-${Math.random().toString(36).slice(2, 7)}`,
        type, def, az: norm360(az), dist, heightM: hm, centerH: ch,
        el: 0, state: 'dormant', vis: 0, agit: 0, mem: {}, resolved: null,
        facing: 0, shown: 0, manifestFor: 0, encountered: false, nextSound: rand.range(2, 8),
        emerge: null, approach: 0, lit: 0, speaking: 0, photos: 0, wander: rand.range(-1, 1), ...extra,
      };
      g.el = this.elFor(g);
      g.voice = audio.ctx ? audio.makeVoice() : null;
      this.ghosts.push(g);
    };

    // ?debug&ghosts=crawler,weeper forces a line-up (for testing).
    const forced = DEBUG && new URLSearchParams(location.search).get('ghosts');
    if (forced) {
      forced.split(',').filter((t) => GHOSTS[t]).forEach((t, i) => add(t, i * 90));
      return;
    }
    // Haunts you're standing in come to you from their real direction.
    for (const h of this.haunts) if (h.dist <= HAUNT_RANGE_M) add(h.type, h.bearing, { haunt: h.id });

    const want = clamp(3 + (this.night ? 1 : 0) - this.ghosts.length, 1, 4);
    const target = this.ghosts.length + want;
    let guard = 0;
    while (this.ghosts.length < target && guard++ < 40) {
      add(pickGhostType(rand, this.night), rand.range(0, 360));
    }
    // There should always be at least one presence that can show up in a lit room.
    if (!this.ghosts.some((g) => !g.def.requires.dark && !g.def.requires.headphones)) add(rand.pick(['lantern', 'grinner', 'wren']), rand.range(0, 360));

    // Spread them out so they aren't all in one spot.
    const sorted = [...this.ghosts].sort((a, b) => a.az - b.az);
    for (let i = 1; i < sorted.length; i++) {
      if (angDiff(sorted[i].az, sorted[i - 1].az) < 45 && !sorted[i].haunt) sorted[i].az = norm360(sorted[i - 1].az + rand.range(50, 90));
    }
    this.log('spawn', this.ghosts.map((g) => g.type).join(','));
  }

  elFor(g) {
    return Math.atan2(g.centerH - EYE_H, g.dist) / DEG;
  }

  relocate(g, opts = {}) {
    const yaw = this.yaw ?? 0;
    g.az = norm360(opts.behind ? yaw + 180 + rand.range(-50, 50) : g.az + rand.range(70, 200) * (rand() < 0.5 ? -1 : 1));
    g.dist = rand.range(2.2, 4.5);
    g.el = this.elFor(g);
    g.vis = 0;
    g.facing = 0;
    g.manifestFor = 0;
    if (g.state === 'manifest') g.state = 'lurking';
  }

  // ---- requirements -------------------------------------------------------------------
  conditions() {
    const dk = this.forceDark ? 1 : darkness(settings.lightCal);
    return {
      darkness: dk,
      dark: dk >= 0.62,
      sound: settings.sound && audio.running,
      headphones: settings.sound && audio.running && this.headphones,
      torch: sensors.torchOn || this.torchVirtual,
    };
  }

  blockedBy(def, cond) {
    const r = def.requires;
    if (r.dark && !cond.dark) return 'dark';
    if (r.sound && !cond.sound) return 'sound';
    if (r.headphones && !cond.headphones) return 'headphones';
    return null;
  }

  // ---- main loop ----------------------------------------------------------------------
  frame(now) {
    if (this.ended) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    const t = this.t;
    const { w, h } = this;

    const M = currentView(dt);
    this.M = M;
    const fwd = viewForward(M);
    const look = azElFromDir(fwd);
    this.yaw = look.az;
    this.pitch = look.el;
    const level = sampleMic();
    const cond = this.conditions();
    this.cond = cond;

    let emf = 0, dread = 0, threatNear = 0;
    for (const g of this.ghosts) {
      const dir = dirFromAzEl(g.az, g.el);
      g.dir = dir;
      g.angle = angleBetween(fwd, dir);
      g.rel = angDiff(g.az, this.yaw);
      g.proj = project(M, dir, w, h, this.focal);
      g.size = (this.focal * g.heightM) / g.dist;
      this.updateGhost(g, dt, cond, level);

      if (!g.resolved) {
        const presence = Math.pow(clamp(1 - g.angle / 150, 0, 1), 2.5);
        const k = g.blocked ? 0.55 : 1;
        emf = Math.max(emf, presence * k * (0.7 + g.vis * 0.5) + g.agit / 400);
        dread = Math.max(dread, (g.def.threat / 5) * (0.3 + presence * 0.5 + g.vis * 0.4));
        if (g.def.threat >= 4 && g.vis > 0.3) threatNear = Math.max(threatNear, g.vis);
      }
      if (g.voice && audio.running) {
        audio.placeVoice(g.voice, g.rel, g.el - this.pitch, Math.max(0.6, g.dist * 0.6));
        g.voice.input.gain.setTargetAtTime(g.resolved ? 0 : g.blocked === 'dark' ? 0.35 : 1, audio.now(), 0.2);
      }
      this.ghostSounds(g, cond);
    }
    this.emf = clamp(emf * 5 + (Math.random() - 0.5) * 0.4 * emf, 0, 5);
    audio.setAmbience(dread, clamp(this.emf / 5 - 0.35, 0, 1) * 1.4);

    // Nerve: being near nasty things wears you down.
    this.nerve = clamp(this.nerve - threatNear * 0.6 * dt + (threatNear === 0 ? 0.25 * dt : 0), 0, 100);
    if (this.nerve < 35 && (this._beat ?? 0) < t) { audio.heartbeat(0.25 + (35 - this.nerve) / 60); this._beat = t + 0.6 + this.nerve / 50; }
    if (this.nerve <= 0 && !this.scare) { this.finish('fled'); return; }

    // Hints
    if (t > this.nextHint) this.hint();

    // Whispered name, if you were foolish enough to give it.
    if (this.lore.userName && t > (this._nameAt ?? 30) && cond.sound) {
      this._nameAt = t + rand.range(40, 80);
      speak(`${this.lore.userName}...`, { pitch: 0.2, rate: 0.5, volume: 0.35 });
    }

    // Video flicker when something strong is close
    if (this.video) {
      const flick = this.emf > 3.5 && Math.random() < 0.08 ? 0.45 : 1;
      this.video.style.filter = `grayscale(0.55) sepia(0.25) hue-rotate(110deg) saturate(0.7) contrast(1.25) brightness(${(0.82 * flick).toFixed(2)})`;
    }

    this.render(t, cond);
    if ((this._hud ?? 0) < t) { this._hud = t + 0.1; this.updateHud(); }
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }

  // ---- per-ghost behaviour -------------------------------------------------------------
  updateGhost(g, dt, cond, level) {
    const def = g.def;
    if (g.resolved) { g.vis = smooth(g.vis, 0, 1.2, dt); return; }
    g.blocked = this.blockedBy(def, cond);
    g.agit = clamp(g.agit - 3 * dt, 0, 100);
    if (g.speaking > 0) g.speaking -= dt;

    if (g.blocked) {
      if (g.state === 'manifest') {
        g.state = 'lurking';
        if (g.blocked === 'dark') this.toast(`${def.name} retreats from the light.`);
      }
      g.vis = smooth(g.vis, 0, 4, dt);
      g.facing = 0;
      return;
    }
    if (g.state === 'dormant') g.state = 'lurking';

    const onScreen = g.proj && g.proj.x > -g.size * 0.3 && g.proj.x < this.w + g.size * 0.3 && g.proj.y > -g.size && g.proj.y < this.h + g.size;
    const facingNow = g.angle < 28;
    g.facing = facingNow ? g.facing + dt : Math.max(0, g.facing - dt * 0.5);
    let target = 0;

    switch (def.behavior) {
      case 'drift': {
        // Lingers just out of sight, drifts slowly, shows itself when you hold still on it.
        if (g.state === 'lurking') {
          g.az = norm360(g.az + g.wander * 2 * dt);
          if (g.facing > 1.2) this.manifest(g);
          else if (onScreen && g.angle < 40 && Math.random() < 0.002) target = 0.25; // a glimpse
        }
        if (g.state === 'manifest') {
          g.manifestFor += dt;
          target = 1;
          const linger = g.type === 'hollow' ? 30 : 16;
          if (g.manifestFor > linger && g.speaking <= 0 && (this.t - this.lastSpeech) > 8) {
            this.relocate(g);
            if (g.type !== 'lantern') this.toast(`${def.name} is gone. For now.`);
          }
          if (g.type === 'hollow' && g.angle < 10) g.agit += 5 * dt; // he doesn't like being stared at
          if (g.type === 'wren' && g.mem.hiding && g.mem.hidden && g.vis > 0.6) {
            g.mem.hiding = false;
            this.say(g, 'Found me! You found me! You\'re my best friend now... forever and ever.');
            this.resolve(g, 'peace', 1);
          }
        }
        break;
      }
      case 'faced': {
        // Only visible when you're looking straight at it. Circles you otherwise.
        if (g.angle > 12) g.az = norm360(g.az + (g.wander > 0 ? 9 : -9) * dt);
        target = g.angle < 11 ? 1 - g.angle / 14 : 0;
        if (target > 0.6 && g.state !== 'manifest') this.manifest(g, true);
        if (target < 0.05 && g.state === 'manifest') g.state = 'lurking';
        break;
      }
      case 'peripheral': {
        // Only in the corner of your eye.
        if (g.proj && onScreen) {
          const dx = (g.proj.x - this.w / 2) / (this.w / 2), dy = (g.proj.y - this.h / 2) / (this.h / 2);
          const r = Math.max(Math.abs(dx), Math.abs(dy));
          target = r > 0.55 ? clamp((r - 0.55) / 0.25, 0, 1) : 0;
          if (r < 0.35 && g.vis > 0.2) {
            g.vis = 0;
            if (Math.random() < 0.5) { audio.ctx && audio.giggle(g.voice.input); g.az = norm360(g.az + rand.range(30, 60) * (rand() < 0.5 ? -1 : 1)); }
          }
        }
        if (target > 0.5 && g.state !== 'manifest') this.manifest(g, true);
        break;
      }
      case 'weeper': {
        if (g.state === 'lurking' && g.angle < 45) this.manifest(g);
        if (g.state === 'manifest') {
          target = 1;
          if (cond.torch && g.angle < 22) { g.agit += 28 * dt; if (!g.mem.warned) { g.mem.warned = true; this.toast('The sobbing catches. She doesn\'t like the light.'); } }
          if (g.angle < 8) g.agit += 2 * dt;
          if (level > 0.45) g.agit += 60 * dt * level;
        }
        break;
      }
      case 'emerge':
      case 'stalker': {
        this.updateEmerger(g, dt, cond, onScreen, (t) => { target = t; });
        break;
      }
    }

    if (g.type === 'mimic' && g.state !== 'dormant') {
      if (level > 0.22) { g.agit += 12 * dt; this.lastNoise = this.t; }
      if (g.encountered && this.t - Math.max(this.lastSpeech, this.lastNoise ?? 0, g.encounteredAt) > 30) {
        this.say(g, '...', true);
        this.resolve(g, 'starved');
      }
    }

    g.vis = smooth(g.vis, target, target > g.vis ? 2.2 : 3.5, dt);
    if (g.agit >= 100 && !this.scare) this.attack(g);
  }

  updateEmerger(g, dt, cond, onScreen, setTarget) {
    const def = g.def;
    if (!g.emerge) {
      if (g.facing > 0.8) {
        g.emerge = { phase: 'seek', p: 0, tries: 0 };
      }
      return;
    }
    const E = g.emerge;
    if (E.phase === 'seek') {
      if (!E.pending && this.video && !this.noCamera) {
        E.pending = true;
        findObjects(this.video, this.w, this.h, def.emergeFrom || []).then((objs) => {
          E.pending = false;
          if (!objs || E.phase !== 'seek' || !this.M) return;
          const ok = objs.filter((o) => o.w > this.w * 0.08 && o.h > this.h * 0.05 && o.x + o.w / 2 > this.w * 0.1 && o.x + o.w / 2 < this.w * 0.9);
          E.tries++;
          const pick = ok[0];
          if (pick) this.beginEmerge(g, pick);
          else if (E.tries > 3) this.beginEmerge(g, { cls: 'floor', x: this.w * 0.3, y: this.h * 0.62, w: this.w * 0.4, h: this.h * 0.25 });
        });
      } else if (this.noCamera) {
        this.beginEmerge(g, { cls: 'floor', x: this.w * 0.3, y: this.h * 0.62, w: this.w * 0.4, h: this.h * 0.25 });
      }
      return;
    }
    if (E.phase === 'rise') {
      E.p = clamp(E.p + dt / 3.5, 0, 1);
      setTarget(1);
      if (E.p >= 1) {
        E.phase = 'done';
        this.manifest(g, true);
        // From now on it lives at the object's position.
        const b = this.emergeBox(g);
        if (b) {
          const size = this.emergeSize(g, b);
          g.dist = clamp((this.focal * g.heightM) / size, 0.8, 6);
          const cy = g.type === 'crawler' ? b.y + b.h * 0.8 : b.y + b.h * 0.4 - size * 0.45;
          const d = azElFromDir(unproject(this.M, b.x + b.w / 2, cy, this.w, this.h, this.focal));
          g.az = d.az; g.el = d.el;
        }
      }
      return;
    }
    // emerged
    g.state = 'manifest';
    if (def.behavior === 'stalker') {
      const watched = onScreen && g.angle < 30;
      g.moving = !watched;
      if (!watched) {
        // It moves when you look away. Always toward you, and around behind you.
        g.approach += dt * 0.045;
        g.az = norm360(g.az + clamp(angDiff(this.yaw + 180, g.az), -1, 1) * 14 * dt);
        if (!g.mem.moveWarn) { g.mem.moveWarn = true; this.toast('You hear it move.'); }
      }
      g.dist = clamp(4.2 - g.approach * 3.6, 0.6, 5);
      g.el = this.elFor(g);
      setTarget(1);
      if (cond.torch && g.angle < 16) {
        g.lit += dt;
        g.agit = Math.min(95, g.agit + 10 * dt);
        if (g.lit > 2.5) {
          this.say(g, '*it shrieks and scuttles back into the dark*', true);
          audio.skitter(g.voice.input, 30, 1);
          this.resolve(g, 'repelled');
          return;
        }
      }
      if (g.approach >= 1) { g.approach = 0.3; this.attack(g); }
    } else {
      setTarget(1);
      g.manifestFor += dt;
      if (g.manifestFor > 25 && g.speaking <= 0 && this.t - this.lastSpeech > 10) {
        g.emerge = null;
        g.state = 'lurking';
        this.relocate(g);
        this.toast(`${def.name} sinks back down.`);
      }
    }
  }

  beginEmerge(g, box) {
    const E = g.emerge;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const d = azElFromDir(unproject(this.M, cx, cy, this.w, this.h, this.focal));
    E.phase = 'rise';
    E.p = 0;
    E.cls = box.cls;
    E.az = d.az; E.el = d.el;
    E.aw = box.w / this.focal; E.ah = box.h / this.focal;
    g.az = d.az; g.el = d.el;
    if (audio.running) {
      if (g.type === 'drowned') audio.gurgle(g.voice.input); else audio.skitter(g.voice.input, 18, 0.9);
      audio.sting(0.5);
    }
    vibrate([30, 50, 30]);
    const where = box.cls === 'shadow' ? 'the shadows' : box.cls === 'floor' ? 'the floor' : `the ${box.cls}`;
    this.toast(g.type === 'drowned' ? `Water is rising out of ${where}...` : `Something is coming out from under ${where}...`, 4);
    this.log('emerge', `${g.type}:${box.cls}`);
  }

  emergeBox(g) {
    const E = g.emerge;
    if (!E || E.az == null) return null;
    const p = project(this.M, dirFromAzEl(E.az, E.el), this.w, this.h, this.focal);
    if (!p) return null;
    const bw = E.aw * this.focal, bh = E.ah * this.focal;
    return { x: p.x - bw / 2, y: p.y - bh / 2, w: bw, h: bh };
  }

  emergeSize(g, b) {
    return g.type === 'crawler' ? clamp(b.w * 0.9, this.h * 0.22, this.h * 0.55) : clamp(Math.max(b.w, b.h) * 1.4, this.h * 0.3, this.h * 0.6);
  }

  manifest(g, quiet = false) {
    if (g.state === 'manifest') return;
    g.state = 'manifest';
    g.manifestFor = 0;
    const first = !g.encountered;
    if (first) {
      g.encountered = true;
      g.encounteredAt = this.t;
      progress.seen[g.type] = (progress.seen[g.type] || 0) + 1;
      saveProgress();
      this.log('manifest', g.type);
    }
    if (!quiet && audio.running) audio.sting(g.def.threat >= 4 ? 0.7 : 0.35);
    if (first) {
      this.toast(`${g.def.name} — ${g.def.epithet}.`, 4);
      if (g.def.threat >= 4) vibrate([60, 40, 120]);
    }
  }

  ghostSounds(g, cond) {
    if (!audio.running || !g.voice || g.resolved || !settings.sound) return;
    // Ghosts that need sound stay silent until it's on; headphone ghosts still murmur.
    if (g.blocked === 'sound') return;
    if (this.t < g.nextSound) return;
    const s = rand.pick(g.def.sounds);
    const dest = g.voice.input;
    let dur = 1.5;
    switch (s) {
      case 'sob': dur = audio.sob(dest, 0.8 + g.agit / 200); break;
      case 'hum': dur = audio.hum(dest); break;
      case 'giggle': dur = audio.giggle(dest, g.type === 'grinner'); break;
      case 'whisper': dur = audio.whisper(dest); break;
      case 'groan': dur = audio.groan(dest); break;
      case 'drip': dur = audio.drip(dest); break;
      case 'gurgle': dur = audio.gurgle(dest); break;
      case 'skitter': dur = audio.skitter(dest); break;
      case 'chime': dur = audio.chime(dest); break;
      case 'echo':
        dur = this.mimicBuffer ? audio.playBuffer(this.mimicBuffer, dest, { reverse: rand() < 0.6, rate: rand.range(0.7, 0.95) }) : audio.whisper(dest);
        break;
    }
    const busy = g.state === 'manifest' ? rand.range(1.5, 5) : rand.range(4, 11);
    g.nextSound = this.t + dur + (s === 'sob' ? rand.range(0.5, 2.5) : busy);
  }

  // ---- outcomes ---------------------------------------------------------------------
  resolve(g, outcome, film = 0) {
    if (g.resolved) return;
    g.resolved = outcome;
    g.state = 'gone';
    const bonus = Math.round(g.def.points * (outcome === 'attacked' || outcome === 'fled' ? 0 : 0.75));
    this.score += bonus;
    if (film) this.addFilm(film);
    (progress.outcomes[g.type] ||= []);
    if (!progress.outcomes[g.type].includes(outcome)) progress.outcomes[g.type].push(outcome);
    progress.learned[g.type] = true;
    saveProgress();
    this.events.push({ type: g.type, outcome, bonus });
    this.toast(`${g.def.name}: ${OUTCOME_TEXT[outcome]}${bonus ? ` (+${bonus})` : ''}`, 5);
    this.log('resolve', `${g.type}:${outcome}`);
  }

  addFilm(n) {
    this.film = clamp(this.film + n, 0, FILM_CAP);
    if (n > 0) this.toast(`+${n} exposure`, 2.5);
    if (n < 0) this.toast('A photo is missing from your roll.', 3);
    this.updateHud(true);
  }

  attack(g) {
    if (this.scare) return;
    const def = g.def;
    this.scare = { type: g.type, t0: this.t, dur: 1.5 };
    hush();
    const soft = !settings.jumpscares;
    audio.shriek(soft ? 0.35 : settings.intensity);
    vibrate(soft ? [80] : [120, 40, 300, 40, 200]);
    const dmg = Math.round((8 + def.threat * 6) * (soft ? 0.7 : 1));
    this.nerve = clamp(this.nerve - dmg, 0, 100);
    this.log('attack', g.type);
    g.agit = 25;
    if (['crawler', 'weeper', 'whisperer', 'wren'].includes(g.type)) {
      this.resolve(g, 'attacked');
    } else {
      this.relocate(g);
    }
    setTimeout(() => this.toast(this.nerve > 0 ? `You stagger back. Nerve −${dmg}.` : 'You can\'t take any more.', 3), 1500);
  }

  // ---- talking --------------------------------------------------------------------------
  talkTarget() {
    let best = null, bestScore = 0;
    for (const g of this.ghosts) {
      if (g.resolved || g.blocked || g.state === 'dormant') continue;
      const score = g.vis * 2 + clamp(1 - g.angle / 70, 0, 1) + (g.def.behavior === 'peripheral' && g.angle < 40 ? 0.8 : 0) + (g.speaking > -6 && g.encountered ? 0.3 : 0);
      if (score > bestScore) { best = g; bestScore = score; }
    }
    return bestScore > 0.45 ? best : null;
  }

  handleSpeech(text, peak = 0, buffer = null) {
    if (!text) return;
    this.lastSpeech = this.t;
    if (buffer) this.mimicBuffer = buffer;
    const c = classify(text);
    this.log('say', text);
    $('#you-said').textContent = `“${text}”`;
    $('#you-said').classList.add('show');
    clearTimeout(this._ysT);
    this._ysT = setTimeout(() => $('#you-said').classList.remove('show'), 3500);

    // Everyone listening reacts to your voice.
    for (const g of this.ghosts) {
      if (g.resolved || g.blocked || g.state === 'dormant') continue;
      if (g.type === 'mimic') g.agit += 15;
      if (g.type === 'crawler' && g.emerge?.phase === 'done') g.approach = Math.min(0.95, g.approach + 0.12);
      if (g.type === 'weeper' && g.state === 'manifest' && peak > 0.55) g.agit += 30;
    }

    const g = this.talkTarget();
    if (!g) {
      setTimeout(() => this.subtitle(null, rand.pick(['Only silence answers.', 'Nothing answers. But something heard you.', 'The static swallows your words.'])), 700);
      return;
    }
    const r = g.def.talk(g, c, this.lore, { loud: peak > 0.55 }) || {};
    progress.learned[g.type] = progress.learned[g.type] || !!(c.has('askWant') || r.resolve);
    if (!g.encountered) this.manifest(g);
    setTimeout(() => this.applyResponse(g, r), 600 + rand.range(0, 900));
  }

  applyResponse(g, r) {
    if (this.ended) return;
    if (r.say) this.say(g, r.say, false, r.echo);
    if (r.agitation) g.agit = clamp(g.agit + r.agitation, 0, 100);
    if (r.trust) g.mem.trust = (g.mem.trust || 0) + r.trust;
    if (r.film) this.addFilm(r.film);
    if (r.hide) {
      setTimeout(() => {
        audio.running && audio.giggle(g.voice.input);
        this.relocate(g, { behind: true });
        g.mem.hidden = true;
        this.toast('She\'s gone. Somewhere a child is trying not to giggle.', 4);
      }, 2500);
    }
    if (r.relocate) setTimeout(() => this.relocate(g), 1800);
    if (r.reveal) {
      const other = this.ghosts.find((o) => o !== g && !o.resolved);
      if (other) setTimeout(() => this.hintFor(other, true), 4000);
    }
    if (r.resolve) setTimeout(() => this.resolve(g, r.resolve), 2500);
    if (r.attack) setTimeout(() => this.attack(g), 1200);
  }

  say(g, text, quiet = false, echo = false) {
    const v = g.def.voice;
    g.speaking = Math.min(8, 1 + text.length * 0.07);
    this.subtitle(g, text);
    if (!quiet && settings.sound) {
      if (echo && this.mimicBuffer && audio.running) audio.playBuffer(this.mimicBuffer, g.voice.input, { reverse: false, rate: 0.82 });
      else speak(text, v);
    }
  }

  subtitle(g, text) {
    const el = $('#subtitle');
    if (!settings.subtitles && g) return;
    const corrupt = g ? clamp(0.03 + g.agit / 300 + g.def.threat * 0.02, 0, 0.4) : 0;
    el.innerHTML = '';
    if (g) { const n = document.createElement('b'); n.textContent = g.def.name; el.append(n); }
    const s = document.createElement('span');
    s.textContent = corruptText(text, corrupt);
    el.append(s);
    el.dataset.threat = g ? g.def.threat : 0;
    el.classList.add('show');
    clearTimeout(this._subT);
    this._subT = setTimeout(() => el.classList.remove('show'), 2500 + text.length * 70);
  }

  // ---- hints ---------------------------------------------------------------------------
  hint() {
    this.nextHint = this.t + rand.range(7, 13);
    const visible = this.ghosts.some((g) => g.vis > 0.5 && !g.resolved);
    if (visible) return;
    const cands = this.ghosts.filter((g) => !g.resolved);
    if (!cands.length) {
      this.showHint('It\'s quiet now. Too quiet. End the hunt, or wait for what comes next...');
      this.nextHint = this.t + 25;
      if (!this._reinforced && this.t > 60) { this._reinforced = true; this.spawnLate(); }
      return;
    }
    // Prefer ones you can actually find right now, but not always.
    cands.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) + rand.range(-0.6, 0.6));
    this.hintFor(cands[0]);
  }

  hintFor(g, precise = false) {
    const blur = precise ? 0 : rand.range(-20, 20);
    const dir = dirPhrase(g.rel + blur, g.el - (this.pitch || 0));
    let text;
    if (g.blocked) {
      text = g.def.blockedHint || {
        dark: 'Something waits {dir}... but it will only show itself in the dark.',
        sound: 'Something {dir} wants to be heard. Turn your sound on.',
        headphones: 'Whispers {dir}, too quiet for the speaker. Put on headphones.',
      }[g.blocked];
    } else {
      text = rand.pick(g.def.hints);
      if (g.def.behavior === 'peripheral' && rand() < 0.5) text = 'Don\'t look straight at it. Something is {dir}, at the edge of your vision.';
      if (g.def.behavior === 'faced' && rand() < 0.4) text = 'You won\'t see it until you face it exactly. Follow the whispering — {dir}.';
    }
    this.showHint(text.replace('{dir}', dir), precise);
  }

  showHint(text, important = false) {
    const el = $('#hint');
    el.textContent = text;
    el.classList.toggle('important', important);
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  spawnLate() {
    // When it's quiet, something worse comes.
    const pool = ['crawler', 'hollow', 'weeper', 'mimic', 'grinner'].filter((t) => !this.ghosts.some((g) => g.type === t));
    if (!pool.length) return;
    const type = rand.pick(pool);
    const before = this.ghosts.length;
    const def = GHOSTS[type];
    const [hm, ch] = BODY[type];
    const g = {
      uid: `${type}-late`, type, def, az: norm360((this.yaw || 0) + 180), dist: 3.5, heightM: hm, centerH: ch, el: 0,
      state: 'dormant', vis: 0, agit: 0, mem: {}, resolved: null, facing: 0, manifestFor: 0, encountered: false,
      nextSound: this.t + 2, emerge: null, approach: 0, lit: 0, speaking: 0, photos: 0, wander: 0.5,
    };
    g.el = this.elFor(g);
    g.voice = audio.ctx ? audio.makeVoice() : null;
    this.ghosts.push(g);
    if (this.ghosts.length > before) setTimeout(() => this.showHint('Something new has come. It came from behind you.', true), 6000);
    if (def.behavior === 'emerge' || def.behavior === 'stalker') loadDetector();
  }

  // ---- photos -------------------------------------------------------------------------------
  async snap() {
    if (this.scare || this.ended) return;
    if (this.film <= 0) { this.toast('Out of film. You can still talk to them.', 2.5); return; }
    this.film--;
    this.flash = 1;
    audio.shutter();
    vibrate(20);

    const W = 720, H = Math.round((720 * this.h) / this.w);
    const pc = document.createElement('canvas');
    pc.width = W; pc.height = H;
    const p = pc.getContext('2d');
    const sx = W / this.w;
    p.fillStyle = '#050605';
    p.fillRect(0, 0, W, H);
    const v = this.video;
    if (v && v.videoWidth && !this.noCamera) {
      const s = Math.max(W / v.videoWidth, H / v.videoHeight);
      p.filter = 'grayscale(0.55) sepia(0.25) hue-rotate(110deg) saturate(0.7) contrast(1.25) brightness(0.82)';
      p.drawImage(v, (W - v.videoWidth * s) / 2, (H - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
      p.filter = 'none';
    }
    p.drawImage(this.canvas, 0, 0, W, H);

    // Score what's in the frame. Things you can't see sometimes turn up anyway.
    const caught = [];
    let ghostly = false;
    for (const g of this.ghosts) {
      if (g.resolved || !g.proj) continue;
      const inFrame = g.proj.x > 0 && g.proj.x < this.w && g.proj.y > -g.size * 0.3 && g.proj.y < this.h + g.size * 0.3;
      if (!inFrame) continue;
      const cx = Math.abs(g.proj.x - this.w / 2) / (this.w / 2);
      const cy = Math.abs(g.proj.y - this.h / 2) / (this.h / 2);
      const framing = g.def.behavior === 'peripheral' ? 1 : 1 - clamp(Math.max(cx, cy), 0, 1) * 0.6;
      const closeness = clamp((g.size / this.h) * 1.6, 0.4, 1.25);
      if (g.vis > 0.2) {
        const first = !progress.photographed[g.type];
        let pts = g.def.points * g.vis * framing * closeness;
        if (g.agit > 60) pts *= 1.4;
        if (first) pts *= 1.5;
        pts = Math.round(pts);
        caught.push({ type: g.type, pts, first, rage: g.agit > 60 });
        g.photos++;
      } else if (!g.blocked && g.state === 'lurking' && g.angle < 30 && rand() < 0.65) {
        // spirit photograph: it was there all along
        const pts = Math.round(g.def.points * 0.35);
        drawGhost(p, g.type, g.proj.x * sx, g.proj.y * sx, g.size * sx, { t: this.t, agit: 0.7 }, { alpha: 0.38, glitch: 0.5 });
        caught.push({ type: g.type, pts, spirit: true });
        ghostly = true;
      }
      this.reactToFlash(g);
    }

    // date stamp, like an old film camera
    p.font = `bold ${Math.round(W * 0.035)}px "Courier New", monospace`;
    p.fillStyle = 'rgba(255,140,40,0.9)';
    p.textAlign = 'right';
    p.shadowColor = 'rgba(255,100,0,0.8)';
    p.shadowBlur = 6;
    const d = new Date();
    p.fillText(`${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')} '${String(d.getFullYear()).slice(2)}  ${d.toTimeString().slice(0, 5)}`, W - 20, H - 24);
    p.textAlign = 'left';
    p.fillText(`EMF ${this.emf.toFixed(1)}`, 20, H - 24);
    p.shadowBlur = 0;

    const pts = caught.reduce((s, c) => s + c.pts, 0);
    this.score += pts;
    for (const c of caught) progress.photographed[c.type] = Math.max(progress.photographed[c.type] || 0, c.pts);
    saveProgress();

    const rec = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      time: Date.now(),
      ghosts: caught,
      score: pts,
      img: pc.toDataURL('image/jpeg', 0.82),
    };
    this.shots.push(rec);
    photos.add(rec);

    if (!caught.length) this.toast(rand.pick(['Nothing on the film. Just an empty room.', 'Empty. You were sure something was there.', 'Only grain and shadow.']), 2.5);
    else if (ghostly) setTimeout(() => this.toast('Wait — there\'s something in the photo that wasn\'t there...', 4), 600);
    else {
      const best = caught.reduce((a, b) => (a.pts > b.pts ? a : b));
      this.toast(`Captured: ${GHOSTS[best.type].name}${best.first ? ' — first photo!' : ''}${best.rage ? ' — enraged!' : ''} +${pts}`, 3);
    }
    this.showThumb(rec.img);
    this.updateHud(true);
  }

  reactToFlash(g) {
    if (g.blocked || g.state === 'dormant') return;
    const inView = g.angle < 35;
    if (!inView) return;
    switch (g.type) {
      case 'weeper': if (g.state === 'manifest') { g.agit += 35; this.toast('The flash. She stops crying.', 2.5); } break;
      case 'hollow': g.agit += 12; break;
      case 'crawler': if (g.emerge?.phase === 'done') g.approach = Math.max(0, g.approach - 0.08); break;
      case 'grinner': if (g.vis > 0.3) setTimeout(() => { audio.running && audio.giggle(g.voice.input, true); g.az = norm360(g.az + rand.range(40, 90) * (rand() < 0.5 ? 1 : -1)); }, 400); break;
      case 'lantern': if (g.state === 'manifest' && rand() < 0.4) setTimeout(() => this.relocate(g), 600); break;
    }
  }

  showThumb(src) {
    const el = $('#last-shot');
    el.style.backgroundImage = `url(${src})`;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  // ---- drawing -----------------------------------------------------------------------------
  render(t, cond) {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let shake = 0;
    if (this.scare) shake = clamp(1 - (t - this.scare.t0) / this.scare.dur, 0, 1);
    if (shake) ctx.translate((Math.random() - 0.5) * 24 * shake, (Math.random() - 0.5) * 24 * shake);
    if (this.noCamera) {
      ctx.fillStyle = '#070908';
      ctx.fillRect(0, 0, w, h);
    }
    const order = [...this.ghosts].sort((a, b) => b.dist - a.dist);
    for (const g of order) {
      if (g.vis < 0.01 || !g.proj) continue;
      const p = { t: t + g.uid.length, agit: g.agit / 100, speaking: g.speaking > 0, moving: g.moving };
      const flick = 0.85 + Math.sin(t * 13 + g.dist) * 0.05 + (Math.random() < 0.03 ? -0.4 : 0);
      const glitch = clamp((g.agit / 100) * 0.8 + (g.vis < 0.9 ? (1 - g.vis) * 0.6 : 0), 0, 1);
      const E = g.emerge;
      if (E && E.phase === 'rise') {
        const b = this.emergeBox(g);
        if (!b) continue;
        const size = this.emergeSize(g, b) * (0.55 + 0.45 * E.p);
        if (g.type === 'crawler') {
          const cy = b.y + b.h * 0.8 + E.p * size * 0.1;
          drawGhost(ctx, g.type, b.x + b.w / 2, cy, size, { ...p, moving: true }, {
            alpha: clamp(E.p * 2, 0, 1) * flick, glitch: 0.3, clip: { x: -w, y: b.y + b.h * 0.55, w: w * 3, h: h * 2 },
          });
        } else {
          const lip = b.y + b.h * 0.4;
          const cy = lip - size * 0.45 + (1 - E.p) * size * 0.9;
          drawGhost(ctx, g.type, b.x + b.w / 2, cy, size, p, { alpha: clamp(E.p * 3, 0, 1) * flick, glitch: 0.25, clip: { x: -w, y: -h, w: w * 3, h: lip + h } });
          if (E.p < 0.7) drawEdgeHands(ctx, { x: b.x, y: lip - b.h * 0.05, w: b.w, h: b.h }, E.p, t);
        }
        continue;
      }
      drawGhost(ctx, g.type, g.proj.x, g.proj.y, g.size, p, { alpha: g.vis * flick, glitch });
    }

    // A palm print on the inside of the glass.
    if (!this.hand && this.emf > 3.8 && Math.random() < 0.002) this.hand = { t0: t, x: rand.range(0.2, 0.8) * w, y: rand.range(0.25, 0.7) * h, r: rand.range(-0.4, 0.4) };
    if (this.hand) {
      const k = 1 - (t - this.hand.t0) / 4;
      if (k <= 0) this.hand = null;
      else drawHandprint(ctx, this.hand, Math.min(1, k * 2) * 0.35, Math.min(w, h) * 0.22);
    }

    let mist = null;
    const near = this.ghosts.filter((g) => !g.resolved && !g.blocked && g.state !== 'manifest').sort((a, b) => a.angle - b.angle)[0];
    if (near && near.angle > 25) {
      const side = Math.abs(near.rel) > 120 ? 'below' : near.rel < 0 ? 'left' : 'right';
      mist = { side, k: clamp(1 - near.angle / 180, 0, 1) * 0.8 };
    }
    this.flash = Math.max(0, this.flash - 0.04);
    drawFX(ctx, w, h, {
      t,
      beam: this.torchVirtual ? { r: 0.62, dim: cond.dark ? 0.94 : 0.75 } : null,
      mist,
      static: clamp(this.emf / 5 - 0.3, 0, 1),
      fear: 1 - this.nerve / 100,
      flash: this.flash,
    });

    if (this.scare) {
      const k = (t - this.scare.t0) / this.scare.dur;
      if (k >= 1) this.scare = null;
      else if (settings.jumpscares) drawScare(ctx, this.scare.type, w, h, t, Math.min(1, k * 2.2));
      else { ctx.fillStyle = `rgba(120,0,0,${0.5 * (1 - k)})`; ctx.fillRect(0, 0, w, h); }
    }

    if (DEBUG) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0f0';
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      let y = 120;
      ctx.fillText(`yaw ${this.yaw.toFixed(0)} pitch ${this.pitch.toFixed(0)} dark ${cond.darkness.toFixed(2)} lum ${sensors.light.edge.toFixed(2)} mic ${mic.level.toFixed(2)} hp ${this.headphones}`, 8, y);
      for (const g of this.ghosts) {
        y += 13;
        ctx.fillText(`${g.type.padEnd(9)} ${g.state.padEnd(8)} az ${g.az.toFixed(0).padStart(3)} rel ${g.rel.toFixed(0).padStart(4)} vis ${g.vis.toFixed(2)} ag ${g.agit.toFixed(0)} ${g.blocked || ''} ${g.resolved || ''} ${g.emerge?.phase || ''}`, 8, y);
      }
    }
  }

  // ---- HUD -------------------------------------------------------------------------------
  updateHud(force) {
    const c = this.cond || this.conditions();
    const leds = document.querySelectorAll('#emf b');
    leds.forEach((b, i) => b.classList.toggle('on', this.emf > i + 0.5));
    $('#film').innerHTML = Array.from({ length: Math.max(this.filmMax, this.film) }, (_, i) => `<i class="${i < this.film ? 'full' : ''}"></i>`).join('') + `<span>${this.film}</span>`;
    $('#nerve i').style.width = `${this.nerve}%`;
    $('#nerve').classList.toggle('low', this.nerve < 35);
    $('#score').textContent = this.score;
    const dk = $('#st-dark');
    dk.classList.toggle('ok', c.dark);
    dk.title = c.dark ? 'Dark enough' : 'Too bright for some';
    $('#st-dark i').style.height = `${Math.round(c.darkness * 100)}%`;
    $('#st-sound').classList.toggle('ok', c.sound);
    $('#st-hp').classList.toggle('ok', c.headphones);
    $('#btn-torch').classList.toggle('on', c.torch);
    // compass ribbon
    const strip = $('#compass-strip');
    if (strip && this.yaw != null) strip.style.transform = `translateX(${strip.parentElement.clientWidth / 2 - 1440 - this.yaw * 4}px)`;
    void force;
  }

  toast(text, secs = 3) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), secs * 1000);
  }

  log(kind, data) {
    if (DEBUG) console.log(`[hunt ${this.t.toFixed(1)}] ${kind}`, data);
  }

  // ---- UI wiring ---------------------------------------------------------------------------
  bindUI() {
    const offs = [];
    const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); offs.push(() => el.removeEventListener(ev, fn, opt)); };

    on(this.canvas, 'click', () => { if (!this.wasDrag()) this.snap(); });

    const torch = $('#btn-torch');
    on(torch, 'click', async () => {
      if (sensors.torchSupported) {
        await setTorch(!sensors.torchOn);
        this.toast(sensors.torchOn ? 'Flashlight on.' : 'Flashlight off.', 1.5);
      } else {
        this.torchVirtual = !this.torchVirtual;
        this.toast(this.torchVirtual ? 'Lantern lens on (your phone won\'t let us control its torch).' : 'Lantern lens off.', 2.5);
      }
      this.updateHud(true);
    });

    const talk = $('#btn-talk');
    const typeBar = $('#type-bar');
    const input = $('#type-input');
    let listening = false;
    const startTalk = async (e) => {
      e.preventDefault();
      if (listening) return;
      if (!canRecognize) { typeBar.hidden = false; input.focus(); return; }
      listening = true;
      talk.classList.add('live');
      hush();
      $('#you-said').textContent = 'listening…';
      $('#you-said').classList.add('show');
      listen.onInterim = (txt) => { $('#you-said').textContent = `“${txt}”`; };
      const r = await listen();
      listening = false;
      talk.classList.remove('live');
      if (r.text) this.handleSpeech(r.text, r.peak, r.buffer);
      else {
        $('#you-said').classList.remove('show');
        if (r.error && r.error !== 'no-speech' && r.error !== 'aborted') { typeBar.hidden = false; this.toast('Voice isn\'t working here — type instead.', 3); }
        else if (r.buffer) this.mimicBuffer = r.buffer;
      }
    };
    const endTalk = () => { if (listening) stopListening(); };
    on(talk, 'pointerdown', startTalk);
    on(talk, 'pointerup', endTalk);
    on(talk, 'pointerleave', endTalk);
    on(talk, 'contextmenu', (e) => e.preventDefault());
    on($('#btn-type'), 'click', () => { typeBar.hidden = !typeBar.hidden; if (!typeBar.hidden) input.focus(); });
    on(typeBar, 'submit', (e) => {
      e.preventDefault();
      const txt = input.value.trim();
      input.value = '';
      if (txt) this.handleSpeech(txt, 0.1, null);
    });

    on($('#btn-end'), 'click', () => this.finish('ended'));

    // light calibration
    const cal = $('#calib');
    on($('#st-dark'), 'click', () => { cal.hidden = !cal.hidden; });
    on($('#cal-bright'), 'click', () => {
      settings.lightCal = { ...(settings.lightCal || { dark: 0.08 }), bright: sensors.light.edge * 0.75 + sensors.light.overall * 0.25 };
      saveSettings();
      this.toast('Lights-on level saved. Now turn the lights off.', 3);
    });
    on($('#cal-dark'), 'click', () => {
      const v = sensors.light.edge * 0.75 + sensors.light.overall * 0.25;
      settings.lightCal = { ...(settings.lightCal || { bright: 0.45 }), dark: v };
      if (settings.lightCal.bright <= v + 0.05) settings.lightCal.bright = v + 0.2;
      saveSettings();
      cal.hidden = true;
      this.toast('Darkness calibrated.', 2);
    });
    on($('#cal-reset'), 'click', () => { settings.lightCal = null; saveSettings(); cal.hidden = true; this.toast('Calibration reset.', 2); });

    on($('#st-sound'), 'click', async () => {
      settings.sound = !settings.sound;
      saveSettings();
      await audio.unlock();
      audio.setEnabled(settings.sound);
      if (!settings.sound) hush();
      this.toast(settings.sound ? 'Sound on.' : 'Sound off. Some of them can only be heard.', 2.5);
    });
    on($('#st-hp'), 'click', () => this.app.headphoneTest().then((ok) => {
      this.headphones = ok;
      this.toast(ok ? 'Headphones confirmed. Listen closely.' : 'No headphones. Some voices are too quiet to hear.', 3);
    }));

    const keys = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === ' ') { e.preventDefault(); this.snap(); }
      if (DEBUG && e.key === 'd') { this.forceDark = !this.forceDark; this.toast(`debug dark ${this.forceDark}`); }
      if (DEBUG && e.key === 'h') { this.headphones = !this.headphones; this.toast(`debug headphones ${this.headphones}`); }
      if (DEBUG && e.key === 's') { const g = this.ghosts.find((x) => !x.resolved); g && this.attack(g); }
    };
    on(window, 'keydown', keys);
    this.unbindUI = () => offs.forEach((f) => f());
  }

  finish(reason) {
    if (this.ended) return;
    const result = {
      reason,
      score: this.score,
      shots: this.shots,
      events: this.events,
      encountered: this.ghosts.filter((g) => g.encountered).map((g) => ({ type: g.type, outcome: g.resolved })),
      lore: this.lore,
      when: fmtTime(Date.now()),
    };
    progress.hunts++;
    progress.total += this.score;
    progress.bestHunt = Math.max(progress.bestHunt, this.score);
    saveProgress();
    this.stop();
    this.app.showResults(result);
  }
}

function drawHandprint(ctx, hnd, a, size) {
  ctx.save();
  ctx.translate(hnd.x, hnd.y);
  ctx.rotate(hnd.r);
  ctx.scale(size, size);
  ctx.fillStyle = `rgba(220,235,240,${a})`;
  ctx.beginPath(); ctx.ellipse(0, 0.12, 0.22, 0.26, 0, 0, Math.PI * 2); ctx.fill();
  const F = [[-0.2, -0.22, 0.05, 0.16, -0.3], [-0.08, -0.33, 0.05, 0.19, -0.08], [0.05, -0.35, 0.05, 0.2, 0.05], [0.17, -0.28, 0.045, 0.17, 0.2], [0.3, 0.02, 0.05, 0.14, 0.9]];
  for (const [x, y, rx, ry, rot] of F) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

