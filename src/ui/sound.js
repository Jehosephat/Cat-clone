// Small synthesized sound effects via the Web Audio API (no audio files needed).
// Browsers only allow audio after a user gesture, so the context is created and resumed
// on the first tap or key press and the ding is skipped until then.

const PREF_KEY = 'catan-sound-v1';

let ctx = null;
let enabled = true;
let primed = false;
export const stats = { dings: 0, kachings: 0, blips: 0, played: 0 };

try {
  enabled = localStorage.getItem(PREF_KEY) !== 'off';
} catch {
  /* storage unavailable */
}

export function soundEnabled() {
  return enabled;
}

export function setSoundEnabled(on) {
  enabled = !!on;
  try {
    localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  if (enabled) ding(); // preview, and this call happens inside a tap so it also unlocks audio
}

function getContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Call once at startup: unlock audio on the first user gesture. */
export function primeAudio() {
  if (primed) return;
  primed = true;
  const unlock = () => {
    const c = getContext();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, unlock, { passive: true });
}

/** A running audio context, or null when sound is off or audio has not been unlocked yet. */
function readyContext() {
  if (!enabled) return null;
  const c = getContext();
  if (!c) return null;
  if (c.state === 'suspended') {
    c.resume().catch(() => {});
    if (c.state === 'suspended') return null;
  }
  return c;
}

/** Play decaying sine partials: [[frequency, amplitude, seconds], ...]. */
function bell(c, master, t0, partials) {
  for (const [freq, amp, dur] of partials) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

function vibrate(pattern) {
  if (!navigator.vibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

/** A short bell-like "ding" for "it's your move". */
export function ding() {
  stats.dings += 1;
  const c = readyContext();
  if (!c) return false;
  stats.played += 1;
  const t0 = c.currentTime;
  const master = c.createGain();
  master.gain.value = 0.25;
  master.connect(c.destination);
  bell(c, master, t0, [
    [880, 1.0, 0.9],
    [1760, 0.35, 0.5],
    [2640, 0.12, 0.3],
  ]);
  vibrate(60);
  return true;
}

/** A cash-register "ka-ching" for an incoming trade offer: a short click, then a bright bell. */
export function kaching() {
  stats.kachings += 1;
  const c = readyContext();
  if (!c) return false;
  stats.played += 1;
  const t0 = c.currentTime;
  const master = c.createGain();
  master.gain.value = 0.22;
  master.connect(c.destination);
  // "ka": a 30 ms burst of band-passed noise, like the drawer latch.
  const len = Math.floor(c.sampleRate * 0.03);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const noise = c.createBufferSource();
  noise.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 3200;
  filter.Q.value = 1.2;
  const ng = c.createGain();
  ng.gain.value = 0.7;
  noise.connect(filter);
  filter.connect(ng);
  ng.connect(master);
  noise.start(t0);
  // "ching": a bright, slightly inharmonic bell starting just after the click.
  bell(c, master, t0 + 0.045, [
    [2500, 0.9, 0.55],
    [3780, 0.45, 0.4],
    [5230, 0.2, 0.25],
    [1250, 0.25, 0.6],
  ]);
  vibrate([40, 40, 40]);
  return true;
}

/** A quiet, short tick for an incoming chat message. */
export function blip() {
  stats.blips += 1;
  const c = readyContext();
  if (!c) return false;
  stats.played += 1;
  const t0 = c.currentTime;
  const master = c.createGain();
  master.gain.value = 0.1;
  master.connect(c.destination);
  bell(c, master, t0, [
    [1320, 1.0, 0.12],
    [1980, 0.4, 0.08],
  ]);
  return true;
}
