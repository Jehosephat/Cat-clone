import {
  RESOURCES,
  COSTS,
  DEV_CARDS,
  BANK_PER_RESOURCE,
  PLAYER_COLORS,
  DEFAULT_OPTIONS,
  RESOURCE_LABEL,
  DEV_CARD_LABEL,
} from './constants.js';
import { generateBoard, hexResource } from './board.js';
import { createRng, randomSeed } from './rng.js';
import {
  emptyResources,
  totalResources,
  canAfford,
  validSettlementVertices,
  validRoadEdges,
  validCityVertices,
  longestRoadLength,
  countVictoryPoints,
  piecesLeft,
  tradeRatio,
} from './rules.js';

export class GameError extends Error {}

function fail(msg) {
  throw new GameError(msg);
}

function clone(state) {
  return structuredClone(state);
}

function rngFor(state) {
  const rng = createRng(state.seed);
  rng.state = state.rngState;
  return rng;
}

function saveRng(state, rng) {
  state.rngState = rng.state;
}

function log(state, text, player = null) {
  state.log.push({ turn: state.turn.number, player, text });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

function pname(state, id) {
  return state.players[id].name;
}

function resourceListText(res) {
  const parts = RESOURCES.filter((r) => res[r] > 0).map((r) => `${res[r]} ${RESOURCE_LABEL[r].toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------

export function newGame(userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  const seed = options.seed === null || options.seed === undefined ? randomSeed() : options.seed >>> 0;
  const rng = createRng(seed);
  const board = generateBoard(options, rng);
  const playerDefs = options.players || [];
  const players = [];
  for (let i = 0; i < options.playerCount; i++) {
    const def = playerDefs[i] || {};
    players.push({
      id: i,
      name: def.name || `Player ${i + 1}`,
      color: def.color || PLAYER_COLORS[i].id,
      isBot: !!def.isBot,
      resources: emptyResources(),
      devCards: [],
      knightsPlayed: 0,
    });
  }
  const deck = [];
  for (const [type, n] of Object.entries(DEV_CARDS)) for (let i = 0; i < n; i++) deck.push(type);
  const devDeck = rng.shuffle(deck);
  const bank = {};
  for (const r of RESOURCES) bank[r] = BANK_PER_RESOURCE;

  const state = {
    version: 1,
    options,
    seed,
    rngState: rng.state,
    board,
    players,
    bank,
    devDeck,
    phase: 'setup',
    setup: { round: 1, step: 'settlement', lastVertex: null },
    turn: { player: 0, number: 0, rolled: false, dice: null, devPlayed: false },
    pending: null,
    longestRoad: { player: null, length: 0 },
    largestArmy: { player: null, size: 0 },
    winner: null,
    log: [],
    lastEvent: null,
  };
  log(state, 'Game started. Place your first settlement and road.');
  return state;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function currentPlayer(state) {
  return state.players[state.turn.player];
}

/** Which player ids must act right now. */
export function actingPlayers(state) {
  if (state.phase === 'ended') return [];
  const p = state.pending;
  if (p) {
    if (p.type === 'discard') return p.players.map((d) => d.player);
    if (p.type === 'trade') {
      const waiting = Object.entries(p.responses)
        .filter(([, r]) => r === null)
        .map(([id]) => Number(id));
      return [p.from, ...waiting];
    }
  }
  return [state.turn.player];
}

export function canRoll(state) {
  return state.phase === 'main' && !state.turn.rolled && !state.pending;
}

export function canBuild(state, what) {
  if (state.phase !== 'main' || !state.turn.rolled || state.pending) return false;
  const p = currentPlayer(state);
  if (what === 'road') return canAfford(p.resources, COSTS.road) && piecesLeft(state, p.id, 'road') > 0 && validRoadEdges(state, p.id).length > 0;
  if (what === 'settlement')
    return canAfford(p.resources, COSTS.settlement) && piecesLeft(state, p.id, 'settlement') > 0 && validSettlementVertices(state, p.id).length > 0;
  if (what === 'city') return canAfford(p.resources, COSTS.city) && piecesLeft(state, p.id, 'city') > 0 && validCityVertices(state, p.id).length > 0;
  if (what === 'devCard') return canAfford(p.resources, COSTS.devCard) && state.devDeck.length > 0;
  return false;
}

export function playableDevCards(state) {
  if (state.phase !== 'main' || state.pending || state.turn.devPlayed) return [];
  const p = currentPlayer(state);
  return p.devCards.filter((c) => c.type !== 'victoryPoint' && c.boughtTurn !== state.turn.number);
}

export function validRobberHexes(state) {
  const hexes = state.board.hexes.filter((h) => h.id !== state.board.robberHex);
  if (!state.options.friendlyRobber) return hexes.map((h) => h.id);
  const mover = state.turn.player;
  const weak = new Set(
    state.players.filter((p) => p.id !== mover && countVictoryPoints(state, p.id, { includeHidden: false }) <= 2).map((p) => p.id),
  );
  const ok = hexes.filter((h) => !h.vertices.some((vk) => {
    const b = state.board.vertices[vk].building;
    return b && weak.has(b.player);
  }));
  return (ok.length ? ok : hexes).map((h) => h.id);
}

export function stealCandidates(state, hexId, thief) {
  const hex = state.board.hexes[hexId];
  const ids = new Set();
  for (const vk of hex.vertices) {
    const b = state.board.vertices[vk].building;
    if (b && b.player !== thief && totalResources(state.players[b.player].resources) > 0) ids.add(b.player);
  }
  return [...ids];
}

export function visibleVictoryPoints(state, playerId) {
  return countVictoryPoints(state, playerId, { includeHidden: false });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function give(state, playerId, res, n = 1) {
  const take = Math.min(n, state.bank[res]);
  state.bank[res] -= take;
  state.players[playerId].resources[res] += take;
  return take;
}

function pay(state, playerId, cost) {
  const p = state.players[playerId];
  if (!canAfford(p.resources, cost)) fail('Not enough resources.');
  for (const [r, n] of Object.entries(cost)) {
    p.resources[r] -= n;
    state.bank[r] += n;
  }
}

function updateLongestRoad(state) {
  const lengths = state.players.map((p) => longestRoadLength(state.board, p.id));
  const holder = state.longestRoad.player;
  const max = Math.max(...lengths);
  const leaders = lengths.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
  let newHolder = holder;
  if (holder !== null && lengths[holder] >= 5 && lengths[holder] === max) {
    newHolder = holder; // keeps it on ties
  } else if (max >= 5 && leaders.length === 1) {
    newHolder = leaders[0];
  } else {
    newHolder = null;
  }
  if (newHolder !== holder) {
    if (newHolder === null) log(state, `${pname(state, holder)} loses Longest Road.`);
    else log(state, `${pname(state, newHolder)} takes Longest Road (${max}).`, newHolder);
  }
  state.longestRoad = { player: newHolder, length: newHolder === null ? 0 : lengths[newHolder] };
}

function updateLargestArmy(state, playerId) {
  const p = state.players[playerId];
  const cur = state.largestArmy;
  if (p.knightsPlayed >= 3 && p.knightsPlayed > cur.size) {
    if (cur.player !== playerId) log(state, `${p.name} takes Largest Army (${p.knightsPlayed}).`, playerId);
    state.largestArmy = { player: playerId, size: p.knightsPlayed };
  }
}

function checkVictory(state) {
  if (state.phase !== 'main') return;
  const pid = state.turn.player;
  if (countVictoryPoints(state, pid) >= state.options.targetVP) {
    state.phase = 'ended';
    state.winner = pid;
    state.pending = null;
    log(state, `${pname(state, pid)} wins with ${countVictoryPoints(state, pid)} victory points!`, pid);
  }
}

function placeRoadInternal(state, playerId, edgeKey) {
  const e = state.board.edges[edgeKey];
  if (!e) fail('Unknown edge.');
  if (e.road !== null) fail('A road is already there.');
  if (piecesLeft(state, playerId, 'road') <= 0) fail('No roads left.');
  e.road = playerId;
  updateLongestRoad(state);
}

function placeSettlementInternal(state, playerId, vertexKey) {
  const v = state.board.vertices[vertexKey];
  if (!v) fail('Unknown vertex.');
  if (piecesLeft(state, playerId, 'settlement') <= 0) fail('No settlements left.');
  v.building = { player: playerId, type: 'settlement' };
  updateLongestRoad(state); // may break an opponent's road
}

function distributeResources(state, roll) {
  const demand = {}; // resource -> {player -> n}
  for (const hex of state.board.hexes) {
    if (hex.number !== roll || hex.id === state.board.robberHex) continue;
    const res = hexResource(hex);
    if (!res) continue;
    for (const vk of hex.vertices) {
      const b = state.board.vertices[vk].building;
      if (!b) continue;
      demand[res] = demand[res] || {};
      demand[res][b.player] = (demand[res][b.player] || 0) + (b.type === 'city' ? 2 : 1);
    }
  }
  const gained = state.players.map(() => emptyResources());
  for (const [res, byPlayer] of Object.entries(demand)) {
    const entries = Object.entries(byPlayer);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    if (total <= state.bank[res]) {
      for (const [pid, n] of entries) gained[pid][res] += give(state, Number(pid), res, n);
    } else if (entries.length === 1) {
      const [pid, n] = entries[0];
      gained[pid][res] += give(state, Number(pid), res, n);
      log(state, `The bank ran short of ${RESOURCE_LABEL[res].toLowerCase()}.`);
    } else {
      log(state, `The bank cannot supply enough ${RESOURCE_LABEL[res].toLowerCase()}; nobody receives any.`);
    }
  }
  gained.forEach((g, pid) => {
    if (totalResources(g) > 0) log(state, `${pname(state, pid)} receives ${resourceListText(g)}.`, pid);
  });
  state.lastEvent = { type: 'production', roll, gained };
}

function startRobberMove(state) {
  state.pending = { type: 'moveRobber', player: state.turn.player };
}

function nextSetupTurn(state) {
  const n = state.players.length;
  const s = state.setup;
  if (s.round === 1) {
    if (state.turn.player < n - 1) state.turn.player += 1;
    else s.round = 2; // same player goes again
  } else if (state.turn.player > 0) state.turn.player -= 1;
  else {
    // Setup finished.
    state.phase = 'main';
    state.turn = { player: 0, number: 1, rolled: false, dice: null, devPlayed: false };
    log(state, `Setup complete. ${pname(state, 0)} begins.`, 0);
    return;
  }
  s.step = 'settlement';
  s.lastVertex = null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const handlers = {
  placeSettlement(state, { vertex, player }) {
    if (state.phase !== 'setup') fail('Not in setup.');
    if (state.setup.step !== 'settlement') fail('Place a road first.');
    const pid = state.turn.player;
    if (player !== undefined && player !== pid) fail('Not your turn.');
    if (!validSettlementVertices(state, pid, { setup: true }).includes(vertex)) fail('Invalid settlement location.');
    placeSettlementInternal(state, pid, vertex);
    state.setup.step = 'road';
    state.setup.lastVertex = vertex;
    log(state, `${pname(state, pid)} places a settlement.`, pid);
    if (state.setup.round === 2) {
      const v = state.board.vertices[vertex];
      const gained = emptyResources();
      for (const hid of v.hexes) {
        const res = hexResource(state.board.hexes[hid]);
        if (res) gained[res] += give(state, pid, res, 1);
      }
      if (totalResources(gained)) log(state, `${pname(state, pid)} receives ${resourceListText(gained)}.`, pid);
    }
  },

  placeRoad(state, { edge, player }) {
    const pid = state.turn.player;
    if (player !== undefined && player !== pid) fail('Not your turn.');
    if (state.phase === 'setup') {
      if (state.setup.step !== 'road') fail('Place a settlement first.');
      if (!validRoadEdges(state, pid, { fromVertex: state.setup.lastVertex }).includes(edge)) fail('Road must touch your new settlement.');
      placeRoadInternal(state, pid, edge);
      log(state, `${pname(state, pid)} places a road.`, pid);
      nextSetupTurn(state);
      return;
    }
    if (state.pending && state.pending.type === 'roadBuilding') {
      if (!validRoadEdges(state, pid).includes(edge)) fail('Invalid road location.');
      placeRoadInternal(state, pid, edge);
      state.pending.remaining -= 1;
      log(state, `${pname(state, pid)} builds a free road.`, pid);
      if (state.pending.remaining <= 0 || piecesLeft(state, pid, 'road') <= 0 || validRoadEdges(state, pid).length === 0) state.pending = null;
      checkVictory(state);
      return;
    }
    return handlers.buildRoad(state, { edge, player });
  },

  buildRoad(state, { edge }) {
    if (!canBuild(state, 'road')) fail('Cannot build a road now.');
    const pid = state.turn.player;
    if (!validRoadEdges(state, pid).includes(edge)) fail('Invalid road location.');
    pay(state, pid, COSTS.road);
    placeRoadInternal(state, pid, edge);
    log(state, `${pname(state, pid)} builds a road.`, pid);
    checkVictory(state);
  },

  buildSettlement(state, { vertex }) {
    if (!canBuild(state, 'settlement')) fail('Cannot build a settlement now.');
    const pid = state.turn.player;
    if (!validSettlementVertices(state, pid).includes(vertex)) fail('Invalid settlement location.');
    pay(state, pid, COSTS.settlement);
    placeSettlementInternal(state, pid, vertex);
    log(state, `${pname(state, pid)} builds a settlement.`, pid);
    checkVictory(state);
  },

  buildCity(state, { vertex }) {
    if (!canBuild(state, 'city')) fail('Cannot build a city now.');
    const pid = state.turn.player;
    if (!validCityVertices(state, pid).includes(vertex)) fail('You can only upgrade your own settlement.');
    pay(state, pid, COSTS.city);
    state.board.vertices[vertex].building = { player: pid, type: 'city' };
    log(state, `${pname(state, pid)} upgrades a settlement to a city.`, pid);
    checkVictory(state);
  },

  buyDevCard(state) {
    if (!canBuild(state, 'devCard')) fail('Cannot buy a development card now.');
    const pid = state.turn.player;
    pay(state, pid, COSTS.devCard);
    const type = state.devDeck.pop();
    const p = state.players[pid];
    p.devCards.push({ id: `${state.turn.number}-${p.devCards.length}-${type}`, type, boughtTurn: state.turn.number });
    log(state, `${pname(state, pid)} buys a development card.`, pid);
    state.lastEvent = { type: 'devCardBought', player: pid, card: type };
    checkVictory(state);
  },

  roll(state) {
    if (!canRoll(state)) fail('Cannot roll now.');
    const rng = rngFor(state);
    const d1 = 1 + rng.int(6);
    const d2 = 1 + rng.int(6);
    saveRng(state, rng);
    const total = d1 + d2;
    state.turn.rolled = true;
    state.turn.dice = [d1, d2];
    const pid = state.turn.player;
    log(state, `${pname(state, pid)} rolls ${total} (${d1} + ${d2}).`, pid);
    if (total === 7) {
      state.lastEvent = { type: 'seven' };
      const discards = state.players
        .filter((p) => totalResources(p.resources) > state.options.discardLimit)
        .map((p) => ({ player: p.id, count: Math.floor(totalResources(p.resources) / 2) }));
      if (discards.length) {
        state.pending = { type: 'discard', players: discards, then: 'moveRobber' };
        log(state, `${discards.map((d) => pname(state, d.player)).join(', ')} must discard half of their cards.`);
      } else startRobberMove(state);
    } else distributeResources(state, total);
    checkVictory(state);
  },

  discard(state, { player, resources }) {
    const p = state.pending;
    if (!p || p.type !== 'discard') fail('No discard pending.');
    const entry = p.players.find((d) => d.player === player);
    if (!entry) fail('You do not need to discard.');
    const total = totalResources(resources);
    if (total !== entry.count) fail(`You must discard exactly ${entry.count} cards.`);
    const pl = state.players[player];
    for (const r of RESOURCES) {
      const n = resources[r] || 0;
      if (n < 0 || n > pl.resources[r]) fail('Invalid discard.');
    }
    for (const r of RESOURCES) {
      const n = resources[r] || 0;
      pl.resources[r] -= n;
      state.bank[r] += n;
    }
    log(state, `${pl.name} discards ${resourceListText(resources)}.`, player);
    p.players = p.players.filter((d) => d.player !== player);
    if (p.players.length === 0) startRobberMove(state);
  },

  moveRobber(state, { hex }) {
    const p = state.pending;
    if (!p || p.type !== 'moveRobber') fail('Robber is not being moved.');
    if (!validRobberHexes(state).includes(hex)) fail('Robber must move to a different hex.');
    state.board.robberHex = hex;
    const pid = state.turn.player;
    log(state, `${pname(state, pid)} moves the robber.`, pid);
    const candidates = stealCandidates(state, hex, pid);
    if (candidates.length === 0) {
      state.pending = null;
      checkVictory(state);
    } else if (candidates.length === 1) {
      state.pending = { type: 'steal', candidates };
      handlers.steal(state, { victim: candidates[0] });
    } else state.pending = { type: 'steal', candidates };
  },

  steal(state, { victim }) {
    const p = state.pending;
    if (!p || p.type !== 'steal') fail('Nothing to steal.');
    if (!p.candidates.includes(victim)) fail('Cannot steal from that player.');
    const pid = state.turn.player;
    const v = state.players[victim];
    const cards = [];
    for (const r of RESOURCES) for (let i = 0; i < v.resources[r]; i++) cards.push(r);
    const rng = rngFor(state);
    const stolen = rng.pick(cards);
    saveRng(state, rng);
    v.resources[stolen] -= 1;
    state.players[pid].resources[stolen] += 1;
    log(state, `${pname(state, pid)} steals a card from ${v.name}.`, pid);
    state.lastEvent = { type: 'steal', thief: pid, victim, resource: stolen };
    state.pending = null;
    checkVictory(state);
  },

  playDevCard(state, { card, resources, resource }) {
    const playable = playableDevCards(state);
    const c = playable.find((x) => x.id === card || x.type === card);
    if (!c) fail('You cannot play that card now.');
    const pid = state.turn.player;
    const p = state.players[pid];
    const remove = () => {
      p.devCards = p.devCards.filter((x) => x.id !== c.id);
      state.turn.devPlayed = true;
      log(state, `${p.name} plays ${DEV_CARD_LABEL[c.type]}.`, pid);
    };
    switch (c.type) {
      case 'knight':
        remove();
        p.knightsPlayed += 1;
        updateLargestArmy(state, pid);
        startRobberMove(state);
        break;
      case 'roadBuilding': {
        const left = piecesLeft(state, pid, 'road');
        if (left <= 0) fail('You have no roads left to build.');
        if (validRoadEdges(state, pid).length === 0) fail('There is nowhere to build a road.');
        remove();
        state.pending = { type: 'roadBuilding', remaining: Math.min(2, left) };
        break;
      }
      case 'yearOfPlenty': {
        if (!Array.isArray(resources) || resources.length !== 2) fail('Choose 2 resources.');
        const want = emptyResources();
        for (const r of resources) {
          if (!RESOURCES.includes(r)) fail('Invalid resource.');
          want[r] += 1;
        }
        for (const r of RESOURCES) if (want[r] > state.bank[r]) fail(`The bank has no ${RESOURCE_LABEL[r].toLowerCase()} left.`);
        remove();
        for (const r of RESOURCES) give(state, pid, r, want[r]);
        log(state, `${p.name} takes ${resourceListText(want)} from the bank.`, pid);
        break;
      }
      case 'monopoly': {
        if (!RESOURCES.includes(resource)) fail('Choose a resource.');
        remove();
        let total = 0;
        for (const other of state.players) {
          if (other.id === pid) continue;
          total += other.resources[resource];
          p.resources[resource] += other.resources[resource];
          other.resources[resource] = 0;
        }
        log(state, `${p.name} monopolizes ${RESOURCE_LABEL[resource].toLowerCase()} and collects ${total}.`, pid);
        break;
      }
      default:
        fail('That card cannot be played.');
    }
    checkVictory(state);
  },

  bankTrade(state, { give: giveRes, get: getRes }) {
    if (state.phase !== 'main' || !state.turn.rolled || state.pending) fail('Cannot trade now.');
    if (!RESOURCES.includes(giveRes) || !RESOURCES.includes(getRes) || giveRes === getRes) fail('Invalid trade.');
    const pid = state.turn.player;
    const p = state.players[pid];
    const ratio = tradeRatio(state, pid, giveRes);
    if (p.resources[giveRes] < ratio) fail(`You need ${ratio} ${RESOURCE_LABEL[giveRes].toLowerCase()} for this trade.`);
    if (state.bank[getRes] < 1) fail('The bank has none of that resource.');
    p.resources[giveRes] -= ratio;
    state.bank[giveRes] += ratio;
    give(state, pid, getRes, 1);
    log(state, `${p.name} trades ${ratio} ${RESOURCE_LABEL[giveRes].toLowerCase()} for 1 ${RESOURCE_LABEL[getRes].toLowerCase()} with the bank.`, pid);
  },

  proposeTrade(state, { offer, request }) {
    if (state.phase !== 'main' || !state.turn.rolled || state.pending) fail('Cannot trade now.');
    const pid = state.turn.player;
    const p = state.players[pid];
    const o = { ...emptyResources(), ...offer };
    const q = { ...emptyResources(), ...request };
    if (totalResources(o) === 0 || totalResources(q) === 0) fail('Both sides of a trade must include at least one card.');
    for (const r of RESOURCES) {
      if (o[r] < 0 || q[r] < 0) fail('Invalid trade.');
      if (o[r] > 0 && q[r] > 0) fail('You cannot trade a resource for itself.');
      if (o[r] > p.resources[r]) fail('You do not have those resources.');
    }
    const responses = {};
    for (const other of state.players) if (other.id !== pid) responses[other.id] = null;
    state.pending = { type: 'trade', from: pid, offer: o, request: q, responses };
    log(state, `${p.name} offers ${resourceListText(o)} for ${resourceListText(q)}.`, pid);
  },

  respondTrade(state, { player, accept }) {
    const p = state.pending;
    if (!p || p.type !== 'trade') fail('No trade pending.');
    if (!(player in p.responses)) fail('You are not part of this trade.');
    if (accept) {
      const pl = state.players[player];
      for (const r of RESOURCES) if (pl.resources[r] < p.request[r]) fail('You do not have the requested resources.');
    }
    p.responses[player] = accept ? 'accepted' : 'declined';
  },

  acceptTrade(state, { partner }) {
    const p = state.pending;
    if (!p || p.type !== 'trade') fail('No trade pending.');
    if (p.responses[partner] !== 'accepted') fail('That player has not accepted.');
    const a = state.players[p.from];
    const b = state.players[partner];
    for (const r of RESOURCES) {
      if (a.resources[r] < p.offer[r] || b.resources[r] < p.request[r]) fail('Resources changed; trade is no longer possible.');
    }
    for (const r of RESOURCES) {
      a.resources[r] += p.request[r] - p.offer[r];
      b.resources[r] += p.offer[r] - p.request[r];
    }
    log(state, `${a.name} trades ${resourceListText(p.offer)} to ${b.name} for ${resourceListText(p.request)}.`, p.from);
    state.pending = null;
  },

  cancelTrade(state) {
    const p = state.pending;
    if (!p || p.type !== 'trade') fail('No trade pending.');
    log(state, `${pname(state, p.from)} withdraws the trade offer.`, p.from);
    state.pending = null;
  },

  skipRoadBuilding(state) {
    const p = state.pending;
    if (!p || p.type !== 'roadBuilding') fail('No free roads pending.');
    if (state.turn.player === undefined) fail('Not your turn.');
    log(state, `${pname(state, state.turn.player)} forgoes the remaining free road${p.remaining > 1 ? 's' : ''}.`, state.turn.player);
    state.pending = null;
    checkVictory(state);
  },

  endTurn(state) {
    if (state.phase !== 'main') fail('Not in the main phase.');
    if (!state.turn.rolled) fail('You must roll the dice first.');
    if (state.pending) fail('Finish the current action first.');
    const prev = state.turn.player;
    const next = (prev + 1) % state.players.length;
    state.turn = { player: next, number: state.turn.number + 1, rolled: false, dice: null, devPlayed: false };
    log(state, `${pname(state, next)}'s turn.`, next);
    checkVictory(state); // a player may already have reached the target on another's turn
  },
};

/**
 * Apply an action and return the new state. Throws GameError on illegal actions.
 */
export function act(state, action) {
  const h = handlers[action.type];
  if (!h) throw new GameError(`Unknown action ${action.type}`);
  const next = clone(state);
  next.lastEvent = null;
  h(next, action);
  return next;
}

export { validSettlementVertices, validRoadEdges, validCityVertices, countVictoryPoints, tradeRatio, piecesLeft, totalResources, canAfford };
