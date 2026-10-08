// Small synthesized sound effects via the Web Audio API (no audio files needed).
// Browsers only allow audio after a user gesture, so the context is created and resumed
// on the first tap or key press and the ding is skipped until then.

const PREF_KEY = 'catan-sound-v1';

let ctx = null;
let enabled = true;
let primed = false;
export const stats = { dings: 0, played: 0 };

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

/** A short bell-like "ding": two decaying sine partials. */
export function ding() {
  stats.dings += 1;
  if (!enabled) return false;
  const c = getContext();
  if (!c) return false;
  if (c.state === 'suspended') {
    c.resume().catch(() => {});
    if (c.state === 'suspended') return false;
  }
  stats.played += 1;
  const t0 = c.currentTime;
  const master = c.createGain();
  master.gain.value = 0.25;
  master.connect(c.destination);
  const partials = [
    [880, 1.0, 0.9],
    [1760, 0.35, 0.5],
    [2640, 0.12, 0.3],
  ];
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
  if (navigator.vibrate) {
    try {
      navigator.vibrate(60);
    } catch {
      /* ignore */
    }
  }
  return true;
}
