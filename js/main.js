// App shell: screens, the preparation wizard, radar, journal, evidence, settings.
import { $, $$, el, rand, sleep, fmtTime } from './util.js';
import { GHOSTS, GHOST_LIST, REQ_LABELS, OUTCOME_TEXT } from './ghosts.js';
import { hauntsNear, compassName, HAUNT_RANGE_M } from './world.js';
import { sensors, requestMotionPermission, startOrientation, hasMotion, startGeo, currentView, detectHeadphones } from './sensors.js';
import { viewForward, azElFromDir } from './world.js';
import { audio } from './audio.js';
import { drawGhost, drawFX } from './render.js';
import { photos, settings, saveSettings, progress, resetAll } from './storage.js';
import { Hunt } from './hunt.js';

const app = {
  hunt: null,
  screen: 'title',

  go(id) {
    if (id === 'prepare' && !settings.seenWarning) id = 'warning';
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    this.screen = id;
    const enter = screens[id];
    if (enter) enter();
  },

  // Left/right knock test. Two correct answers in a row = headphones.
  headphoneTest() {
    return new Promise((resolve) => {
      const modal = $('#hp-test');
      const msg = $('#hp-msg');
      modal.hidden = false;
      let round = 0, correct = 0, side = null;
      const next = async () => {
        side = rand() < 0.5 ? 'left' : 'right';
        msg.textContent = round === 0 ? 'Listen… something will knock.' : 'Again…';
        await audio.unlock();
        await sleep(700);
        audio.knock(side);
      };
      const finish = (ok) => {
        modal.hidden = true;
        modal.onclick = null;
        settings.headphones = ok;
        saveSettings();
        resolve(ok);
      };
      modal.onclick = (e) => {
        const ear = e.target.closest('[data-ear]')?.dataset.ear;
        if (e.target.id === 'hp-cancel') return finish(false);
        if (!ear) return;
        round++;
        if (ear === side) correct++;
        if (round >= 2) {
          msg.textContent = correct === 2 ? 'It knows you can hear it now.' : 'That isn\'t where it knocked.';
          setTimeout(() => finish(correct === 2), 1100);
        } else next();
      };
      next();
    });
  },

  showResults(r) {
    this.hunt = null;
    this.go('results');
    const titles = { fled: 'You fled', ended: 'The hunt is over' };
    $('#res-title').textContent = titles[r.reason] || 'The hunt is over';
    $('#res-sub').textContent = r.reason === 'fled'
      ? 'Your nerve broke. You ran, and something followed you as far as the door.'
      : `${r.when}. ${r.shots.length} exposure${r.shots.length === 1 ? '' : 's'} taken.`;
    $('#res-score').textContent = r.score;
    const enc = $('#res-enc');
    enc.innerHTML = '';
    if (!r.encountered.length) enc.append(el('li', {}, el('span', {}, 'You saw nothing. But you were not alone.'), el('span')));
    for (const e of r.encountered) {
      enc.append(el('li', {}, el('span', {}, GHOSTS[e.type].name), el('span', {}, e.outcome ? OUTCOME_TEXT[e.outcome] : 'Still there')));
    }
    if (r.lore.clues.has('culprit')) enc.append(el('li', {}, el('span', { class: 'fine' }, `You learned the name ${r.lore.culprit}. You wish you hadn't.`), el('span')));
    renderShots($('#res-shots'), r.shots);
  },
};

// ---------------------------------------------------------------------------
const screens = {
  title() {
    const seen = Object.keys(progress.seen).length;
    $('#title-stats').textContent = progress.hunts
      ? `${progress.hunts} hunt${progress.hunts === 1 ? '' : 's'} · ${seen}/${GHOST_LIST.length} spirits documented · best ${progress.bestHunt}`
      : '';
    titleBg.start();
  },
  warning() { titleBg.stop(); },
  prepare() {
    titleBg.stop();
    refreshChecks();
  },
  radar() { titleBg.stop(); radar.start(); },
  journal() { titleBg.stop(); renderJournal(); },
  gallery() { titleBg.stop(); renderGallery(); },
  settings() { titleBg.stop(); renderSettings(); },
  results() { titleBg.stop(); },
};

// ---- preparation -----------------------------------------------------------------
const checks = { motion: null, sound: null, hp: null, geo: null };
function mark(id, ok) {
  const li = $(`#chk-${id}`);
  li.classList.toggle('ok', ok === true);
  li.classList.toggle('bad', ok === false);
}
function refreshChecks() {
  mark('motion', checks.motion ?? (hasMotion() ? true : null));
  mark('sound', checks.sound);
  mark('hp', settings.headphones ? true : checks.hp);
  mark('geo', sensors.geo ? true : checks.geo);
}

async function allowMotion() {
  const ok = await requestMotionPermission();
  startOrientation();
  await sleep(600);
  checks.motion = ok && hasMotion();
  if (!checks.motion) $('#chk-motion small').textContent = 'No motion sensor found — you can drag the screen to look around.';
  refreshChecks();
}

function bindPrepare() {
  $('#accept-warning').onclick = () => { settings.seenWarning = true; saveSettings(); app.go('prepare'); };
  $('#do-motion').onclick = allowMotion;
  $('#do-sound').onclick = async () => {
    const ok = await audio.unlock();
    settings.sound = true;
    saveSettings();
    audio.setEnabled(true);
    audio.testTone();
    checks.sound = ok;
    refreshChecks();
  };
  $('#do-hp').onclick = async () => {
    const detected = await detectHeadphones();
    const ok = await app.headphoneTest();
    checks.hp = ok || detected;
    if (detected && !ok) settings.headphones = true, saveSettings();
    refreshChecks();
  };
  $('#do-geo').onclick = () => {
    startGeo(() => { checks.geo = !!sensors.geo; refreshChecks(); });
  };
  $('#enter-hunt').onclick = async () => {
    // These need to happen inside the tap, for iOS.
    audio.unlock();
    if (checks.motion == null) { requestMotionPermission().then(() => startOrientation()); startOrientation(); }
    audio.setEnabled(settings.sound);
    const haunts = sensors.geo ? hauntsNear(sensors.geo.lat, sensors.geo.lon) : [];
    const h = new Date().getHours();
    app.go('hunt');
    app.hunt = new Hunt(app, { haunts, night: h >= 20 || h < 6 });
    await app.hunt.start();
  };
}

// ---- title background: fog and something standing in it ----------------------------
const titleBg = {
  raf: 0,
  start() {
    if (this.raf) return;
    const c = $('#title-bg');
    const ctx = c.getContext('2d');
    const t0 = performance.now();
    const figure = rand.pick(['hollow', 'weeper', 'wren', 'grinner']);
    let next = 4 + rand() * 6, showAt = -99;
    const loop = (now) => {
      const t = (now - t0) / 1000;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = innerWidth, h = innerHeight;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#050706';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 5; i++) {
        const x = ((t * (8 + i * 3) + i * 400) % (w + 600)) - 300;
        const g = ctx.createRadialGradient(x, h * (0.55 + i * 0.08), 0, x, h * (0.55 + i * 0.08), 320);
        g.addColorStop(0, 'rgba(120,150,130,0.06)');
        g.addColorStop(1, 'rgba(120,150,130,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      if (t > next) { showAt = t; next = t + 9 + rand() * 8; }
      const k = t - showAt;
      if (k < 3) {
        const a = Math.sin((k / 3) * Math.PI) * 0.35 * (Math.random() < 0.1 ? 0.3 : 1);
        drawGhost(ctx, figure, w * 0.78, h * 0.72, h * 0.42, { t, agit: 0.2 }, { alpha: a, glitch: 0.3 });
      }
      drawFX(ctx, w, h, { t, static: 0.1, fear: 0, flash: 0 });
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  },
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; },
};

// ---- radar ------------------------------------------------------------------------
const radar = {
  raf: 0,
  start() {
    startOrientation();
    startGeo(() => this.list());
    this.list();
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.draw(t));
  },
  list() {
    const st = $('#radar-status');
    const ul = $('#radar-list');
    ul.innerHTML = '';
    if (!sensors.geo) {
      st.textContent = sensors.geoError ? `No location: ${sensors.geoError}. The spirits nearest you will still come.` : 'Waiting for your location…';
      return;
    }
    const hs = hauntsNear(sensors.geo.lat, sensors.geo.lon).filter((h) => h.dist < 450);
    this.haunts = hs;
    st.textContent = `${hs.length} presence${hs.length === 1 ? '' : 's'} within 450 m (GPS ±${Math.round(sensors.geo.acc)} m).`;
    for (const h of hs.slice(0, 8)) {
      const known = progress.seen[h.type];
      const near = h.dist <= HAUNT_RANGE_M;
      ul.append(el('li', {}, el('span', {}, near ? (known ? GHOSTS[h.type].name : 'Something') + ' — here' : known ? GHOSTS[h.type].name : 'Unknown presence'),
        el('span', {}, near ? 'in range' : `~${Math.round(h.dist / 10) * 10} m ${compassName(h.bearing)}`)));
    }
  },
  draw(now) {
    if (app.screen !== 'radar') { this.raf = 0; return; }
    const c = $('#radar-canvas');
    const ctx = c.getContext('2d');
    const W = c.width, R = W / 2 - 10, t = now / 1000;
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.translate(W / 2, W / 2);
    const heading = hasMotion() ? azElFromDir(viewForward(currentView())).az : 0;
    ctx.strokeStyle = 'rgba(183,227,196,0.25)';
    for (const r of [0.25, 0.5, 0.75, 1]) { ctx.beginPath(); ctx.arc(0, 0, R * r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.rotate((-heading * Math.PI) / 180);
    ctx.fillStyle = 'rgba(183,227,196,0.6)';
    ctx.font = '20px "Special Elite", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -R + 22);
    const sweep = (t * 1.4) % (Math.PI * 2);
    const g = ctx.createConicGradient ? ctx.createConicGradient(sweep - Math.PI / 2, 0, 0) : null;
    if (g) {
      g.addColorStop(0, 'rgba(183,227,196,0.25)');
      g.addColorStop(0.08, 'rgba(183,227,196,0)');
      g.addColorStop(1, 'rgba(183,227,196,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    }
    for (const h of this.haunts || []) {
      const a = (h.bearing * Math.PI) / 180;
      const d = Math.min(1, h.dist / 450) * R;
      const x = Math.sin(a) * d, y = -Math.cos(a) * d;
      const lag = ((a - sweep + Math.PI * 4) % (Math.PI * 2));
      const fade = Math.max(0.15, 1 - lag / 2.5);
      const r = 6 + h.strength * 10 + Math.sin(t * 3 + h.dist) * 2;
      const bg = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
      const col = GHOSTS[h.type].threat >= 4 ? '255,90,80' : '183,227,196';
      bg.addColorStop(0, `rgba(${col},${0.8 * fade})`);
      bg.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(x, y, r * 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#d9dccf';
    ctx.beginPath(); ctx.arc(W / 2, W / 2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(183,227,196,0.4)';
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.arc(W / 2, W / 2, (HAUNT_RANGE_M / 450) * R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    this.raf = requestAnimationFrame((n) => this.draw(n));
  },
};

// ---- journal ------------------------------------------------------------------------
function renderJournal() {
  const list = $('#journal-list');
  list.innerHTML = '';
  for (const g of GHOST_LIST) {
    const seen = progress.seen[g.id];
    const cv = el('canvas', { width: 440, height: 300 });
    const reqs = Object.keys(g.requires).filter((k) => g.requires[k]).map((k) => `${REQ_LABELS[k].icon} ${REQ_LABELS[k].label}`);
    const entry = el('article', { class: `entry ${seen ? '' : 'unknown'}` },
      cv,
      el('h4', {}, seen ? g.name : '???'),
      el('p', { class: 'ep' }, seen ? g.epithet : 'Not yet documented'),
      el('div', { class: 'meta' },
        el('span', { class: 'threat' }, seen ? '☠'.repeat(Math.max(1, g.threat)) + '·'.repeat(5 - Math.max(1, g.threat)) : '·····'),
        ...(reqs.length ? reqs : ['Appears anywhere']).map((r) => el('span', {}, seen ? r : r.split(' ')[0] + ' ?'))),
      seen ? el('p', {}, g.lore) : el('p', {}, 'You have heard rumours. Nothing more.'),
      seen && progress.learned[g.id] ? el('p', { class: 'want' }, g.wantText) : seen ? el('p', { class: 'fine' }, 'Talk to it to learn what it wants.') : null,
      seen ? el('div', { class: 'meta' },
        el('span', {}, `Seen ${seen}×`),
        progress.photographed[g.id] ? el('span', {}, `Best photo ${progress.photographed[g.id]}`) : el('span', {}, 'No photo'),
        ...(progress.outcomes[g.id] || []).map((o) => el('span', {}, OUTCOME_TEXT[o]))) : null,
    );
    list.append(entry);
    const ctx = cv.getContext('2d');
    const draw = () => {
      ctx.clearRect(0, 0, 440, 300);
      drawGhost(ctx, g.id, 220, 150, 270, { t: performance.now() / 1000, agit: 0.15 }, { alpha: seen ? 0.95 : 0.0 });
      if (!seen) {
        ctx.fillStyle = 'rgba(80,90,80,0.5)';
        ctx.font = '120px "IM Fell English", serif';
        ctx.textAlign = 'center';
        ctx.fillText('?', 220, 190);
      }
    };
    draw();
  }
}

// ---- gallery -----------------------------------------------------------------------
function renderShots(container, list) {
  container.innerHTML = '';
  if (!list.length) { container.append(el('p', { class: 'empty' }, 'No photographs. Tap the screen during a hunt when they show themselves.')); return; }
  for (const s of list) {
    const label = s.ghosts.length ? s.ghosts.map((g) => (g.spirit ? '? ' : '') + GHOSTS[g.type].name.replace(/^The /, '')).join(', ') : 'nothing';
    const b = el('button', { class: 'shot', style: `--r:${(rand() * 6 - 3).toFixed(1)}deg`, onclick: () => openViewer(s) },
      el('img', { src: s.img, alt: label, loading: 'lazy' }), el('span', {}, `${label} · ${s.score}`));
    container.append(b);
  }
}

async function renderGallery() {
  renderShots($('#gallery-grid'), await photos.all());
}

function openViewer(s) {
  const v = $('#viewer');
  v.hidden = false;
  $('#viewer-img').src = s.img;
  const names = s.ghosts.map((g) => `${GHOSTS[g.type].name}${g.spirit ? ' (spirit photo)' : ''} +${g.pts}`);
  $('#viewer-cap').textContent = `${fmtTime(s.time)} — ${names.length ? names.join(' · ') : 'Nothing visible.'}`;
  const dl = $('#viewer-dl');
  dl.href = s.img;
  dl.download = `ghosty-${s.id}.jpg`;
  $('#viewer-close').onclick = () => { v.hidden = true; };
  $('#viewer-del').onclick = async () => { await photos.remove(s.id); v.hidden = true; renderGallery(); };
  const share = $('#viewer-share');
  share.hidden = !navigator.share;
  share.onclick = async () => {
    try {
      const blob = await (await fetch(s.img)).blob();
      const file = new File([blob], `ghosty-${s.id}.jpg`, { type: 'image/jpeg' });
      await navigator.share({ files: [file], title: 'I caught something', text: names.join(', ') || 'Something was there.' });
    } catch { /* cancelled */ }
  };
}

// ---- settings ----------------------------------------------------------------------
function renderSettings() {
  const bindCheck = (id, key) => { const i = $(id); i.checked = !!settings[key]; i.onchange = () => { settings[key] = i.checked; saveSettings(); if (key === 'sound') audio.setEnabled(i.checked); }; };
  bindCheck('#set-sound', 'sound');
  bindCheck('#set-scares', 'jumpscares');
  bindCheck('#set-subs', 'subtitles');
  const intensity = $('#set-intensity');
  intensity.value = String(settings.intensity);
  intensity.onchange = () => { settings.intensity = Number(intensity.value); saveSettings(); };
  const film = $('#set-film');
  film.value = String(settings.film);
  film.onchange = () => { settings.film = Number(film.value); saveSettings(); };
  $('#set-hp-state').textContent = settings.headphones ? '(confirmed)' : '';
  $('#set-hp').onclick = async () => { await app.headphoneTest(); renderSettings(); };
  $('#set-cal').onclick = () => { settings.lightCal = null; saveSettings(); $('#set-cal').textContent = 'Done'; };
  $('#set-reset').onclick = async () => {
    if (!confirm('Erase your journal, scores and every photograph?')) return;
    await resetAll();
    location.reload();
  };
}

// ---- boot ---------------------------------------------------------------------------
function buildCompass() {
  const strip = $('#compass-strip');
  const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  for (let copy = 0; copy < 3; copy++) {
    for (let d = 0; d < 360; d += 15) {
      const s = document.createElement('span');
      s.style.left = `${copy * 1440 + d * 4}px`;
      s.textContent = names[d] ?? '·';
      if (names[d] && d % 90 === 0) s.className = 'card';
      strip.append(s);
    }
  }
}

function boot() {
  buildCompass();
  bindPrepare();
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (!go) return;
    if (app.hunt && go.dataset.go !== 'hunt') return;
    app.go(go.dataset.go);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && audio.ctx) audio.ctx.suspend();
    else if (!document.hidden && audio.ctx && app.hunt) audio.ctx.resume();
  });
  audio.enabled = settings.sound;
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  app.go('title');
}

boot();
window.__ghosty = app;
