import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUndoable, makeUndoOffer, restoreFromOffer, UNDO_WINDOW_MS } from '../src/undo.js';

test('trades with players, dice rolls and steals are never undoable; everything else is', () => {
  for (const t of ['proposeTrade', 'respondTrade', 'acceptTrade', 'cancelTrade', 'roll', 'steal']) assert.equal(isUndoable(t), false);
  for (const t of ['buildRoad', 'buildSettlement', 'buildCity', 'buyDevCard', 'endTurn', 'bankTrade', 'discard', 'moveRobber', 'playDevCard', 'placeSettlement', 'placeRoad', 'skipRoadBuilding']) assert.equal(isUndoable(t), true);
});

test('offers are made only for humans and not when the game just ended', () => {
  const prev = { phase: 'main', turn: { number: 3 }, log: [] };
  const next = { phase: 'main' };
  const offer = makeUndoOffer(prev, next, 'buildCity', 1, 1000);
  assert.deepEqual(offer, { state: prev, player: 1, label: 'city upgrade', until: 1000 + UNDO_WINDOW_MS });
  assert.equal(makeUndoOffer(prev, next, 'buildCity', null, 1000), null);
  assert.equal(makeUndoOffer(prev, { phase: 'ended' }, 'buildCity', 1, 1000), null);
  assert.equal(makeUndoOffer(prev, next, 'acceptTrade', 1, 1000), null);
  const restored = restoreFromOffer(offer, 'Bob');
  assert.notEqual(restored, prev);
  assert.deepEqual(restored.lastEvent, { type: 'undo', player: 1, label: 'city upgrade' });
  assert.equal(restored.log.at(-1).text, 'Bob takes back their city upgrade.');
  assert.equal(prev.log.length, 0);
});
