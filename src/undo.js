// Undo offers: after most actions the acting player may take it back for a few seconds,
// as long as nobody else has acted since. Player-to-player trades involve other people's
// decisions, so they are never undoable.

export const UNDO_WINDOW_MS = 4000;

const NOT_UNDOABLE = new Set(['proposeTrade', 'respondTrade', 'acceptTrade', 'cancelTrade']);

export function isUndoable(actionType) {
  return !NOT_UNDOABLE.has(actionType);
}

const LABELS = {
  placeSettlement: 'settlement placement',
  placeRoad: 'road placement',
  buildRoad: 'road',
  buildSettlement: 'settlement',
  buildCity: 'city upgrade',
  buyDevCard: 'card purchase',
  roll: 'dice roll',
  discard: 'discard',
  moveRobber: 'robber move',
  steal: 'steal',
  playDevCard: 'card play',
  bankTrade: 'bank trade',
  endTurn: 'end of turn',
  skipRoadBuilding: 'skip',
};

export function undoLabel(actionType) {
  return LABELS[actionType] || 'last action';
}

/**
 * Build an undo offer for an action just applied, or null when it cannot be undone.
 * @param {object} prevState state before the action (kept so it can be restored)
 * @param {object} nextState state after the action
 * @param {string} actionType
 * @param {number|null} player the human who acted, or null for a bot
 * @param {number} now timestamp in ms
 */
export function makeUndoOffer(prevState, nextState, actionType, player, now) {
  if (player === null || player === undefined) return null;
  if (!isUndoable(actionType) || nextState.phase === 'ended') return null;
  return { state: prevState, player, label: undoLabel(actionType), until: now + UNDO_WINDOW_MS };
}

/** The state to restore when an offer is taken: a copy with a log line and no stale event. */
export function restoreFromOffer(offer, playerName) {
  const s = structuredClone(offer.state);
  s.lastEvent = null;
  s.log.push({ turn: s.turn.number, player: offer.player, text: `${playerName} takes back their ${offer.label}.` });
  return s;
}
