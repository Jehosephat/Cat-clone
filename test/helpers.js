import { newGame, act, validSettlementVertices, validRoadEdges } from '../src/game.js';

/** Run the full setup phase with each player picking the first valid spots. */
export function finishedSetup(options = {}) {
  let s = newGame({ playerCount: 4, boardLayout: 'beginner', randomHarbors: false, seed: 42, passDevice: false, ...options });
  while (s.phase === 'setup') {
    const pid = s.turn.player;
    const vs = validSettlementVertices(s, pid, { setup: true });
    const v = vs[Math.floor(vs.length / 2)];
    s = act(s, { type: 'placeSettlement', vertex: v });
    const es = validRoadEdges(s, pid, { fromVertex: v });
    s = act(s, { type: 'placeRoad', edge: es[0] });
  }
  return s;
}

/** Force the next dice roll to a given total by searching for an rng state. */
export function rollExactly(state, total) {
  // Try successive rng states until the roll matches.
  for (let i = 0; i < 100000; i++) {
    const s = { ...state, rngState: (state.rngState + i) >>> 0 };
    const next = act(s, { type: 'roll' });
    if (next.turn.dice[0] + next.turn.dice[1] === total) return next;
  }
  throw new Error('could not find a roll');
}

export function setResources(state, pid, res) {
  const s = structuredClone(state);
  s.players[pid].resources = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...res };
  return s;
}
