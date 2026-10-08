// Roll-off for the starting player: everyone rolls one die, highest goes first.
// Players whose dice tie keep rolling against each other until the order is settled.
// `rolls` is an array (one entry per player) of the dice each player has rolled so far.

export function createRollOff(playerCount) {
  return Array.from({ length: playerCount }, () => []);
}

function tiedSoFar(a, b) {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A player is unsettled while someone else matches all the dice they have in common. */
function unsettled(rolls, pid) {
  return rolls.some((other, j) => j !== pid && tiedSoFar(rolls[pid], other));
}

/**
 * Whether `pid` must roll now. Rounds run in lockstep: a tied player rolls again only once every
 * other unsettled player has rolled as many dice as they have.
 */
export function needsRoll(rolls, pid) {
  if (!unsettled(rolls, pid)) return false;
  let minLen = Infinity;
  rolls.forEach((r, j) => {
    if (unsettled(rolls, j)) minLen = Math.min(minLen, r.length);
  });
  return rolls[pid].length === minLen;
}

export function pendingRollers(rolls) {
  return rolls.map((_, pid) => pid).filter((pid) => needsRoll(rolls, pid));
}

export function isComplete(rolls) {
  return pendingRollers(rolls).length === 0;
}

/** Record a die roll (1-6) for `pid`, returning a new rolls array. */
export function addRoll(rolls, pid, value) {
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('A die shows 1 to 6.');
  if (!needsRoll(rolls, pid)) throw new Error('You do not need to roll now.');
  return rolls.map((r, j) => (j === pid ? [...r, value] : r));
}

function compareRolls(a, b) {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

/** Player ids from first to last. Only unambiguous once `isComplete`. */
export function rollOrder(rolls) {
  return rolls
    .map((r, pid) => ({ r, pid }))
    .sort((x, y) => compareRolls(x.r, y.r) || x.pid - y.pid)
    .map((x) => x.pid);
}

/** Human-readable summary, e.g. "Roll-off: Ann 6, Bob 6→4, Cy 2. Ann goes first." */
export function describeRollOff(names, rolls) {
  const order = rollOrder(rolls);
  const parts = order.map((pid) => `${names[pid]} ${rolls[pid].join('→')}`);
  return `Roll-off: ${parts.join(', ')}. ${names[order[0]]} goes first.`;
}
