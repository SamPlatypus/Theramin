/*
 * Touch Theremin: UI, input and visuals.
 * X → pitch (equal width per semitone), Y → volume (top = loud).
 */
(function () {
  'use strict';

  var NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  var IS_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];
  var STORAGE_KEY = 'theremin.settings.v1';
  var DEFAULTS = { wave: 'classic', reverb: 35, vibrato: 45, glide: 35, range: 2, low: 60, assist: 'off' };
  var WAVE_NAMES = ['classic', 'sine', 'triangle', 'sawtooth', 'square'];
  var ASSISTS = ['off', 'gentle', 'snap'];
  var LOW_MIN = 36;   // C2
  var LOW_MAX = 72;   // C5
  var TRAIL_MS = 650;
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function mod(n, m) { return ((n % m) + m) % m; }
  function noteLabel(m) { return NOTE_NAMES[mod(m, 12)] + (Math.floor(m / 12) - 1); }
  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function now() { return performance.now(); }

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    var s = {}, k;
    for (k in DEFAULTS) s[k] = DEFAULTS[k];
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        for (k in DEFAULTS) if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
      }
    } catch (e) { /* storage unavailable: use defaults */ }
    if (WAVE_NAMES.indexOf(s.wave) < 0) s.wave = DEFAULTS.wave;
    if (ASSISTS.indexOf(s.assist) < 0) s.assist = DEFAULTS.assist;
    s.range = clamp(Math.round(s.range), 1, 4);
    s.low = clamp(Math.round(s.low / 12) * 12, LOW_MIN, LOW_MAX);
    ['reverb', 'vibrato', 'glide'].forEach(function (key) { s[key] = clamp(Math.round(s[key]), 0, 100); });
    return s;
  }

  var S = loadSettings();
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- audio

  var engine = new window.ThereminEngine({
    wave: S.wave, reverb: S.reverb / 100, vibrato: S.vibrato / 100, glide: S.glide / 100
  });
  var muted = false;

  function startAudio() {
    engine.start();
    requestWakeLock();
  }

  // ---------------------------------------------------------------- DOM

  var app = $('app'), stage = $('stage'), canvas = $('canvas');
  var cx = canvas.getContext('2d');
  var grid = document.createElement('canvas');
  var gx = grid.getContext('2d');
  var intro = $('intro'), mutedBadge = $('mutedBadge'), toastEl = $('toast');
  var readout = $('readout'), noteNameEl = $('noteName'), noteOctEl = $('noteOct');
  var hzEl = $('hz'), centsEl = $('cents'), needle = $('needle');

  // ---------------------------------------------------------------- geometry

  var W = 1, H = 1, DPR = 1, KEY_H = 32;

  function span() { return S.range * 12 + 1; }                // semitone columns, both end notes included
  function xToSemi(x) { return S.low - 0.5 + (x / W) * span(); }
  function semiToX(s) { return ((s - S.low + 0.5) / span()) * W; }
  function yToVol(y) { return clamp(1 - y / H, 0, 1); }
  function hueFor(s) { return 330 - clamp((s - S.low) / (S.range * 12), 0, 1) * 145; } // pink → violet → cyan

  /** Optional pitch assistance: pulls the pitch toward the nearest semitone. */
  function assist(s) {
    if (S.assist === 'off') return s;
    var n = Math.round(s);
    if (S.assist === 'snap') return n;
    var d = s - n; // gentle: continuous curve, flat near the note centre
    return n + (d < 0 ? -1 : 1) * 0.5 * Math.pow(Math.abs(d) * 2, 2.2);
  }

  function resize() {
    var r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    DPR = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = grid.width = Math.round(W * DPR);
    canvas.height = grid.height = Math.round(H * DPR);
    KEY_H = clamp(Math.round(H * 0.075), 28, 42);
    drawGrid();
    kick();
  }

  // ---------------------------------------------------------------- static guide layer

  function drawGrid() {
    var g = gx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    var playH = H - KEY_H;

    // Brighter toward the top, where it is louder.
    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1a1534');
    bg.addColorStop(0.65, '#0d0b1b');
    bg.addColorStop(1, '#08070f');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // Colour wash: each pitch region has its own hue.
    var wash = g.createLinearGradient(0, 0, W, 0);
    for (var i = 0; i <= 4; i++) {
      wash.addColorStop(i / 4, 'hsla(' + (330 - i / 4 * 145) + ',90%,60%,0.08)');
    }
    g.fillStyle = wash;
    g.fillRect(0, 0, W, playH);

    var cols = span(), cw = W / cols;

    // Semitone columns: sharps get a darker band, like the black keys of a piano.
    for (i = 0; i < cols; i++) {
      var m = S.low + i, pc = mod(m, 12), x0 = i * cw;
      if (IS_SHARP[pc]) {
        g.fillStyle = 'rgba(0,0,0,0.24)';
        g.fillRect(x0, 0, cw, playH);
      }
      var xc = Math.round((x0 + cw / 2) * DPR) / DPR;
      g.fillStyle = pc === 0 ? 'rgba(255,255,255,0.22)' : IS_SHARP[pc] ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.085)';
      g.fillRect(xc - 0.5, 0, 1, playH);
    }

    // Volume guide: dashed lines at 25/50/75 %.
    g.save();
    g.setLineDash([3, 7]);
    g.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (v) {
      var y = Math.round(H * (1 - v)) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,' + (v === 0.5 ? 0.13 : 0.08) + ')';
      g.beginPath(); g.moveTo(22, y); g.lineTo(W, y); g.stroke();
    });
    g.restore();

    // Volume meter rail on the left edge.
    var railTop = 34, railBot = playH - 30;
    var rail = g.createLinearGradient(0, railTop, 0, railBot);
    rail.addColorStop(0, 'rgba(255,255,255,0.6)');
    rail.addColorStop(1, 'rgba(255,255,255,0.04)');
    g.fillStyle = rail;
    roundRect(g, 9, railTop, 4, Math.max(0, railBot - railTop), 2);
    g.fill();

    g.font = '700 10px ' + FONT;
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText('LOUD', 8, 18);
    g.fillStyle = 'rgba(255,255,255,0.42)';
    g.fillText('SOFT', 8, playH - 14);

    // Note strip along the bottom: the keyboard you are playing over.
    var ky = playH;
    g.fillStyle = 'rgba(6,6,12,0.92)';
    g.fillRect(0, ky, W, KEY_H);
    for (i = 0; i < cols; i++) {
      m = S.low + i; pc = mod(m, 12); x0 = i * cw;
      var sharp = IS_SHARP[pc];
      g.fillStyle = pc === 0 ? 'rgba(255,255,255,0.2)' : sharp ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.11)';
      g.fillRect(x0 + 0.5, ky + 3, Math.max(1, cw - 1), KEY_H - 6);
      var label = null;
      if (pc === 0) label = noteLabel(m);                 // C's always carry their octave
      else if (!sharp && cw >= 11) label = NOTE_NAMES[pc];
      else if (sharp && cw >= 22) label = NOTE_NAMES[pc];
      if (label) {
        g.font = (pc === 0 ? '700 ' : '600 ') + (cw < 15 && pc === 0 ? 9 : 10.5) + 'px ' + FONT;
        g.textAlign = 'center';
        g.fillStyle = pc === 0 ? 'rgba(255,255,255,0.95)' : sharp ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.62)';
        g.fillText(label, x0 + cw / 2, ky + KEY_H / 2 + 0.5);
        g.textAlign = 'left';
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, ky, W, 1);
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ---------------------------------------------------------------- touch input

  var pointers = new Map();
  var order = 0, activeId = null, rect = null;
  var voice = { x: 0, y: 0, semi: S.low + 12, vol: 0, playing: false, releasedAt: -1e9, shownSemi: S.low + 12 };
  var hasPlayed = false, introDone = false;
  var trail = [], ripples = [];
  var animUntil = 0;

  function kick(ms) { animUntil = Math.max(animUntil, now() + (ms || 1800)); }

  function localPoint(e) {
    return { x: clamp(e.clientX - rect.left, 0, W), y: clamp(e.clientY - rect.top, 0, H) };
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    startAudio();
    if (!introDone) hideIntro();
    rect = canvas.getBoundingClientRect();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    var p = localPoint(e);
    pointers.set(e.pointerId, { x: p.x, y: p.y, order: ++order });
    activeId = e.pointerId;
    hasPlayed = true;
    ripples.push({ x: p.x, y: p.y, t: now() });
    if (muted) nudgeMuted();
    playAt(p.x, p.y);
  }

  function onMove(e) {
    var ptr = pointers.get(e.pointerId);
    if (!ptr) return;
    e.preventDefault();
    var p = localPoint(e);
    ptr.x = p.x; ptr.y = p.y;
    if (e.pointerId === activeId) playAt(p.x, p.y);
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (e.pointerId !== activeId) return;
    // Monophonic like the real thing: fall back to the newest finger still down (legato).
    var next = null, best = -1;
    pointers.forEach(function (p, id) { if (p.order > best) { best = p.order; next = id; } });
    if (next !== null) {
      activeId = next;
      var p = pointers.get(next);
      playAt(p.x, p.y);
    } else {
      activeId = null;
      voice.playing = false;
      voice.releasedAt = now();
      engine.release();
      kick(2500);
    }
  }

  function releaseAll() {
    pointers.clear();
    if (activeId !== null || voice.playing) {
      activeId = null;
      voice.playing = false;
      voice.releasedAt = now();
      engine.release();
    }
  }

  function playAt(x, y) {
    var semi = assist(xToSemi(x));
    var vol = yToVol(y);
    if (!voice.playing) voice.shownSemi = semi;
    voice.x = x; voice.y = y; voice.semi = semi; voice.vol = vol; voice.playing = true;
    engine.play(semi, vol);
    trail.push({ x: x, y: y, t: now(), v: vol });
    kick();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // Stop iOS pinch-zoom and long-press magnifier.
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });
  // Some browsers only allow audio to start after the finger lifts.
  document.addEventListener('touchend', function () { if (engine.ctx) engine.resume(); }, { passive: true });

  // ---------------------------------------------------------------- intro

  function hideIntro() {
    introDone = true;
    intro.classList.add('hide');
    kick(60000);
  }
  intro.addEventListener('click', function () { startAudio(); hideIntro(); });

  // ---------------------------------------------------------------- render loop

  var lastReadoutKey = '';

  function frame(t) {
    requestAnimationFrame(frame);
    engine.tick(t);
    var ghost = introDone && !hasPlayed;
    if (!voice.playing && !ghost && t > animUntil) return;

    var c = cx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.globalAlpha = 1;
    c.drawImage(grid, 0, 0, W, H);

    // Glide the on-screen pitch marker the way the sound glides.
    var k = 1 - Math.exp(-16 / (1000 * (0.004 + Math.pow(S.glide / 100, 2) * 0.2) + 16));
    voice.shownSemi += (voice.semi - voice.shownSemi) * k;

    var since = (t - voice.releasedAt) / 1000;
    var fade = voice.playing ? 1 : Math.max(0, 1 - since / 0.45);
    var hue = hueFor(voice.shownSemi);
    var wave = engine.getWaveform();
    var level = 0;
    if (wave) {
      for (var i = 0; i < wave.length; i += 4) level += wave[i] * wave[i];
      level = Math.sqrt(level / (wave.length / 4));
    }

    if (fade > 0 || level > 0.002) drawPitchBand(c, hue, Math.max(fade, Math.min(1, level * 6)));
    if (wave && level > 0.0015) drawScope(c, wave, level, hue);
    drawTrail(c, t, hue);
    drawRipples(c, t, hue);
    if (fade > 0) drawFinger(c, t, hue, fade);
    drawKeyHighlight(c, hue, voice.playing ? 1 : fade);
    if (ghost) drawGhost(c, t);

    updateReadout();
  }

  function hsla(h, s, l, a) { return 'hsla(' + h.toFixed(1) + ',' + s + '%,' + l + '%,' + a.toFixed(3) + ')'; }

  function drawPitchBand(c, hue, a) {
    var x = semiToX(voice.shownSemi), bw = Math.max(18, W / span() * 1.4);
    var g = c.createLinearGradient(x - bw, 0, x + bw, 0);
    g.addColorStop(0, hsla(hue, 90, 60, 0));
    g.addColorStop(0.5, hsla(hue, 90, 65, 0.2 * a));
    g.addColorStop(1, hsla(hue, 90, 60, 0));
    c.fillStyle = g;
    c.fillRect(x - bw, 0, bw * 2, H - KEY_H);
    c.fillStyle = hsla(hue, 95, 75, 0.55 * a);
    c.fillRect(x - 0.75, 0, 1.5, H - KEY_H);
  }

  /** Live oscilloscope through the finger: shows the waveform and how loud it is. */
  function drawScope(c, d, level, hue) {
    var n = d.length, start = 0;
    for (var i = 1; i < n / 2; i++) { if (d[i - 1] < 0 && d[i] >= 0) { start = i; break; } }
    var period = engine.sampleRate() / midiToHz(voice.shownSemi);
    var count = Math.min(n - start - 1, Math.max(64, Math.round(period * 3)));
    var cy = clamp(voice.y, 24, H - KEY_H - 24);
    var amp = Math.min(H * 0.3, 150);
    c.beginPath();
    for (i = 0; i <= count; i++) {
      var x = (i / count) * W;
      var y = cy - d[start + i] * amp;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    var a = clamp(level * 5, 0.15, 1);
    c.lineJoin = 'round';
    c.strokeStyle = hsla(hue, 95, 65, 0.16 * a);
    c.lineWidth = 7;
    c.stroke();
    c.strokeStyle = hsla(hue, 95, 78, 0.6 * a);
    c.lineWidth = 1.6;
    c.stroke();
  }

  function drawTrail(c, t, hue) {
    while (trail.length && t - trail[0].t > TRAIL_MS) trail.shift();
    if (trail.length < 2) return;
    c.lineCap = 'round';
    for (var i = 1; i < trail.length; i++) {
      var p0 = trail[i - 1], p1 = trail[i];
      var life = 1 - (t - p1.t) / TRAIL_MS;
      if (life <= 0) continue;
      c.strokeStyle = hsla(hue, 95, 72, 0.5 * life * life);
      c.lineWidth = 2 + 10 * p1.v * life;
      c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.stroke();
    }
  }

  function drawRipples(c, t, hue) {
    for (var i = ripples.length - 1; i >= 0; i--) {
      var r = ripples[i], life = (t - r.t) / 700;
      if (life >= 1) { ripples.splice(i, 1); continue; }
      c.strokeStyle = hsla(hue, 95, 75, 0.55 * (1 - life));
      c.lineWidth = 2;
      c.beginPath(); c.arc(r.x, r.y, 14 + life * 70, 0, Math.PI * 2); c.stroke();
    }
  }

  function drawFinger(c, t, hue, a) {
    var x = voice.x, y = voice.y, v = voice.vol, playH = H - KEY_H;

    // Crosshair to the guides: down to the note strip, left to the volume rail.
    c.save();
    c.setLineDash([4, 6]);
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,' + (0.28 * a).toFixed(3) + ')';
    c.beginPath();
    c.moveTo(x + 0.5, Math.min(y + 18, playH)); c.lineTo(x + 0.5, playH);
    c.moveTo(Math.max(x - 18, 16), y + 0.5); c.lineTo(16, y + 0.5);
    c.stroke();
    c.restore();

    // Level marker on the volume rail.
    var railTop = 34, railBot = playH - 30, my = clamp(y, railTop, railBot);
    c.fillStyle = hsla(hue, 95, 78, a);
    c.beginPath(); c.arc(11, my, 5.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,' + (0.9 * a).toFixed(3) + ')';
    c.font = '700 11px ' + FONT;
    c.textBaseline = 'middle';
    c.fillText(Math.round(v * 100) + '%', 22, clamp(my, railTop + 2, railBot - 2) - 14);

    // The glowing orb: bigger and brighter when louder.
    var pulse = 1 + 0.05 * Math.sin(t / 95);
    var r = (16 + 30 * v) * pulse;
    var g = c.createRadialGradient(x, y, 0, x, y, r * 2.2);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.95 * a).toFixed(3) + ')');
    g.addColorStop(0.18, hsla(hue, 100, 82, 0.9 * a));
    g.addColorStop(0.45, hsla(hue, 95, 62, 0.35 * a));
    g.addColorStop(1, hsla(hue, 95, 55, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r * 2.2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,' + (0.55 * a).toFixed(3) + ')';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
  }

  function drawKeyHighlight(c, hue, a) {
    if (a <= 0 || !hasPlayed) return;
    var cw = W / span(), ky = H - KEY_H;
    var n = Math.round(voice.shownSemi), i = n - S.low;
    if (i >= 0 && i < span()) {
      var x0 = i * cw;
      c.fillStyle = hsla(hue, 95, 65, 0.75 * a);
      c.fillRect(x0 + 0.5, ky + 3, Math.max(1, cw - 1), KEY_H - 6);
      var pc = mod(n, 12), label = null;
      if (pc === 0 || cw >= 26) label = noteLabel(n);
      else if (cw >= 17) label = NOTE_NAMES[pc];
      else if (cw >= 11) label = NOTE_NAMES[pc].charAt(0);
      if (label) {
        c.fillStyle = 'rgba(10,8,20,' + (0.95 * a).toFixed(3) + ')';
        c.font = '800 ' + (cw < 15 ? 9 : 10.5) + 'px ' + FONT;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(label, x0 + cw / 2, ky + KEY_H / 2 + 0.5);
        c.textAlign = 'left';
      }
    }
    // Exact pitch pointer on top of the strip.
    var px = semiToX(voice.shownSemi);
    c.fillStyle = 'rgba(255,255,255,' + (0.95 * a).toFixed(3) + ')';
    c.beginPath(); c.moveTo(px - 5, ky - 1); c.lineTo(px + 5, ky - 1); c.lineTo(px, ky + 5); c.closePath(); c.fill();
  }

  /** Before the first touch: a ghost finger drifting around, showing what to do. */
  function drawGhost(c, t) {
    var s = t / 1000, playH = H - KEY_H;
    var x = W * (0.5 + 0.3 * Math.sin(s * 0.9));
    var y = playH * (0.52 - 0.22 * Math.sin(s * 1.8));
    var g = c.createRadialGradient(x, y, 0, x, y, 46);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.3, 'rgba(200,185,255,0.25)');
    g.addColorStop(1, 'rgba(164,135,255,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, 46, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(x, y, 18 + 3 * Math.sin(s * 4), 0, Math.PI * 2); c.stroke();

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '700 17px ' + FONT;
    c.fillStyle = 'rgba(255,255,255,0.88)';
    c.fillText('Touch & slide anywhere', W / 2, playH * 0.16);
    c.font = '500 13px ' + FONT;
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fillText('← lower · pitch · higher →     ↑ louder', W / 2, playH * 0.16 + 22);
    c.textAlign = 'left';
  }

  // ---------------------------------------------------------------- readout

  function updateReadout() {
    if (!hasPlayed) return;
    var s = voice.semi, n = Math.round(s), cents = Math.round((s - n) * 100);
    var key = (voice.playing ? 1 : 0) + ':' + n + ':' + cents + ':' + s.toFixed(1);
    if (key === lastReadoutKey) return;
    lastReadoutKey = key;
    noteNameEl.textContent = NOTE_NAMES[mod(n, 12)];
    noteOctEl.textContent = String(Math.floor(n / 12) - 1);
    var hz = midiToHz(s);
    hzEl.textContent = hz >= 1000 ? hz.toFixed(0) : hz.toFixed(1);
    centsEl.textContent = (cents > 0 ? '+' : cents < 0 ? '−' : '±') + Math.abs(cents) + '¢';
    needle.style.left = (50 + clamp(cents, -50, 50)) + '%';
    readout.classList.toggle('in-tune', Math.abs(cents) <= 5);
    readout.classList.toggle('idle', !voice.playing);
  }

  // ---------------------------------------------------------------- controls

  function setChecked(group, attr, value) {
    var items = group.querySelectorAll('[role="radio"]');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute(attr) === String(value);
      items[i].setAttribute('aria-checked', on ? 'true' : 'false');
      items[i].tabIndex = on ? 0 : -1;
    }
  }

  function radioKeys(group, handler) {
    group.addEventListener('keydown', function (e) {
      var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      var items = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]'));
      var idx = items.indexOf(document.activeElement);
      var next = items[mod((idx < 0 ? 0 : idx) + keys[e.key], items.length)];
      next.focus();
      handler(next);
    });
  }

  // Waveform
  var wavePicker = $('wavePicker');
  function selectWave(btn) {
    S.wave = btn.getAttribute('data-wave');
    setChecked(wavePicker, 'data-wave', S.wave);
    engine.setWave(S.wave);
    save();
  }
  wavePicker.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-wave]');
    if (btn) selectWave(btn);
  });
  radioKeys(wavePicker, selectWave);

  // Sliders
  function bindSlider(id, key, apply) {
    var input = $(id), out = $(id + 'Out');
    function sync() {
      input.value = S[key];
      input.style.setProperty('--fill', S[key] + '%');
      out.textContent = S[key] + '%';
    }
    input.addEventListener('input', function () {
      S[key] = clamp(Math.round(+input.value), 0, 100);
      sync();
      apply(S[key] / 100);
      save();
    });
    sync();
  }
  bindSlider('reverb', 'reverb', function (v) { engine.setReverb(v); });
  bindSlider('vibrato', 'vibrato', function (v) { engine.setVibrato(v); });
  bindSlider('glide', 'glide', function (v) { engine.setGlide(v); });

  // Mute
  var muteBtn = $('muteBtn');
  function setMuted(m) {
    muted = m;
    engine.setMuted(m);
    muteBtn.setAttribute('aria-pressed', m ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
    mutedBadge.classList.toggle('show', m);
  }
  muteBtn.addEventListener('click', function () { setMuted(!muted); });
  function nudgeMuted() {
    mutedBadge.classList.remove('nudge');
    void mutedBadge.offsetWidth;
    mutedBadge.classList.add('nudge');
  }

  // Settings sheet
  var backdrop = $('sheetBackdrop'), sheet = $('sheet'), settingsBtn = $('settingsBtn');
  var rangeSeg = $('rangeSeg'), assistSeg = $('assistSeg');

  function openSheet() {
    releaseAll();
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');
    if ('inert' in backdrop) backdrop.inert = false;
    setTimeout(function () { $('sheetClose').focus(); }, 50);
  }
  function closeSheet() {
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
    if ('inert' in backdrop) backdrop.inert = true;
    settingsBtn.focus();
  }
  if ('inert' in backdrop) backdrop.inert = true;
  settingsBtn.addEventListener('click', openSheet);
  $('sheetClose').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeSheet(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) closeSheet();
  });

  function syncRange() {
    setChecked(rangeSeg, 'data-value', S.range);
    $('rangeHint').textContent = noteLabel(S.low) + ' – ' + noteLabel(S.low + S.range * 12);
    $('lowOut').textContent = noteLabel(S.low);
    $('lowDown').disabled = S.low <= LOW_MIN;
    $('lowUp').disabled = S.low >= LOW_MAX;
    drawGrid();
    kick();
  }
  function selectRange(btn) { S.range = +btn.getAttribute('data-value'); syncRange(); save(); }
  rangeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-value]'); if (b) selectRange(b);
  });
  radioKeys(rangeSeg, selectRange);
  $('lowDown').addEventListener('click', function () { S.low = clamp(S.low - 12, LOW_MIN, LOW_MAX); syncRange(); save(); });
  $('lowUp').addEventListener('click', function () { S.low = clamp(S.low + 12, LOW_MIN, LOW_MAX); syncRange(); save(); });

  function selectAssist(btn) { S.assist = btn.getAttribute('data-value'); setChecked(assistSeg, 'data-value', S.assist); save(); }
  assistSeg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-value]'); if (b) selectAssist(b);
  });
  radioKeys(assistSeg, selectAssist);

  // ---------------------------------------------------------------- toast

  var toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  // ---------------------------------------------------------------- lifecycle

  var wakeLock = null;
  function requestWakeLock() {
    if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* not allowed: fine */ });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      releaseAll();
      engine.suspend();
    } else if (introDone) {
      engine.resume();
      requestWakeLock();
    }
  });
  window.addEventListener('blur', releaseAll);

  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      var firstInstall = !navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        var sw = reg.installing || reg.waiting;
        if (firstInstall && sw) {
          sw.addEventListener('statechange', function () {
            if (sw.state === 'activated') toast('Ready to play offline');
          });
        }
      }).catch(function () { /* offline support unavailable */ });
    });
  }

  // ---------------------------------------------------------------- init

  setChecked(wavePicker, 'data-wave', S.wave);
  setChecked(assistSeg, 'data-value', S.assist);
  syncRange();
  resize();
  requestAnimationFrame(frame);

  // Handy for debugging from the console.
  window.theremin = { engine: engine, settings: S, voice: voice };
})();
