/*
 * Theremin audio engine (Web Audio API, no external assets).
 *
 * Signal path:
 *   osc ─ trim ─ amp ─ drive ─ tone(lowpass) ─ dcBlock ─ voice ─┬─ dry ───────────────────┐
 *    ▲                                                          ├─ send ─ preDelay ─ conv ─ wet ┤
 *   lfo ─ vib (cents into osc.detune)                           └─ analyser               │
 *                                                                        master(mute) ─ limiter ─ out
 *
 * Expressive touches:
 *  - Pitch runs through osc.detune (cents), so glides are smooth in musical (log) space.
 *  - Volume is mapped in decibels, and the amp sits in front of a soft saturator, so louder
 *    notes also get richer in harmonics, the way acoustic instruments do.
 *  - The lowpass follows pitch and volume: quiet is dark, loud is bright.
 *  - Vibrato fades in once the finger settles on a note and drops out while it is moving.
 *    The rate drifts slightly so it never sounds mechanical.
 */
(function (global) {
  'use strict';

  var MAX_GAIN = 0.7;        // amp level at the top of the stage (feeds the saturator)
  var VOL_RANGE_DB = 34;     // dynamic range from bottom to top of the stage
  var SILENCE_ZONE = 0.05;   // bottom 5% fades to true silence, so swells can start from nothing
  var ATTACK_TC = 0.012;     // time constants (seconds) for setTargetAtTime
  var RELEASE_TC = 0.09;
  var VOL_TC = 0.018;
  var MIN_NOTE_MS = 70;      // very quick taps still give a short, round note
  var MAX_VIB_CENTS = 28;
  var WET_LEVEL = 1.15;

  // "Classic" voice: a rounded, slightly lopsided sine with a soft vocal overtone series
  // (2nd harmonic about -11 dB, 3rd about -17 dB), in the spirit of a vintage theremin.
  // Fourier terms: real = cosine terms, imag = sine terms, index = harmonic number.
  var WAVES = {
    classic:  { real: [0, 0, 0.28, 0, -0.07, 0, 0.02, 0], imag: [0, 1, 0, -0.14, 0, 0.04, 0, -0.012], level: 1.1 },
    sine:     { type: 'sine', level: 0.95 },
    triangle: { type: 'triangle', level: 1.05 },
    sawtooth: { type: 'sawtooth', level: 0.8 },
    square:   { type: 'square', level: 0.55 }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function nowMs() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  function noop() {}

  /** Stage height position (0 = bottom, 1 = top) → linear gain. */
  function volToGain(v) {
    if (v <= 0) return 0;
    var g = Math.pow(10, (-VOL_RANGE_DB * (1 - v)) / 20);
    if (v < SILENCE_ZONE) g *= v / SILENCE_ZONE;
    return g;
  }

  function makeDriveCurve(k) {
    var n = 4096, curve = new Float32Array(n), norm = Math.tanh(k);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
  }

  /**
   * Synthesises a stereo hall impulse response: decaying noise that gets darker over
   * time, a short diffuse build-up and a few sparse early reflections.
   */
  function makeImpulse(ctx, seconds) {
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    var t60 = seconds * 0.85;
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var lp = 0, a = 0, comp = 1;
      for (var i = 0; i < len; i++) {
        if ((i & 63) === 0) {
          var tt = i / rate;
          var fc = 8500 * Math.exp(-tt * 1.4) + 700;   // the tail loses its highs
          a = Math.exp(-2 * Math.PI * fc / rate);
          comp = Math.sqrt((1 + a) / (1 - a));          // keep energy constant while darkening
        }
        lp = (1 - a) * (Math.random() * 2 - 1) + a * lp;
        d[i] = lp * comp * Math.exp(-6.9 * (i / rate) / t60);
      }
      var build = Math.floor(rate * 0.015);
      for (i = 0; i < build; i++) d[i] *= i / build;
      for (var k = 0; k < 10; k++) {
        var idx = Math.floor(rate * (0.007 + Math.random() * 0.065));
        d[idx] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - k * 0.05);
      }
    }
    return buf;
  }

  function ThereminEngine(opts) {
    opts = opts || {};
    this.ctx = null;
    this.n = null;
    this.settings = {
      wave: opts.wave || 'classic',
      reverb: opts.reverb != null ? opts.reverb : 0.35,
      vibrato: opts.vibrato != null ? opts.vibrato : 0.45,
      glide: opts.glide != null ? opts.glide : 0.35,
      muted: !!opts.muted
    };
    this.playing = false;
    this.semi = 69;
    this.vol = 0;
    this._noteStart = 0;
    this._settleStart = 0;
    this._prevSemi = 69;
    this._speed = 0;
    this._lastTick = 0;
    this._vibTarget = 0;
    this._driftAt = 0;
    this._periodic = null;
    this._scope = null;
    this._scopeBytes = null;
    // For rendering with an OfflineAudioContext (tests, demos): a simulated ms clock.
    this.clock = opts.clock || nowMs;
    this.offline = !!opts.offline;
  }

  var P = ThereminEngine.prototype;

  /** Create/resume the AudioContext. Call synchronously from a user gesture. */
  P.start = function () {
    if (!this.ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      // Play through the iOS ringer/silent switch, like a music app.
      try { if (global.navigator && navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* unsupported */ }
      var ctx;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      this.attach(ctx);
      try { // legacy iOS unlock: play one silent sample inside the gesture
        var b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch (e) { /* ignore */ }
    }
    this.resume();
    return true;
  };

  P.resume = function () {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      var p = this.ctx.resume();
      if (p && p.catch) p.catch(noop);
    }
  };

  P.suspend = function () {
    if (this.ctx && this.ctx.state === 'running' && this.ctx.suspend) {
      var p = this.ctx.suspend();
      if (p && p.catch) p.catch(noop);
    }
  };

  P.isRunning = function () { return !!this.ctx && this.ctx.state === 'running'; };

  /** Build the graph on a given context (also used with OfflineAudioContext in tests). */
  P.attach = function (ctx) {
    this.ctx = ctx;
    var n = this.n = {};

    n.osc = ctx.createOscillator();
    n.osc.frequency.value = 440;
    n.osc.detune.value = (this.semi - 69) * 100;

    n.lfo = ctx.createOscillator();
    n.lfo.type = 'sine';
    n.lfo.frequency.value = 5.5;
    n.vib = ctx.createGain();
    n.vib.gain.value = 0;
    n.lfo.connect(n.vib);
    n.vib.connect(n.osc.detune);

    n.trim = ctx.createGain();
    n.amp = ctx.createGain();
    n.amp.gain.value = 0;
    n.drive = ctx.createWaveShaper();
    n.drive.curve = makeDriveCurve(1.5);
    n.drive.oversample = '2x';
    n.tone = ctx.createBiquadFilter();
    n.tone.type = 'lowpass';
    n.tone.Q.value = 0.75;
    n.tone.frequency.value = 2000;
    n.dcBlock = ctx.createBiquadFilter();
    n.dcBlock.type = 'highpass';
    n.dcBlock.frequency.value = 30;
    n.voice = ctx.createGain();
    n.voice.gain.value = 0.85;

    n.osc.connect(n.trim);
    n.trim.connect(n.amp);
    n.amp.connect(n.drive);
    n.drive.connect(n.tone);
    n.tone.connect(n.dcBlock);
    n.dcBlock.connect(n.voice);

    n.dry = ctx.createGain();
    n.send = ctx.createGain();
    n.preDelay = ctx.createDelay(0.2);
    n.preDelay.delayTime.value = 0.024;
    n.conv = ctx.createConvolver();
    n.conv.buffer = makeImpulse(ctx, 3.2);
    n.wet = ctx.createGain();
    n.master = ctx.createGain();
    n.master.gain.value = this.settings.muted ? 0 : 1;
    n.limiter = ctx.createDynamicsCompressor();
    n.limiter.threshold.value = -6;
    n.limiter.knee.value = 4;
    n.limiter.ratio.value = 16;
    n.limiter.attack.value = 0.002;
    n.limiter.release.value = 0.2;

    n.voice.connect(n.dry);
    n.dry.connect(n.master);
    n.voice.connect(n.send);
    n.send.connect(n.preDelay);
    n.preDelay.connect(n.conv);
    n.conv.connect(n.wet);
    n.wet.connect(n.master);
    n.master.connect(n.limiter);
    n.limiter.connect(ctx.destination);

    n.analyser = ctx.createAnalyser();
    n.analyser.fftSize = 2048;
    n.analyser.smoothingTimeConstant = 0;
    n.voice.connect(n.analyser);

    n.osc.start();
    n.lfo.start();

    this.setWave(this.settings.wave);
    this.setReverb(this.settings.reverb);
  };

  P._glideTC = function () { return 0.004 + Math.pow(this.settings.glide, 2) * 0.2; };

  P._cutoff = function (semi, vol) {
    var c = midiToHz(semi) * (1.6 + 11 * Math.pow(vol, 1.4)) + 350;
    return clamp(c, 200, Math.min(16000, this.ctx.sampleRate * 0.45));
  };

  /** Start or continue the note. semi = MIDI pitch (fractional), vol = 0..1 stage height. */
  P.play = function (semi, vol) {
    this.semi = semi;
    this.vol = vol;
    if (!this.ctx) return;
    var n = this.n, t = this.ctx.currentTime;
    var gain = volToGain(vol) * MAX_GAIN;
    var cents = (semi - 69) * 100;
    var cutoff = this._cutoff(semi, vol);

    if (!this.playing) {
      // A fresh touch lands on its pitch directly; gliding in from the last note sounds like a mistake.
      this.playing = true;
      this._noteStart = this._settleStart = this.clock();
      this._prevSemi = semi;
      this._speed = 0;
      n.osc.detune.cancelScheduledValues(t);
      n.osc.detune.setValueAtTime(cents, t);
      n.tone.frequency.cancelScheduledValues(t);
      n.tone.frequency.setValueAtTime(cutoff, t);
      n.amp.gain.cancelScheduledValues(t);       // also drops a pending delayed release
      n.amp.gain.setTargetAtTime(gain, t, ATTACK_TC);
      n.vib.gain.cancelScheduledValues(t);
      n.vib.gain.setTargetAtTime(0, t, 0.03);
      this._vibTarget = 0;
    } else {
      var tc = this._glideTC();
      n.osc.detune.setTargetAtTime(cents, t, tc);
      n.tone.frequency.setTargetAtTime(cutoff, t, Math.max(tc, VOL_TC));
      n.amp.gain.setTargetAtTime(gain, t, VOL_TC);
    }
  };

  P.release = function () {
    if (!this.playing) return;
    this.playing = false;
    if (!this.ctx) return;
    var n = this.n, t = this.ctx.currentTime;
    var held = this.clock() - this._noteStart;
    var at = t + Math.max(0, (MIN_NOTE_MS - held) / 1000);
    n.amp.gain.setTargetAtTime(0, at, RELEASE_TC);
    n.tone.frequency.setTargetAtTime(this._cutoff(this.semi, 0), at, 0.12);
  };

  /** Per-frame housekeeping: delayed vibrato and its slowly drifting rate. */
  P.tick = function (now) {
    if (!this.ctx || (this.ctx.state !== 'running' && !this.offline)) return;
    var dt = clamp((now - (this._lastTick || now)) / 1000, 0.001, 0.1);
    this._lastTick = now;
    var inst = Math.abs(this.semi - this._prevSemi) / dt;
    this._prevSemi = this.semi;
    this._speed += (inst - this._speed) * Math.min(1, dt * 12);

    var target = this._vibTarget;
    if (this.playing) {
      if (this._speed > 5) this._settleStart = now;       // sliding: hold the vibrato back
      var settled = (now - this._settleStart) / 1000;
      target = this.settings.vibrato * MAX_VIB_CENTS * smoothstep(0.15, 0.8, settled);
    }
    var t = this.ctx.currentTime;
    if (Math.abs(target - this._vibTarget) > 0.2) {
      this.n.vib.gain.setTargetAtTime(target, t, target < this._vibTarget ? 0.06 : 0.25);
      this._vibTarget = target;
    }
    if (now - this._driftAt > 250) {
      this._driftAt = now;
      var rate = 5.5 + 0.35 * Math.sin(now / 1900) + 0.2 * Math.sin(now / 730);
      this.n.lfo.frequency.setTargetAtTime(rate, t, 0.4);
    }
  };

  P.setWave = function (name) {
    if (!WAVES[name]) name = 'classic';
    this.settings.wave = name;
    if (!this.ctx) return;
    var w = WAVES[name];
    if (w.type) {
      this.n.osc.type = w.type;
    } else {
      if (!this._periodic) {
        this._periodic = this.ctx.createPeriodicWave(new Float32Array(w.real), new Float32Array(w.imag));
      }
      this.n.osc.setPeriodicWave(this._periodic);
    }
    this.n.trim.gain.setTargetAtTime(w.level, this.ctx.currentTime, 0.01);
  };

  P.setReverb = function (mix) {
    mix = clamp(mix, 0, 1);
    this.settings.reverb = mix;
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    this.n.dry.gain.setTargetAtTime(1 - 0.35 * mix, t, 0.05);
    this.n.wet.gain.setTargetAtTime(WET_LEVEL * mix, t, 0.05);
  };

  P.setMuted = function (muted) {
    this.settings.muted = !!muted;
    if (!this.ctx) return;
    this.n.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  };

  P.setVibrato = function (v) { this.settings.vibrato = clamp(v, 0, 1); };
  P.setGlide = function (v) { this.settings.glide = clamp(v, 0, 1); };

  /** Latest output waveform (pre-reverb) for the oscilloscope, as floats in -1..1. */
  P.getWaveform = function () {
    if (!this.ctx) return null;
    var an = this.n.analyser;
    if (!this._scope) this._scope = new Float32Array(an.fftSize);
    if (an.getFloatTimeDomainData) {
      an.getFloatTimeDomainData(this._scope);
    } else {
      if (!this._scopeBytes) this._scopeBytes = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(this._scopeBytes);
      for (var i = 0; i < this._scopeBytes.length; i++) this._scope[i] = (this._scopeBytes[i] - 128) / 128;
    }
    return this._scope;
  };

  P.sampleRate = function () { return this.ctx ? this.ctx.sampleRate : 48000; };

  ThereminEngine.WAVES = WAVES;
  ThereminEngine.volToGain = volToGain;
  ThereminEngine.midiToHz = midiToHz;
  global.ThereminEngine = ThereminEngine;
})(typeof window !== 'undefined' ? window : this);
