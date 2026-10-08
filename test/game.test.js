import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, act, validSettlementVertices, validRoadEdges, countVictoryPoints, GameError, tradeRatio } from '../src/game.js';
import { longestRoadLength, totalResources } from '../src/rules.js';
import { finishedSetup, rollExactly, setResources } from './helpers.js';

test('setup follows snake order and grants resources on the second settlement', () => {
  let s = newGame({ playerCount: 3, seed: 7, boardLayout: 'random' });
  const order = [];
  while (s.phase === 'setup') {
    const pid = s.turn.player;
    order.push(pid);
    const vs = validSettlementVertices(s, pid, { setup: true });
    // Pick a vertex with 3 hexes to guarantee resources.
    const v = vs.find((k) => s.board.vertices[k].hexes.length === 3 && s.board.vertices[k].hexes.every((h) => s.board.hexes[h].terrain !== 'desert')) || vs[0];
    assert.throws(() => act(s, { type: 'placeRoad', edge: Object.keys(s.board.edges)[0] }), GameError);
    s = act(s, { type: 'placeSettlement', vertex: v });
    const es = validRoadEdges(s, pid, { fromVertex: v });
    // A road not touching the new settlement is rejected.
    const bad = Object.keys(s.board.edges).find((k) => !es.includes(k));
    assert.throws(() => act(s, { type: 'placeRoad', edge: bad }), GameError);
    s = act(s, { type: 'placeRoad', edge: es[0] });
  }
  assert.deepEqual(order, [0, 1, 2, 2, 1, 0]);
  assert.equal(s.phase, 'main');
  assert.equal(s.turn.player, 0);
  for (const p of s.players) {
    assert.equal(totalResources(p.resources), 3);
    assert.equal(countVictoryPoints(s, p.id), 2);
  }
});

test('distance rule prevents adjacent settlements', () => {
  let s = newGame({ playerCount: 3, seed: 3 });
  const v = validSettlementVertices(s, 0, { setup: true })[0];
  s = act(s, { type: 'placeSettlement', vertex: v });
  s = act(s, { type: 'placeRoad', edge: validRoadEdges(s, 0, { fromVertex: v })[0] });
  const valid = validSettlementVertices(s, 1, { setup: true });
  assert.ok(!valid.includes(v));
  for (const n of s.board.vertices[v].neighbors) assert.ok(!valid.includes(n));
});

test('rolling distributes resources, 2 for cities, and respects the robber', () => {
  let s = finishedSetup();
  // Find a hex with a settlement on it.
  const hex = s.board.hexes.find((h) => h.number && h.vertices.some((vk) => s.board.vertices[vk].building));
  const vk = hex.vertices.find((k) => s.board.vertices[k].building);
  const owner = s.board.vertices[vk].building.player;
  const res = { hills: 'brick', forest: 'lumber', pasture: 'wool', fields: 'grain', mountains: 'ore' }[hex.terrain];
  // Upgrade to a city directly for the test.
  s.board.vertices[vk].building.type = 'city';
  s.board.robberHex = s.board.hexes.find((h) => h.terrain === 'desert').id;
  const before = s.players[owner].resources[res];
  const after = rollExactly(s, hex.number);
  assert.ok(after.players[owner].resources[res] >= before + 2);
  // With the robber on the hex nobody gets anything from it.
  s.board.robberHex = hex.id;
  const blocked = rollExactly(s, hex.number);
  const otherHexes = s.board.hexes.filter((h) => h.number === hex.number && h.id !== hex.id);
  const gainsFromOthers = otherHexes.some((h) => h.terrain === hex.terrain && h.vertices.some((k) => s.board.vertices[k].building && s.board.vertices[k].building.player === owner));
  if (!gainsFromOthers) assert.equal(blocked.players[owner].resources[res], before);
});

test('bank shortage: nobody receives when multiple players exceed the supply', () => {
  let s = finishedSetup();
  const ownersOf = (h) => new Set(h.vertices.map((k) => s.board.vertices[k].building).filter(Boolean).map((b) => b.player));
  const hex = s.board.hexes.find((h) => h.number && ownersOf(h).size === 1);
  const res = { hills: 'brick', forest: 'lumber', pasture: 'wool', fields: 'grain', mountains: 'ore' }[hex.terrain];
  // Give the hex two different owners.
  const free = hex.vertices.filter((k) => !s.board.vertices[k].building);
  const owner = [...ownersOf(hex)][0];
  const other = (owner + 1) % 4;
  s.board.vertices[free[0]].building = { player: other, type: 'settlement' };
  s.board.robberHex = s.board.hexes.find((h) => h.terrain === 'desert').id;
  for (const h of s.board.hexes) if (h.id !== hex.id && h.number === hex.number) h.number = null; // isolate the hex
  s.bank[res] = 1;
  const a = s.players[owner].resources[res];
  const b = s.players[other].resources[res];
  const after = rollExactly(s, hex.number);
  assert.equal(after.players[owner].resources[res], a);
  assert.equal(after.players[other].resources[res], b);
  assert.equal(after.bank[res], 1);
  // Single player short: gets what is left.
  s.board.vertices[free[0]].building = null;
  const single = rollExactly(s, hex.number);
  assert.equal(single.bank[res], 0);
  assert.equal(single.players[owner].resources[res], a + 1);
});

test('rolling a 7 forces discards, robber move and steal', () => {
  let s = finishedSetup();
  s = setResources(s, 1, { brick: 4, lumber: 4, ore: 1 }); // 9 cards -> discard 4
  s = setResources(s, 2, { wool: 7 }); // exactly 7 -> no discard
  s = rollExactly(s, 7);
  assert.equal(s.pending.type, 'discard');
  assert.deepEqual(s.pending.players, [{ player: 1, count: 4 }]);
  assert.throws(() => act(s, { type: 'discard', player: 1, resources: { brick: 3 } }), /exactly 4/);
  assert.throws(() => act(s, { type: 'moveRobber', hex: 0 }), GameError);
  s = act(s, { type: 'discard', player: 1, resources: { brick: 2, lumber: 2 } });
  assert.equal(totalResources(s.players[1].resources), 5);
  assert.equal(s.pending.type, 'moveRobber');
  assert.throws(() => act(s, { type: 'moveRobber', hex: s.board.robberHex }), GameError);
  // Move to a hex adjacent to player 2 only.
  const target = s.board.hexes.find((h) => {
    const owners = new Set(h.vertices.map((k) => s.board.vertices[k].building && s.board.vertices[k].building.player).filter((x) => x !== null && x !== undefined));
    return owners.size === 1 && owners.has(2) && h.id !== s.board.robberHex;
  });
  assert.ok(target, 'need a hex owned only by player 2');
  const wool2 = s.players[2].resources.wool;
  s = act(s, { type: 'moveRobber', hex: target.id });
  assert.equal(s.pending, null); // auto-steal from the only candidate
  assert.equal(s.board.robberHex, target.id);
  assert.equal(s.players[2].resources.wool, wool2 - 1);
  assert.equal(s.players[0].resources.wool >= 1, true);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.turn.player, 1);
});

test('building costs resources and obeys placement rules', () => {
  let s = finishedSetup();
  s = rollExactly(s, 2);
  while (s.pending) s = act(s, { type: 'moveRobber', hex: (s.board.robberHex + 1) % 19 });
  s = setResources(s, 0, { brick: 5, lumber: 5, wool: 2, grain: 4, ore: 3 });
  assert.throws(() => act(s, { type: 'buildRoad', edge: Object.keys(s.board.edges).find((k) => !validRoadEdges(s, 0).includes(k)) }), GameError);
  const e = validRoadEdges(s, 0)[0];
  s = act(s, { type: 'buildRoad', edge: e });
  assert.equal(s.board.edges[e].road, 0);
  assert.equal(s.players[0].resources.brick, 4);
  assert.equal(s.players[0].resources.lumber, 4);
  // Build a second road and then a settlement two edges away.
  const v = s.board.edges[e].v.find((k) => !s.board.vertices[k].building && !s.board.vertices[k].neighbors.some((n) => s.board.vertices[n].building));
  if (v) {
    s = act(s, { type: 'buildSettlement', vertex: v });
    assert.equal(s.board.vertices[v].building.player, 0);
    assert.equal(s.players[0].resources.wool, 1);
    assert.equal(countVictoryPoints(s, 0), 3);
    s = act(s, { type: 'buildCity', vertex: v });
    assert.equal(s.board.vertices[v].building.type, 'city');
    assert.equal(countVictoryPoints(s, 0), 4);
    assert.equal(s.players[0].resources.ore, 0);
  }
  // Development card
  s = setResources(s, 0, { ore: 1, wool: 1, grain: 1 });
  const deck = s.devDeck.length;
  s = act(s, { type: 'buyDevCard' });
  assert.equal(s.devDeck.length, deck - 1);
  assert.equal(s.players[0].devCards.length, 1);
  assert.equal(totalResources(s.players[0].resources), 0);
  // Cannot play a card bought this turn.
  const card = s.players[0].devCards[0];
  if (card.type !== 'victoryPoint') assert.throws(() => act(s, { type: 'playDevCard', card: card.id }), GameError);
});

test('development cards: knight, road building, year of plenty, monopoly', () => {
  let s = finishedSetup();
  s.players[0].devCards = [
    { id: 'k1', type: 'knight', boughtTurn: 0 },
    { id: 'k2', type: 'knight', boughtTurn: 0 },
    { id: 'k3', type: 'knight', boughtTurn: 0 },
    { id: 'rb', type: 'roadBuilding', boughtTurn: 0 },
    { id: 'yop', type: 'yearOfPlenty', boughtTurn: 0 },
    { id: 'mono', type: 'monopoly', boughtTurn: 0 },
  ];
  // Knight before rolling.
  s = act(s, { type: 'playDevCard', card: 'k1' });
  assert.equal(s.pending.type, 'moveRobber');
  assert.equal(s.players[0].knightsPlayed, 1);
  assert.throws(() => act(s, { type: 'playDevCard', card: 'k2' }), GameError); // one per turn & pending
  const desert = s.board.hexes.find((h) => h.terrain === 'desert').id;
  const emptyHex = s.board.hexes.find((h) => h.id !== desert && !h.vertices.some((k) => s.board.vertices[k].building));
  s = act(s, { type: 'moveRobber', hex: emptyHex.id });
  assert.equal(s.pending, null);
  assert.equal(s.turn.rolled, false);
  assert.throws(() => act(s, { type: 'playDevCard', card: 'k2' }), /cannot play/i);
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  for (let i = 0; i < 3; i++) {
    s = rollExactly(s, 3);
    s = act(s, { type: 'endTurn' });
  }
  assert.equal(s.turn.player, 0);
  // Road building: two free roads.
  const roadsBefore = Object.values(s.board.edges).filter((e) => e.road === 0).length;
  s = act(s, { type: 'playDevCard', card: 'rb' });
  assert.equal(s.pending.type, 'roadBuilding');
  s = act(s, { type: 'placeRoad', edge: validRoadEdges(s, 0)[0] });
  assert.equal(s.pending.remaining, 1);
  s = act(s, { type: 'placeRoad', edge: validRoadEdges(s, 0)[0] });
  assert.equal(s.pending, null);
  assert.equal(Object.values(s.board.edges).filter((e) => e.road === 0).length, roadsBefore + 2);
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  for (let i = 0; i < 3; i++) {
    s = rollExactly(s, 3);
    s = act(s, { type: 'endTurn' });
  }
  // Year of plenty.
  s = setResources(s, 0, {});
  s = act(s, { type: 'playDevCard', card: 'yop', resources: ['ore', 'ore'] });
  assert.equal(s.players[0].resources.ore, 2);
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  for (let i = 0; i < 3; i++) {
    s = rollExactly(s, 3);
    s = act(s, { type: 'endTurn' });
  }
  // Monopoly.
  s = setResources(s, 1, { wool: 3 });
  s = setResources(s, 2, { wool: 2, ore: 1 });
  s = setResources(s, 3, {});
  s = setResources(s, 0, { wool: 1 });
  s = act(s, { type: 'playDevCard', card: 'mono', resource: 'wool' });
  assert.equal(s.players[0].resources.wool, 6);
  assert.equal(s.players[1].resources.wool, 0);
  assert.equal(s.players[2].resources.wool, 0);
  assert.equal(s.players[2].resources.ore, 1);
});

test('largest army is awarded at 3 knights and taken by a bigger army', () => {
  let s = finishedSetup();
  s.players[0].knightsPlayed = 2;
  s.players[0].devCards = [{ id: 'k', type: 'knight', boughtTurn: 0 }];
  s = act(s, { type: 'playDevCard', card: 'k' });
  assert.equal(s.largestArmy.player, 0);
  assert.equal(countVictoryPoints(s, 0), 4);
  s.players[1].knightsPlayed = 3;
  s.turn.player = 1;
  s.turn.devPlayed = false;
  s.pending = null;
  s.players[1].devCards = [{ id: 'k', type: 'knight', boughtTurn: 0 }];
  s = act(s, { type: 'playDevCard', card: 'k' });
  assert.equal(s.largestArmy.player, 1);
  assert.equal(s.largestArmy.size, 4);
});

test('longest road: awarded at 5, broken by an opponent settlement', () => {
  let s = finishedSetup();
  // Clear the board and lay out a straight chain for player 0.
  for (const e of Object.values(s.board.edges)) e.road = null;
  for (const v of Object.values(s.board.vertices)) v.building = null;
  const hex = s.board.hexes[s.board.coordIndex['0,0']];
  // Chain around the center hex: 6 edges in a loop.
  const loop = hex.edges;
  for (let i = 0; i < 5; i++) s.board.edges[loop[i]].road = 0;
  assert.equal(longestRoadLength(s.board, 0), 5);
  s.board.edges[loop[5]].road = 0;
  assert.equal(longestRoadLength(s.board, 0), 6);
  // Opponent settlement on a loop vertex breaks the loop into a 5-chain... but path can start there.
  const vk = hex.vertices[0];
  s.board.vertices[vk].building = { player: 1, type: 'settlement' };
  assert.equal(longestRoadLength(s.board, 0), 6); // a loop still traverses all 6 edges starting from the blocked vertex
  s.board.edges[loop[5]].road = null;
  // Now a 5-chain; block the middle vertex.
  const mid = hex.vertices[3];
  s.board.vertices[vk].building = null;
  s.board.vertices[mid].building = { player: 1, type: 'settlement' };
  assert.equal(longestRoadLength(s.board, 0), 3);
  s.board.vertices[mid].building = null;
  assert.equal(longestRoadLength(s.board, 0), 5);
  // Simulate award via building a road.
  s.turn.rolled = true;
  s.pending = null;
  s.board.edges[loop[4]].road = null;
  s = setResources(s, 0, { brick: 1, lumber: 1 });
  s.board.vertices[hex.vertices[0]].building = { player: 0, type: 'settlement' };
  s = act(s, { type: 'buildRoad', edge: loop[4] });
  assert.equal(s.longestRoad.player, 0);
  assert.equal(s.longestRoad.length, 5);
  assert.equal(countVictoryPoints(s, 0), 3);
});

test('maritime trade uses 4:1, 3:1 and 2:1 ratios', () => {
  let s = finishedSetup();
  s = rollExactly(s, 3);
  for (const hb of s.board.harbors) for (const vk of hb.vertices) if (s.board.vertices[vk].building && s.board.vertices[vk].building.player === 0) s.board.vertices[vk].building = null;
  s = setResources(s, 0, { wool: 4 });
  assert.equal(tradeRatio(s, 0, 'wool'), 4);
  s = act(s, { type: 'bankTrade', give: 'wool', get: 'ore' });
  assert.equal(s.players[0].resources.wool, 0);
  assert.equal(s.players[0].resources.ore, 1);
  // Put a 3:1 harbor settlement for player 0.
  const h3 = s.board.harbors.find((h) => h.type === 'any');
  s.board.vertices[h3.vertices[0]].building = { player: 0, type: 'settlement' };
  assert.equal(tradeRatio(s, 0, 'wool'), 3);
  const h2 = s.board.harbors.find((h) => h.type === 'wool');
  s.board.vertices[h2.vertices[0]].building = { player: 0, type: 'settlement' };
  assert.equal(tradeRatio(s, 0, 'wool'), 2);
  assert.equal(tradeRatio(s, 0, 'brick'), 3);
  s = setResources(s, 0, { wool: 2 });
  s = act(s, { type: 'bankTrade', give: 'wool', get: 'grain' });
  assert.equal(s.players[0].resources.grain, 1);
  assert.throws(() => act(s, { type: 'bankTrade', give: 'wool', get: 'grain' }), GameError);
});

test('domestic trade requires acceptance from a partner', () => {
  let s = finishedSetup();
  s = rollExactly(s, 3);
  s = setResources(s, 0, { brick: 2 });
  s = setResources(s, 1, { ore: 1 });
  s = setResources(s, 2, {});
  assert.throws(() => act(s, { type: 'proposeTrade', offer: { brick: 1 }, request: {} }), GameError);
  assert.throws(() => act(s, { type: 'proposeTrade', offer: { brick: 1 }, request: { brick: 1 } }), GameError);
  s = act(s, { type: 'proposeTrade', offer: { brick: 1 }, request: { ore: 1 } });
  assert.equal(s.pending.type, 'trade');
  assert.throws(() => act(s, { type: 'respondTrade', player: 2, accept: true }), GameError); // lacks ore
  s = act(s, { type: 'respondTrade', player: 2, accept: false });
  assert.throws(() => act(s, { type: 'acceptTrade', partner: 1 }), GameError);
  s = act(s, { type: 'respondTrade', player: 1, accept: true });
  s = act(s, { type: 'acceptTrade', partner: 1 });
  assert.equal(s.pending, null);
  assert.equal(s.players[0].resources.ore, 1);
  assert.equal(s.players[0].resources.brick, 1);
  assert.equal(s.players[1].resources.brick, 1);
  assert.equal(s.players[1].resources.ore, 0);
  // Cancel path.
  s = act(s, { type: 'proposeTrade', offer: { brick: 1 }, request: { wool: 1 } });
  s = act(s, { type: 'cancelTrade' });
  assert.equal(s.pending, null);
});

test('game ends when the current player reaches the target', () => {
  let s = finishedSetup({ targetVP: 4 });
  s.players[0].devCards = [{ id: 'v1', type: 'victoryPoint', boughtTurn: 0 }, { id: 'v2', type: 'victoryPoint', boughtTurn: 0 }];
  // Player 0 has 2 settlements + 2 VP cards = 4 but win is checked on actions.
  s = rollExactly(s, 3);
  assert.equal(s.phase, 'ended');
  assert.equal(s.winner, 0);
});

test('victory only on your own turn', () => {
  let s = finishedSetup({ targetVP: 3 });
  s.turn.player = 1;
  s.turn.rolled = true;
  s.players[0].devCards = [{ id: 'v1', type: 'victoryPoint', boughtTurn: 0 }];
  s = act(s, { type: 'endTurn' });
  assert.equal(s.phase, 'main'); // player 2's turn, player 0 waits
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.turn.player, 0);
  assert.equal(s.phase, 'ended');
  assert.equal(s.winner, 0);
});

test('friendly robber avoids players with 2 or fewer points', () => {
  let s = finishedSetup({ friendlyRobber: true });
  s.players[0].devCards = [{ id: 'k', type: 'knight', boughtTurn: 0 }];
  s = act(s, { type: 'playDevCard', card: 'k' });
  const weakHex = s.board.hexes.find((h) => h.id !== s.board.robberHex && h.vertices.some((k) => s.board.vertices[k].building && s.board.vertices[k].building.player !== 0));
  assert.throws(() => act(s, { type: 'moveRobber', hex: weakHex.id }), GameError);
});

test('road building can be skipped, and only pending road building accepts it', () => {
  let s = finishedSetup();
  assert.throws(() => act(s, { type: 'skipRoadBuilding' }), GameError);
  s.players[0].devCards = [{ id: 'rb', type: 'roadBuilding', boughtTurn: 0 }];
  s = act(s, { type: 'playDevCard', card: 'rb' });
  assert.equal(s.pending.type, 'roadBuilding');
  s = act(s, { type: 'skipRoadBuilding' });
  assert.equal(s.pending, null);
  assert.equal(s.turn.devPlayed, true);
});

test('a custom turn order drives setup (snake) and the turn rotation', () => {
  let s = newGame({ playerCount: 4, seed: 11, turnOrder: [2, 0, 3, 1] });
  assert.equal(s.turn.player, 2);
  const seen = [];
  while (s.phase === 'setup') {
    const pid = s.turn.player;
    seen.push(pid);
    const v = validSettlementVertices(s, pid, { setup: true })[0];
    s = act(s, { type: 'placeSettlement', vertex: v });
    s = act(s, { type: 'placeRoad', edge: validRoadEdges(s, pid, { fromVertex: v })[0] });
  }
  assert.deepEqual(seen, [2, 0, 3, 1, 1, 3, 0, 2]);
  assert.equal(s.turn.player, 2);
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.turn.player, 0);
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.turn.player, 3);
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.turn.player, 1);
  s = rollExactly(s, 3);
  s = act(s, { type: 'endTurn' });
  assert.equal(s.turn.player, 2);
  // Invalid orders fall back to seat order.
  assert.deepEqual(newGame({ playerCount: 3, seed: 1, turnOrder: [0, 0, 1] }).turnOrder, [0, 1, 2]);
  assert.deepEqual(newGame({ playerCount: 3, seed: 1, turnOrder: [1, 2] }).turnOrder, [0, 1, 2]);
});

test('saved games without a turn order still advance through setup', () => {
  let s = newGame({ playerCount: 3, seed: 5 });
  delete s.turnOrder;
  delete s.setup.index;
  const seen = [];
  while (s.phase === 'setup') {
    const pid = s.turn.player;
    seen.push(pid);
    const v = validSettlementVertices(s, pid, { setup: true })[0];
    s = act(s, { type: 'placeSettlement', vertex: v });
    s = act(s, { type: 'placeRoad', edge: validRoadEdges(s, pid, { fromVertex: v })[0] });
  }
  assert.deepEqual(seen, [0, 1, 2, 2, 1, 0]);
});


test('dice totals are tallied overall and per player', () => {
  let s = finishedSetup();
  assert.equal(s.stats.rolls.reduce((a, b) => a + b, 0), 0);
  s = rollExactly(s, 8);
  assert.equal(s.stats.rolls[8], 1);
  assert.equal(s.stats.playerRolls[0][8], 1);
  s = act(s, { type: 'endTurn' });
  s = rollExactly(s, 8);
  assert.equal(s.stats.rolls[8], 2);
  assert.equal(s.stats.playerRolls[1][8], 1);
  assert.equal(s.stats.playerRolls[0][8], 1);
  // Older saves without stats start counting from the next roll.
  delete s.stats;
  s = act(s, { type: 'endTurn' });
  s = rollExactly(s, 5);
  assert.equal(s.stats.rolls[5], 1);
  assert.equal(s.stats.rolls.reduce((a, b) => a + b, 0), 1);
});


test('resource production and robber-blocked production are tallied per player', () => {
  let s = finishedSetup();
  const hex = s.board.hexes.find((h) => h.number && h.vertices.some((vk) => s.board.vertices[vk].building));
  const vk = hex.vertices.find((k) => s.board.vertices[k].building);
  const owner = s.board.vertices[vk].building.player;
  const res = { hills: 'brick', forest: 'lumber', pasture: 'wool', fields: 'grain', mountains: 'ore' }[hex.terrain];
  for (const h of s.board.hexes) if (h.id !== hex.id && h.number === hex.number) h.number = null; // isolate the hex
  s.board.vertices[vk].building.type = 'city';
  s.board.robberHex = s.board.hexes.find((h) => h.terrain === 'desert').id;
  const after = rollExactly(s, hex.number);
  assert.equal(after.stats.production[owner][res], 2);
  assert.equal(after.stats.robbed[owner][res], 0);
  // With the robber on the hex, the same roll is recorded as blocked instead.
  s.board.robberHex = hex.id;
  const blocked = rollExactly(s, hex.number);
  assert.equal(blocked.stats.production[owner][res], 0);
  assert.equal(blocked.stats.robbed[owner][res], 2);
  // Older saves gain the new counters on the fly.
  delete s.stats.production;
  delete s.stats.robbed;
  s.board.robberHex = s.board.hexes.find((h) => h.terrain === 'desert').id;
  const upgraded = rollExactly(s, hex.number);
  assert.equal(upgraded.stats.production[owner][res], 2);
});
