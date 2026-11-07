// One ghost hunt: the camera view, ghosts around you, hints, photos, talking.
import { $, rand, clamp, smooth, angDiff, norm360, vibrate, corruptText, fmtTime, DEG } from './util.js';
import { GHOSTS, pickGhostType, newLore, classify, dirPhrase, OUTCOME_TEXT } from './ghosts.js';
import { dirFromAzEl, azElFromDir, viewForward, project, unproject, angleBetween, HAUNT_RANGE_M } from './world.js';
import { sensors, startCamera, stopCamera, setTorch, darkness, currentView, hasMotion, bindManualLook, detectHeadphones, steps, startSteps } from './sensors.js';
import { audio } from './audio.js';
import { mic, startMic, sampleMic, listen, stopListening, speak, hush, canRecognize, recordSnippet } from './voice.js';
import { drawGhost, drawEdgeHands, drawScare, drawFX } from './render.js';
import { findObjects, loadDetector, detectorState } from './detect.js';
import { placeGhost, ANCHOR, PLACE_TEXT } from './anchor.js';
import { findSurfaces } from './surfaces.js';
import { photos, settings, saveSettings, progress, saveProgress } from './storage.js';

const DEBUG = new URLSearchParams(location.search).has('debug');
const EYE_H = 1.4;
// figure height (m) and how high its centre floats above the floor (m)
const BODY = {
  lantern: [0.5, 1.55], wren: [1.15, 0.62], weeper: [0.95, 0.47], hollow: [2.45, 1.22], whisperer: [1.9, 1.05],
  drowned: [1.3, 0.65], crawler: [0.85, 0.4], mimic: [1.75, 0.88], grinner: [1.85, 0.93],
};
const FILM_CAP = 12;
// Ghosts only show themselves within this distance (m). Further away you hear
// them, feel them on the EMF, and have to walk to them.
const NEAR = 4.2;
const STRIDE = 0.7;

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
    this.pos = { x: 0, y: 0 }; // where you are in the house (m, east/north of where you started)
    this.walked = 0;
    this.noiseFloor = 0.05;
    this.noiseHold = 0;
    this.quietUntil = 0;
    this.nextNoiseOk = 0;
    this.surfaces = [];
    this.nextScan = 3;
    this.nextKnock = rand.range(18, 32);
    this.nextMirror = rand.range(35, 60);
    this.mirrorFx = null;
    this.knockFx = null;
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
    audio.loadSamples();
    audio.startAmbience();
    await startMic();
    startSteps();
    this.stepsSeen = steps.count;
    if (!this.headphones) this.headphones = await detectHeadphones();
    this.spawn();
    if (!this.noCamera) loadDetector(); // ghosts need to know where the furniture is

    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
    this.toast(hasMotion() ? 'Move your phone slowly. Listen. Some of them are not in this room.' : 'Drag to look around, W/S to walk. Listen.', 5);
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
    let nearCount = 0;
    const add = (type, az, extra = {}) => {
      if (types.has(type)) return;
      types.add(type);
      const def = GHOSTS[type];
      const [hm, ch] = BODY[type];
      // Most are somewhere else in the house; one or two are in this room.
      const near = extra.near ?? (nearCount < 1 || rand() < 0.3);
      if (near) nearCount++;
      const dist = extra.dist ?? (near ? rand.range(2, 3.6) : rand.range(4.8, 8.5));
      const g = {
        uid: `${type}-${Math.random().toString(36).slice(2, 7)}`,
        type, def, az: norm360(az), dist, heightM: hm, centerH: ch,
        el: 0, state: 'dormant', vis: 0, agit: 0, mem: {}, resolved: null,
        facing: 0, shown: 0, manifestFor: 0, encountered: false, nextSound: rand.range(2, 8),
        emerge: null, approach: 0, lit: 0, speaking: 0, photos: 0, wander: rand.range(-1, 1), ...extra,
      };
      g.el = this.elFor(g);
      this.toWorld(g);
      g.voice = audio.ctx ? audio.makeVoice() : null;
      this.ghosts.push(g);
    };

    // ?debug&ghosts=crawler,weeper forces a line-up (for testing).
    const forced = DEBUG && new URLSearchParams(location.search).get('ghosts');
    if (forced) {
      const far = new URLSearchParams(location.search).has('far');
      forced.split(',').filter((t) => GHOSTS[t]).forEach((t, i) => add(t, i * 90, { near: !far }));
      return;
    }
    // Haunts you're standing in come to you from their real direction.
    for (const h of this.haunts) if (h.dist <= HAUNT_RANGE_M) add(h.type, h.bearing, { haunt: h.id, near: false, dist: clamp(h.dist / 8, 4.8, 9) });

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

  // Ghosts live at fixed points in the house; az/dist are relative to you.
  toWorld(g) {
    g.wx = this.pos.x + Math.sin(g.az * DEG) * g.dist;
    g.wy = this.pos.y + Math.cos(g.az * DEG) * g.dist;
  }

  fromWorld(g) {
    const dx = g.wx - this.pos.x, dy = g.wy - this.pos.y;
    g.dist = Math.max(0.5, Math.hypot(dx, dy));
    g.az = norm360(Math.atan2(dx, dy) / DEG);
  }

  // When we learn a ghost's exact elevation (from furniture), remember its
  // height so it stays on the floor as you walk around it.
  fixHeight(g) {
    g.centerH = EYE_H + Math.tan(g.el * DEG) * g.dist;
  }

  walk(n) {
    const d = Math.sign(n) * Math.abs(n) * STRIDE;
    this.pos.x += Math.sin((this.yaw || 0) * DEG) * d;
    this.pos.y += Math.cos((this.yaw || 0) * DEG) * d;
    this.walked += Math.abs(d);
  }

  relocate(g, opts = {}) {
    const yaw = this.yaw ?? 0;
    g.az = norm360(opts.behind ? yaw + 180 + rand.range(-50, 50) : g.az + rand.range(70, 200) * (rand() < 0.5 ? -1 : 1));
    // usually somewhere else in the house: you'll have to go after it
    g.dist = opts.near ? rand.range(2, 3.4) : rand.range(4.8, 8.5);
    g.centerH = BODY[g.type][1];
    g.emerge = g.def.behavior === 'emerge' ? null : g.emerge;
    g.anchor = null;
    g.anchorSince = null;
    g.el = this.elFor(g);
    g.vis = 0;
    g.facing = 0;
    g.manifestFor = 0;
    if (g.state === 'manifest') g.state = 'lurking';
    this.toWorld(g);
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
    const level = this.micOff ? 0 : sampleMic();
    const cond = this.conditions();
    this.cond = cond;

    // Footsteps carry you through the house.
    if (steps.count !== this.stepsSeen) { this.walk(steps.count - this.stepsSeen); this.stepsSeen = steps.count; }
    this.listenForNoise(level, dt);
    this.updateSurfaces(dt);

    let emf = 0, dread = 0, threatNear = 0;
    for (const g of this.ghosts) {
      if (g.emerge?.phase !== 'rise') {
        this.fromWorld(g);
        g.el = this.elFor(g);
      }
      const dir = dirFromAzEl(g.az, g.el);
      g.dir = dir;
      g.angle = angleBetween(fwd, dir);
      g.rel = angDiff(g.az, this.yaw);
      g.proj = project(M, dir, w, h, this.focal);
      g.size = (this.focal * g.heightM) / g.dist;
      this.updateGhost(g, dt, cond, level);
      if (g.emerge?.phase !== 'rise') this.toWorld(g);

      if (!g.resolved) {
        const presence = Math.pow(clamp(1 - g.angle / 150, 0, 1), 2.5) * clamp(1.5 - g.dist / 7, 0.15, 1);
        const k = g.blocked ? 0.55 : 1;
        emf = Math.max(emf, presence * k * (0.7 + g.vis * 0.5) + g.agit / 400);
        dread = Math.max(dread, (g.def.threat / 5) * (0.3 + presence * 0.5 + g.vis * 0.4));
        if (g.def.threat >= 4 && g.vis > 0.3) threatNear = Math.max(threatNear, g.vis);
      }
      if (g.voice && audio.running) {
        audio.placeVoice(g.voice, g.rel, g.el - this.pitch, Math.max(0.6, g.dist * 0.75));
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

    // Too far away to see: you'll have to go to it.
    g.inRange = g.dist <= NEAR || (g.emerge && g.emerge.phase !== 'seek');
    if (!g.inRange) {
      if (g.state === 'manifest' && def.behavior !== 'stalker') g.state = 'lurking';
      g.vis = smooth(g.vis, 0, 3, dt);
      g.facing = 0;
      if (g.def.behavior === 'drift' && g.state === 'lurking') { g.wx += (rand() - 0.5) * 0.3 * dt; g.wy += (rand() - 0.5) * 0.3 * dt; }
      return;
    }

    const onScreen = g.proj && g.proj.x > -g.size * 0.3 && g.proj.x < this.w + g.size * 0.3 && g.proj.y > -g.size && g.proj.y < this.h + g.size;
    const facingNow = g.angle < 28;
    g.facing = facingNow ? g.facing + dt : Math.max(0, g.facing - dt * 0.5);
    let target = 0;

    switch (def.behavior) {
      case 'drift': {
        // Lingers just out of sight, drifts slowly, shows itself when you hold still on it.
        if (g.state === 'lurking') {
          g.az = norm360(g.az + g.wander * 0.8 * dt);
          if (g.facing > 1.2 && this.anchorReady(g)) this.manifest(g);
          else if (onScreen && g.angle < 40 && Math.random() < 0.002) target = 0.25; // a glimpse
        }
        if (g.state === 'manifest') {
          g.manifestFor += dt;
          target = 1;
          const linger = g.type === 'hollow' ? 30 : 16;
          if (g.manifestFor > linger && g.speaking <= 0 && (this.t - this.lastSpeech) > 8) {
            this.relocate(g, { near: rand() < 0.3 });
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
        // Only in the corner of your eye — usually from behind something.
        if (onScreen && g.angle < 40 && !this.anchorReady(g)) break;
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
        if (g.state === 'lurking' && g.angle < 45 && this.anchorReady(g)) this.manifest(g);
        if (g.state === 'manifest') {
          target = 1;
          if (cond.torch && g.angle < 22) { g.agit += 28 * dt; if (!g.mem.warned) { g.mem.warned = true; this.toast('The sobbing catches. She doesn\'t like the light.'); } }
          if (g.angle < 8) g.agit += 2 * dt;
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
          if (objs) this.lastObjs = { objs, t: this.t };
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
          this.fixHeight(g);
        }
        this.toWorld(g);
      }
      return;
    }
    // emerged
    g.state = 'manifest';
    if (def.behavior === 'stalker') {
      const watched = onScreen && g.angle < 30;
      g.moving = !watched;
      if (!watched && g.dist < 6) {
        // It moves when you look away: toward you, and around behind you.
        g.approach += dt * 0.045;
        g.az = norm360(g.az + clamp(angDiff(this.yaw + 180, g.az), -1, 1) * 14 * dt);
        if (!g.mem.moveWarn) { g.mem.moveWarn = true; this.toast('You hear it move.'); }
      }
      if (!watched && g.dist < 6) g.dist = Math.max(0.6, g.dist - dt * 0.17);
      g.approach = clamp((4.2 - g.dist) / 3.6, 0, 1);
      g.centerH = BODY.crawler[1];
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

  // ---- placement in the room -----------------------------------------------------
  // Before showing itself, a ghost looks at what the camera sees and takes a
  // place that makes sense: beside the bed, behind the couch, behind you.
  anchorReady(g) {
    if (g.anchor) return true;
    if (!ANCHOR[g.type]) { g.anchor = { kind: 'free', exclude: [] }; return true; }
    if (this.pitch < -50 || this.pitch > 35) return false; // staring at the floor or ceiling
    if (g.anchoring) return false;
    if (this.noCamera || detectorState() === 'unavailable') { this.applyPlacement(g, null, this.M); return true; }
    g.anchorSince ??= this.t;
    // give the detector a few seconds to load before falling back
    if (detectorState() !== 'ready' && this.t - g.anchorSince < 12) return false;
    g.anchoring = true;
    const M = this.M, w = this.w, h = this.h, focal = this.focal;
    const nearX = g.proj ? g.proj.x : w / 2;
    findObjects(this.video, w, h, ANCHOR[g.type].on).then((objs) => {
      g.anchoring = false;
      if (objs) this.lastObjs = { objs, t: this.t };
      if (!objs || g.resolved || this.ended) return; // detector busy: try again next frame
      this.applyPlacement(g, placeGhost(g.type, g.heightM, objs, { w, h, focal, nearX }), M);
    });
    return false;
  }

  applyPlacement(g, pl, M) {
    const { w, h, focal } = this;
    if (!pl || pl.kind === 'dark') {
      const x = pl ? pl.x : g.proj ? clamp(g.proj.x, w * 0.2, w * 0.8) : w / 2;
      g.az = azElFromDir(unproject(M, x, h / 2, w, h, focal)).az;
      g.dist = clamp(g.dist, 2, 3.6);
      g.el = this.elFor(g);
      this.toWorld(g);
      g.anchor = { kind: 'floor', exclude: [] };
      this.log('place', `${g.type}: floor`);
      return;
    }
    const d = azElFromDir(unproject(M, pl.x, pl.footY - pl.size / 2, w, h, focal));
    g.az = d.az;
    g.el = d.el;
    g.dist = clamp((focal * g.heightM) / pl.size, 0.6, 9);
    this.fixHeight(g);
    this.toWorld(g);
    g.anchor = { kind: pl.kind, cls: pl.cls, exclude: pl.exclude.map((r) => this.angBox(r, M, g.dist * 0.85)) };
    this.log('place', `${g.type}: ${pl.kind} ${pl.cls} x=${pl.x.toFixed(0)} foot=${pl.footY.toFixed(0)} size=${pl.size.toFixed(0)} -> el=${g.el.toFixed(1)} dist=${g.dist.toFixed(2)} pitchNow=${this.pitch.toFixed(1)}`);
    if (PLACE_TEXT[pl.kind] && g.def.behavior !== 'peripheral') setTimeout(() => this.showHint(PLACE_TEXT[pl.kind](pl.cls)), 300);
  }

  // Screen rect <-> angular box, so things stay pinned to the room as you turn.
  // With `depth` (m) the box is pinned to a point in the house, so it stays put
  // (and gets bigger) as you walk up to it. Without, it's pinned to a direction.
  angBox(r, M = this.M, depth = null) {
    const d = azElFromDir(unproject(M, r.x + r.w / 2, r.y + r.h / 2, this.w, this.h, this.focal));
    const b = { az: d.az, el: d.el, aw: r.w / this.focal, ah: r.h / this.focal };
    if (depth) {
      b.wx = this.pos.x + Math.sin(d.az * DEG) * depth;
      b.wy = this.pos.y + Math.cos(d.az * DEG) * depth;
      b.hc = EYE_H + Math.tan(d.el * DEG) * depth;
      b.wm = b.aw * depth;
      b.hm = b.ah * depth;
    }
    return b;
  }

  screenBox(b) {
    let az = b.az, el = b.el, aw = b.aw, ah = b.ah;
    if (b.wx != null) {
      const dx = b.wx - this.pos.x, dy = b.wy - this.pos.y, dist = Math.max(0.4, Math.hypot(dx, dy));
      az = Math.atan2(dx, dy) / DEG;
      el = Math.atan2(b.hc - EYE_H, dist) / DEG;
      aw = b.wm / dist; ah = b.hm / dist;
    }
    const p = project(this.M, dirFromAzEl(az, el), this.w, this.h, this.focal);
    if (!p) return null;
    const bw = aw * this.focal, bh = ah * this.focal;
    return { x: p.x - bw / 2, y: p.y - bh / 2, w: bw, h: bh };
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
    if (!quiet && audio.running) { audio.sting(g.def.threat >= 4 ? 0.7 : 0.35); this.hush(2); }
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
      case 'sob': dur = audio.sobLayered(dest, 0.8 + g.agit / 200); break;
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

  // ---- they can hear you ---------------------------------------------------------------
  // Sudden noises (a cough, a bump, a word) set them off. The game's own sound
  // comes out of the same phone, so loud moments from the speaker are ignored.
  listenForNoise(level, dt) {
    if (!mic.ok || this.micOff) return;
    const out = audio.running ? audio.outLevel() : 0;
    if (level < this.noiseFloor * 2) this.noiseFloor += (level - this.noiseFloor) * Math.min(1, dt * 0.5);
    const thresh = Math.max(0.28, this.noiseFloor * 3.5) + out * 1.4;
    const quiet = this.listening || this.t < this.quietUntil || this.scare;
    this.noiseHold = !quiet && level > thresh ? this.noiseHold + dt : 0;
    this.micHot = level > thresh * 0.8;
    if (this.noiseHold > 0.08 && this.t > this.nextNoiseOk) {
      this.nextNoiseOk = this.t + 3;
      this.noiseHold = 0;
      this.onNoise(clamp((level - thresh) / 0.4 + 0.5, 0.5, 1));
    }
  }

  hush(seconds) {
    this.quietUntil = Math.max(this.quietUntil, this.t + seconds);
  }

  onNoise(loud) {
    this.lastNoise = this.t;
    this.log('noise', loud.toFixed(2));
    const near = this.ghosts
      .filter((g) => !g.resolved && g.state !== 'dormant' && g.blocked !== 'sound' && g.dist < 9)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2);
    if (!near.length) return;
    if (!this._heardOnce) { this._heardOnce = true; setTimeout(() => this.toast('They heard that.', 3), 400); }
    for (const g of near) this.reactToNoise(g, loud);
    if (this.mimicWants()) recordSnippet(2.2).then((b) => { if (b) this.mimicBuffer = b; });
  }

  mimicWants() {
    return this.ghosts.some((g) => g.type === 'mimic' && !g.resolved);
  }

  reactToNoise(g, loud) {
    const v = g.voice?.input;
    const close = g.dist < NEAR;
    switch (g.type) {
      case 'weeper': // she screams, and if she's already upset she comes for you
        if (audio.running && v) this.hush(audio.scream(v, 0.9) + 0.5);
        this.subtitle(g, '*SHE SCREAMS*');
        g.agit += 45 * loud;
        vibrate([80, 40, 160]);
        if (close && g.state === 'manifest' && g.agit > 70) setTimeout(() => this.attack(g), 900);
        break;
      case 'hollow': // he yells for quiet
        this.say(g, rand.pick(['QUIET.', 'Hold your tongue.', 'I SAID QUIET.', 'Do you WANT him to hear you?']));
        g.agit += 30 * loud;
        break;
      case 'wren': // she runs away and hides
        if (g.mem.hiding) break;
        this.say(g, rand.pick(['Too loud! Too loud!', 'You scared me!', 'Mama says no shouting!']));
        if (audio.running && v) audio.giggle(v);
        setTimeout(() => { this.relocate(g); this.toast('Little footsteps run away from you.', 3); }, 1200);
        break;
      case 'lantern':
        this.subtitle(g, '*the light gutters and flees*');
        if (audio.running && v) audio.chime(v);
        setTimeout(() => this.relocate(g), 600);
        break;
      case 'drowned': // a gargling scream, and he sinks
        if (audio.running && v) { audio.gurgle(v); this.hush(audio.scream(v, 0.6) + 0.5); }
        this.subtitle(g, '*he screams through the water*');
        if (g.emerge?.phase === 'done' || g.state === 'manifest') setTimeout(() => { g.emerge = null; this.relocate(g); this.toast(`${g.def.name} sinks away from the noise.`); }, 1500);
        break;
      case 'crawler': // it hunts by sound
        if (audio.running && v) audio.skitter(v, 24, 1);
        if (g.emerge?.phase === 'done') {
          g.dist = Math.max(0.6, g.dist - 1.2 * loud);
          this.toWorld(g);
          this.toast('It heard you. It\'s coming.', 2.5);
        } else if (g.dist > 3) {
          g.dist = Math.max(2.6, g.dist - 2.5);
          this.toWorld(g);
        }
        break;
      case 'mimic': // it eats the noise and keeps it
        g.agit += 20 * loud;
        this.subtitle(g, rand.pick(['*it repeats the sound you made*', '*your noise comes back from behind you*']));
        break;
      case 'whisperer': // SHHHHHH, right in your ears
        if (audio.running && v) this.hush(audio.hiss(v, 1.8) + 0.4);
        this.subtitle(g, 'SHHHHHHHHHHHHHHHH');
        g.agit += 35 * loud;
        break;
      case 'grinner':
        this.say(g, rand.pick(['Shhhh... hee hee... they\'ll hear you.', 'Oh, you\'ve woken them now.', 'Louder! Louder! Hee hee hee.']));
        break;
    }
  }

  // ---- the house: doors, windows, mirrors -----------------------------------------------
  updateSurfaces() {
    if (this.noCamera || !this.video || !this.M) return;
    if (this.t > this.nextScan) {
      this.nextScan = this.t + 4;
      const M = this.M;
      if (detectorState() === 'ready' && (!this.lastObjs || this.t - this.lastObjs.t > 8)) {
        findObjects(this.video, this.w, this.h, []).then((objs) => { if (objs) this.lastObjs = { objs, t: this.t }; });
      }
      let found = [];
      try { found = findSurfaces(this.video, this.w, this.h); } catch (e) { this.log('surfaces', e.message); }
      // TVs and laptops: dark glass that reflects. Fridges and furniture: things to knock on.
      if (this.lastObjs && this.t - this.lastObjs.t < 6) {
        const kindOf = { tv: 'screen', laptop: 'screen', refrigerator: 'metal', oven: 'metal', microwave: 'metal', 'dining table': 'table', bed: 'bed', chair: 'chair' };
        for (const o of this.lastObjs.objs) if (kindOf[o.cls]) found.push({ kind: kindOf[o.cls], x: o.x, y: o.y, w: o.w, h: o.h });
      }
      for (const f of found) {
        const b = this.angBox(f, M);
        const same = this.surfaces.find((s) => s.kind === f.kind && Math.abs(angDiff(s.az, b.az)) < 8 && Math.abs(s.el - b.el) < 8);
        if (same) Object.assign(same, b, { seen: this.t, pos: { ...this.pos } });
        else this.surfaces.push({ kind: f.kind, ...b, seen: this.t, first: this.t, pos: { ...this.pos } });
      }
      // forget surfaces we haven't seen in a while, or that we've walked away from
      this.surfaces = this.surfaces.filter((s) => this.t - s.seen < 40 && Math.hypot(s.pos.x - this.pos.x, s.pos.y - this.pos.y) < 1.5);
    }
    if (this.t > this.nextKnock) this.tryKnock();
    if (this.t > this.nextMirror) this.tryMirror();
  }

  visibleSurfaces(kinds) {
    return this.surfaces
      .filter((s) => kinds.includes(s.kind) && this.t - s.seen < 10)
      .map((s) => ({ s, b: this.screenBox(s) }))
      .filter(({ b }) => b && b.x + b.w > 0 && b.x < this.w && b.y + b.h > 0 && b.y < this.h);
  }

  // Something knocks on a door, a window, the fridge — whatever is in front of you.
  tryKnock() {
    this.nextKnock = this.t + 4;
    if (!this.ghosts.some((g) => !g.resolved) || this.scare) return;
    const pref = this.visibleSurfaces(['door', 'window']);
    const any = pref.length ? pref : this.visibleSurfaces(['panel', 'screen', 'metal', 'table', 'bed', 'chair']);
    if (!any.length || rand() > 0.6) return;
    const { s } = rand.pick(any);
    const material = { door: 'wood', window: 'glass', panel: 'glass', screen: 'glass', metal: 'metal' }[s.kind] || 'wood';
    const pattern = rand.pick([[0.32, 0.32], [0.28, 0.28, 0.7, 0.28], [0.9, 0.9], [0.14, 0.14, 0.14, 0.14, 0.14, 0.14], [0.5]]);
    if (audio.running) {
      const v = audio.makeVoice();
      audio.placeVoice(v, angDiff(s.az, this.yaw), s.el - this.pitch, 2.5);
      v.input.gain.value = 1.3;
      const dur = audio.knockOn(v.input, material, pattern);
      this.hush(dur + 1);
      setTimeout(() => audio.dropVoice(v), (dur + 3) * 1000);
    }
    let at = 0.05;
    this.knockFx = { s, hits: [0, ...pattern].map((g) => (at += g) + this.t) };
    const name = { door: 'the door', window: 'the window', panel: 'the glass', screen: 'the screen', metal: 'the metal', table: 'the table', bed: 'the bed frame', chair: 'the chair' }[s.kind];
    if (rand() < 0.6) setTimeout(() => this.showHint(rand.pick([`Something knocks on ${name}.`, `Knocking. On ${name}. From the other side.`, `Did ${name} just knock?`])), 900);
    vibrate([20, 300, 20]);
    this.nextKnock = this.t + rand.range(28, 65);
    this.log('knock', `${s.kind} ${material}`);
  }

  // A figure in a mirror (or a dark screen). Rare, brief, and gone if you look away.
  tryMirror() {
    this.nextMirror = this.t + 5;
    if (this.mirrorFx || this.scare) return;
    const c = this.visibleSurfaces(['panel', 'screen']).filter(({ s, b }) => b.h > this.h * 0.12 && this.t - s.first > 1.5);
    if (!c.length || rand() > 0.35) return;
    const { s } = rand.pick(c);
    const pool = this.ghosts.filter((g) => !g.resolved).map((g) => g.type);
    const type = rand.pick(pool.length ? pool : ['hollow', 'weeper', 'mimic', 'wren']);
    this.mirrorFx = { s, type, t0: this.t, dur: rand.range(5, 7.5), fx: rand.range(0.3, 0.7) };
    this.nextMirror = this.t + rand.range(55, 120);
    this.log('mirror', `${type} in ${s.kind}`);
  }

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
    this.hush(3);
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
      // you talk to what you're facing; something behind you only answers if nothing else does
      const facing = clamp(1 - g.angle / 70, 0, 1);
      const score = g.vis * (0.3 + 1.7 * facing) + facing + (g.def.behavior === 'peripheral' && g.angle < 40 ? 0.8 : 0) + (g.def.behavior === 'faced' && g.angle < 25 ? 0.8 : 0);
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
    this.hush(g.speaking + 1);
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
    let dir = dirPhrase(g.rel + blur, g.el - (this.pitch || 0));
    if (g.dist > NEAR) dir += g.dist > 7 ? ', far off. You\'ll have to go to it' : ', further away. Walk toward it';
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
    this.toWorld(g);
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

    // the figure in the mirror counts, if you were quick enough
    const F = this.mirrorFx;
    if (F && F.alpha > 0.15 && F.box && F.box.x + F.box.w > 0 && F.box.x < this.w) {
      const pts = Math.round(GHOSTS[F.type].points * 0.6 * (0.5 + F.alpha));
      caught.push({ type: F.type, pts, mirror: true });
      ghostly = true;
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
  renderHouse(ctx, t) {
    // the surface shudders with each knock
    const K = this.knockFx;
    if (K) {
      const b = this.screenBox(K.s);
      const hit = K.hits.find((h) => t >= h && t < h + 0.12);
      if (b && hit) {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = 'rgba(200,220,210,0.12)';
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x + (Math.random() - 0.5) * 4, b.y + (Math.random() - 0.5) * 4, b.w, b.h);
        ctx.restore();
      }
      if (t > K.hits[K.hits.length - 1] + 0.5) this.knockFx = null;
    }
    // something in the mirror — it lives inside the glass and moves with it
    const F = this.mirrorFx;
    if (F) {
      const b = this.screenBox(F.s);
      const k = (t - F.t0) / F.dur;
      const onScreen = b && b.x + b.w > 0 && b.x < this.w && b.y + b.h > 0 && b.y < this.h;
      if (k >= 1 || !onScreen) {
        if (k > 0.35 && rand() < 0.5) this.toast(rand.pick(['Was there something in the glass?', 'The reflection was wrong.', 'Something was standing behind you. In the reflection.']), 3);
        this.mirrorFx = null;
        F.gone = true;
      } else {
        const a = Math.sin(Math.min(1, k) * Math.PI) ** 1.5 * 0.55 * (Math.random() < 0.04 ? 0.3 : 1);
        F.alpha = a;
        F.box = b;
        const ix = b.w * 0.07, iy = b.h * 0.07;
        const clip = { x: b.x + ix, y: b.y + iy, w: b.w - 2 * ix, h: b.h - 2 * iy };
        const size = clip.h * 0.95;
        const cx = clip.x + clip.w * F.fx, cy = clip.y + clip.h * 0.55;
        ctx.save();
        // a reflection is reversed
        ctx.translate(cx, 0);
        ctx.scale(-1, 1);
        ctx.translate(-cx, 0);
        drawGhost(ctx, F.type, cx, cy, size, { t, agit: 0.2 }, { alpha: a, glitch: 0.15, clip: { x: 2 * cx - clip.x - clip.w, y: clip.y, w: clip.w, h: clip.h } });
        ctx.restore();
        // a faint sheen on the glass
        const g = ctx.createLinearGradient(clip.x, clip.y, clip.x + clip.w, clip.y + clip.h);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(220,235,230,${a * 0.12})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
      }
    }
  }

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
      const exclude = g.anchor?.exclude?.length ? g.anchor.exclude.map((b) => this.screenBox(b)).filter(Boolean) : null;
      drawGhost(ctx, g.type, g.proj.x, g.proj.y, g.size, p, { alpha: g.vis * flick, glitch, exclude });
    }

    this.renderHouse(ctx, t);

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

    if (DEBUG && !new URLSearchParams(location.search).has('nodebugtext')) {
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
    const micEl = $('#st-mic');
    micEl.classList.toggle('ok', mic.ok && !this.micOff);
    micEl.classList.toggle('hot', !!this.micHot && !this.micOff);
    $('#st-mic i').style.height = `${Math.round(Math.min(1, mic.level * 2.5) * 100)}%`;
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
      this.listening = true;
      talk.classList.add('live');
      hush();
      $('#you-said').textContent = 'listening…';
      $('#you-said').classList.add('show');
      listen.onInterim = (txt) => { $('#you-said').textContent = `“${txt}”`; };
      const r = await listen();
      listening = false;
      this.listening = false;
      this.hush(1);
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
    on($('#st-mic'), 'click', () => {
      this.micOff = !this.micOff;
      this.toast(this.micOff ? 'Microphone off. They can\'t hear you, and you can\'t speak to them.' : 'Microphone on. They can hear you now.', 3);
    });
    on($('#st-hp'), 'click', () => this.app.headphoneTest().then((ok) => {
      this.headphones = ok;
      this.toast(ok ? 'Headphones confirmed. Listen closely.' : 'No headphones. Some voices are too quiet to hear.', 3);
    }));

    const keys = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === ' ') { e.preventDefault(); this.snap(); }
      // walking, for desktops (phones count your real footsteps)
      if (e.key === 'w' || e.key === 'W') this.walk(1);
      if (e.key === 's' && !DEBUG) this.walk(-1);
      if (DEBUG && e.key === 'n') this.onNoise(1);
      if (DEBUG && e.key === 'k') { this.nextKnock = 0; }
      if (DEBUG && e.key === 'm') { this.nextMirror = 0; }
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

