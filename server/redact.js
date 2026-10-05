import { emptyResources, totalResources } from '../src/rules.js';

/**
 * Return a copy of the game state containing only what `seat` is allowed to see.
 * Hidden: other players' resource cards and development cards, the development deck order,
 * the RNG seed/state (which would let a client predict dice and steals), and private details
 * of steals and card purchases. Once the game has ended everything is revealed except the RNG.
 * @param {object} state full game state
 * @param {number|null} seat viewer's player id, or null for a spectator
 */
export function redactFor(state, seat) {
  const s = structuredClone(state);
  s.seed = 0;
  s.rngState = 0;
  s.options = { ...s.options, seed: null };
  if (s.phase === 'ended') return s;

  s.devDeck = s.devDeck.map(() => 'hidden');
  for (const p of s.players) {
    if (p.id === seat) continue;
    p.handCount = totalResources(p.resources);
    p.resources = emptyResources();
    p.devCards = p.devCards.map((_, i) => ({ id: `hidden-${p.id}-${i}`, type: 'hidden' }));
  }

  const ev = s.lastEvent;
  if (ev && ev.type === 'steal' && seat !== ev.thief && seat !== ev.victim) delete ev.resource;
  if (ev && ev.type === 'devCardBought' && seat !== ev.player) delete ev.card;
  return s;
}
