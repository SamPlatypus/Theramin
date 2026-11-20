# Touch Theremin

A theremin for your phone. Touch the stage and slide: **left/right sets the pitch**, **up/down sets the volume**. It's an installable web app (PWA) with no dependencies and no build step, and it works fully offline after the first visit.

## Features

- **Play area with a visual guide.** Each semitone gets an equal-width column, sharps are shaded like piano black keys, and a labelled note strip runs along the bottom. A LOUD/SOFT rail on the left has 25/50/75 % guide lines.
- **Live feedback.** A glowing orb sits under your finger, growing with volume and coloured by pitch. Crosshairs run to the note strip and the volume rail, and a live oscilloscope trace shows the waveform you're hearing.
- **Pitch readout.** Note name and octave, frequency in Hz, and a tuner needle with cents offset that turns green when you're in tune.
- **Five waveforms.** Classic (a warm, vocal theremin-style voice), Sine, Triangle, Saw and Square.
- **Reverb.** A synthesized stereo hall, so there's no sample file to download.
- **Mute toggle.** If you play while muted, a badge appears and nudges so the silence is never a mystery.
- **Settings.** Range (1–4 octaves), lowest note (C2–C5), pitch assist (Off / Gentle / Snap), vibrato depth and glide. All settings are remembered.
- **Onboarding.** A start card explains the two axes. Until your first touch, a "ghost finger" demonstrates sliding.
- **Mobile details.** Multi-touch legato (lifting a finger falls back to the one still down), safe-area and notch support, portrait and landscape layouts, a screen wake lock while playing, and no zoom, scroll or long-press menus on the stage. On iOS 17+ it plays even with the silent switch on.

### Why it sounds expressive

| Technique | Effect |
| --- | --- |
| Pitch is driven in cents (`osc.detune`) with a smoothed glide | Slides are even in musical space, like a real theremin |
| Volume is mapped in decibels; the bottom 5 % fades to true silence | Swells can start from nothing, and the whole height is usable |
| The amp feeds a soft saturator | Louder notes grow richer in harmonics |
| A lowpass follows pitch and volume | Quiet notes are dark, loud notes are bright |
| Vibrato fades in after the finger settles and drops out while sliding; its rate drifts slightly | Held notes bloom without the vibrato sounding mechanical |
| A fresh touch lands on its pitch; moving fingers glide; quick taps get a minimum note length | Taps sound like round, plucked notes |

## Run it locally

Any static file server works. For example:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Service workers (which provide offline mode) need `localhost` or HTTPS.

## Put it on your phone

1. Host the folder on any static HTTPS host. With **GitHub Pages**: go to *Settings → Pages → Deploy from a branch* and pick the branch and `/ (root)`. The repo already includes `.nojekyll`.
2. Open the URL on your phone and wait for "Ready to play offline".
3. Install it. On **iOS Safari**: Share → *Add to Home Screen*. On **Android Chrome**: ⋮ → *Install app*.
4. Launch it from the home screen. It now works in airplane mode.

To ship it to the app stores, wrap the same files with [Capacitor](https://capacitorjs.com/) (`npx cap init`, set `webDir` to this folder, then `npx cap add ios` / `android`).

## Files

```
index.html             app shell and markup
css/app.css            layout and styling (portrait, landscape, tablet)
js/engine.js           Web Audio synth: oscillator, vibrato, saturation, filter, reverb, limiter
js/app.js              touch input, canvas visuals, readout, settings, offline registration
sw.js                  service worker: precaches everything, serves cache-first
manifest.webmanifest   install metadata
icons/                 app icons (SVG source + PNGs, maskable and Apple touch icon)
```

When you change any file, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Browser support

Current Safari (iOS 15+), Chrome and Firefox. Audio starts on the first tap, as browsers require.
