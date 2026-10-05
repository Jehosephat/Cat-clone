// Simple heuristic bot. Returns a single action for the given player, or null if nothing to do.
import { RESOURCES, COSTS, PIPS } from './constants.js';
import {
  validSettlementVertices,
  validRoadEdges,
  validCityVertices,
  canBuild,
  playableDevCards,
  validRobberHexes,
  countVictoryPoints,
  tradeRatio,
  piecesLeft,
  canAfford,
  totalResources,
} from './game.js';
import { hexResource } from './board.js';
import { emptyResources } from './rules.js';

function vertexScore(state, vk, owned = emptyResources()) {
  const v = state.board.vertices[vk];
  let score = 0;
  const seen = new Set();
  for (const hid of v.hexes) {
    const h = state.board.hexes[hid];
    const res = hexResource(h);
    if (!res || !h.number) continue;
    const pips = PIPS[h.number] || 0;
    score += pips;
    if (!seen.has(res)) {
      seen.add(res);
      score += 1.5;
      if (owned[res] === 0) score += 2; // diversify
    }
  }
  if (v.harbor) score += v.harbor === 'any' ? 1 : 1.5;
  return score;
}

function ownedResourceProduction(state, pid) {
  const owned = emptyResources();
  for (const v of Object.values(state.board.vertices)) {
    if (!v.building || v.building.player !== pid) continue;
    for (const hid of v.hexes) {
      const res = hexResource(state.board.hexes[hid]);
      if (res) owned[res] += PIPS[state.board.hexes[hid].number] || 0;
    }
  }
  return owned;
}

function bestVertex(state, pid, candidates) {
  const owned = ownedResourceProduction(state, pid);
  let best = null;
  let bestScore = -Infinity;
  for (const vk of candidates) {
    const sc = vertexScore(state, vk, owned);
    if (sc > bestScore) {
      bestScore = sc;
      best = vk;
    }
  }
  return best;
}

function futureSpots(state, vk) {
  // Vertices that could host a settlement (free, distance rule).
  const v = state.board.vertices[vk];
  return !v.building && !v.neighbors.some((n) => state.board.vertices[n].building);
}

function bestRoad(state, pid, candidates) {
  const owned = ownedResourceProduction(state, pid);
  let best = null;
  let bestScore = -Infinity;
  const rng = Math.random;
  for (const ek of candidates) {
    const e = state.board.edges[ek];
    let sc = 0;
    for (const vk of e.v) {
      const v = state.board.vertices[vk];
      if (v.building && v.building.player !== pid) {
        sc -= 5;
        continue;
      }
      if (futureSpots(state, vk)) sc = Math.max(sc, vertexScore(state, vk, owned));
      // Look one step further.
      for (const nk of v.neighbors) {
        if (futureSpots(state, nk) && !state.board.vertices[nk].building) sc = Math.max(sc, vertexScore(state, nk, owned) * 0.6);
      }
      // Prefer extending to fresh vertices.
      const touchesOwnRoad = v.edges.some((k) => k !== ek && state.board.edges[k].road === pid);
      if (!touchesOwnRoad) sc += 1;
    }
    sc += rng() * 0.5;
    if (sc > bestScore) {
      bestScore = sc;
      best = ek;
    }
  }
  return best;
}

function missingFor(resources, cost) {
  const miss = emptyResources();
  for (const [r, n] of Object.entries(cost)) miss[r] = Math.max(0, n - resources[r]);
  return miss;
}

function wantedResources(state, pid) {
  // Which resources the bot would like, by priority of its next goal.
  const p = state.players[pid];
  const goals = [];
  if (piecesLeft(state, pid, 'city') > 0 && validCityVertices(state, pid).length) goals.push(COSTS.city);
  if (piecesLeft(state, pid, 'settlement') > 0 && validSettlementVertices(state, pid).length) goals.push(COSTS.settlement);
  if (piecesLeft(state, pid, 'road') > 0) goals.push(COSTS.road);
  if (state.devDeck.length) goals.push(COSTS.devCard);
  const want = emptyResources();
  goals.forEach((cost, i) => {
    const miss = missingFor(p.resources, cost);
    const total = totalResources(miss);
    if (total === 0) return;
    for (const r of RESOURCES) if (miss[r]) want[r] += (miss[r] * (4 - i)) / total;
  });
  return want;
}

function chooseDiscard(state, pid, count) {
  const p = state.players[pid];
  const res = { ...p.resources };
  const want = wantedResources(state, pid);
  const out = emptyResources();
  for (let i = 0; i < count; i++) {
    // Discard the resource with the biggest surplus relative to want.
    let best = null;
    let bestVal = -Infinity;
    for (const r of RESOURCES) {
      if (res[r] <= 0) continue;
      const val = res[r] - want[r] * 2;
      if (val > bestVal) {
        bestVal = val;
        best = r;
      }
    }
    res[best] -= 1;
    out[best] += 1;
  }
  return out;
}

function robberTarget(state, pid) {
  const hexes = validRobberHexes(state);
  let best = null;
  let bestScore = -Infinity;
  for (const hid of hexes) {
    const h = state.board.hexes[hid];
    if (!h.number) continue;
    let sc = 0;
    let ownHere = false;
    for (const vk of h.vertices) {
      const b = state.board.vertices[vk].building;
      if (!b) continue;
      if (b.player === pid) {
        ownHere = true;
        continue;
      }
      const mult = b.type === 'city' ? 2 : 1;
      const vp = countVictoryPoints(state, b.player, { includeHidden: false });
      sc += (PIPS[h.number] || 0) * mult * (1 + vp / 10);
      if (totalResources(state.players[b.player].resources) > 0) sc += 1;
    }
    if (ownHere) sc -= 100;
    if (sc > bestScore) {
      bestScore = sc;
      best = hid;
    }
  }
  return best ?? hexes[0];
}

export function botRespondToTrade(state, pid) {
  const t = state.pending;
  const p = state.players[pid];
  const want = wantedResources(state, pid);
  let gain = 0;
  let loss = 0;
  for (const r of RESOURCES) {
    gain += t.offer[r] * (1 + want[r] * 2 + (p.resources[r] === 0 ? 1 : 0));
    loss += t.request[r] * (1 + want[r] * 2 + (p.resources[r] <= t.request[r] ? 1 : 0));
    if (p.resources[r] < t.request[r]) return false;
  }
  return gain > loss;
}

export function botAction(state, pid) {
  if (state.phase === 'ended') return null;
  const p = state.players[pid];
  const pending = state.pending;

  if (pending && pending.type === 'discard') {
    const entry = pending.players.find((d) => d.player === pid);
    if (!entry) return null;
    return { type: 'discard', player: pid, resources: chooseDiscard(state, pid, entry.count) };
  }
  if (pending && pending.type === 'trade') {
    if (pending.responses[pid] === null) return { type: 'respondTrade', player: pid, accept: botRespondToTrade(state, pid) };
    if (pending.from === pid) {
      const acc = Object.entries(pending.responses).find(([, r]) => r === 'accepted');
      if (acc) return { type: 'acceptTrade', partner: Number(acc[0]) };
      if (Object.values(pending.responses).every((r) => r !== null)) return { type: 'cancelTrade' };
    }
    return null;
  }
  if (state.turn.player !== pid) return null;

  if (state.phase === 'setup') {
    if (state.setup.step === 'settlement') {
      return { type: 'placeSettlement', vertex: bestVertex(state, pid, validSettlementVertices(state, pid, { setup: true })) };
    }
    return { type: 'placeRoad', edge: bestRoad(state, pid, validRoadEdges(state, pid, { fromVertex: state.setup.lastVertex })) };
  }

  if (pending) {
    if (pending.type === 'moveRobber') return { type: 'moveRobber', hex: robberTarget(state, pid) };
    if (pending.type === 'steal') {
      const victim = pending.candidates
        .slice()
        .sort((a, b) => countVictoryPoints(state, b, { includeHidden: false }) - countVictoryPoints(state, a, { includeHidden: false }))[0];
      return { type: 'steal', victim };
    }
    if (pending.type === 'roadBuilding') {
      const edges = validRoadEdges(state, pid);
      if (!edges.length) return null;
      return { type: 'placeRoad', edge: bestRoad(state, pid, edges) };
    }
    return null;
  }

  const playable = playableDevCards(state);
  const knight = playable.find((c) => c.type === 'knight');

  if (!state.turn.rolled) {
    // Play a knight before rolling if the robber is blocking us or it would win largest army.
    if (knight) {
      const robberHex = state.board.hexes[state.board.robberHex];
      const blocked = robberHex.vertices.some((vk) => {
        const b = state.board.vertices[vk].building;
        return b && b.player === pid;
      });
      const wouldTakeArmy = p.knightsPlayed + 1 >= 3 && p.knightsPlayed + 1 > state.largestArmy.size;
      if (blocked || wouldTakeArmy) return { type: 'playDevCard', card: knight.id };
    }
    return { type: 'roll' };
  }

  // Post-roll: build in priority order.
  if (canBuild(state, 'city')) {
    const vs = validCityVertices(state, pid);
    return { type: 'buildCity', vertex: bestVertex(state, pid, vs) };
  }
  if (canBuild(state, 'settlement')) {
    const vs = validSettlementVertices(state, pid);
    return { type: 'buildSettlement', vertex: bestVertex(state, pid, vs) };
  }
  // Dev cards with immediate value.
  const yop = playable.find((c) => c.type === 'yearOfPlenty');
  if (yop) {
    const want = wantedResources(state, pid);
    const picks = RESOURCES.filter((r) => state.bank[r] > 0)
      .sort((a, b) => want[b] - want[a])
      .slice(0, 2);
    if (picks.length === 2) return { type: 'playDevCard', card: yop.id, resources: picks };
  }
  const mono = playable.find((c) => c.type === 'monopoly');
  if (mono) {
    let bestRes = null;
    let bestN = 2;
    for (const r of RESOURCES) {
      const n = state.players.filter((o) => o.id !== pid).reduce((s, o) => s + o.resources[r], 0);
      if (n > bestN) {
        bestN = n;
        bestRes = r;
      }
    }
    if (bestRes) return { type: 'playDevCard', card: mono.id, resource: bestRes };
  }
  const rb = playable.find((c) => c.type === 'roadBuilding');
  if (rb && piecesLeft(state, pid, 'road') > 0 && validRoadEdges(state, pid).length) return { type: 'playDevCard', card: rb.id };
  if (knight && !state.turn.devPlayed) {
    const robberHex = state.board.hexes[state.board.robberHex];
    const blocked = robberHex.vertices.some((vk) => {
      const b = state.board.vertices[vk].building;
      return b && b.player === pid;
    });
    if (blocked || p.knightsPlayed + 1 > state.largestArmy.size) return { type: 'playDevCard', card: knight.id };
  }
  if (canBuild(state, 'devCard') && totalResources(p.resources) >= 5) return { type: 'buyDevCard' };
  if (canBuild(state, 'road')) {
    // Only build a road if it opens a settlement spot or we have few options.
    const wantsSettlement = validSettlementVertices(state, pid).length === 0 && piecesLeft(state, pid, 'settlement') > 0;
    const longest = state.longestRoad.player !== pid && piecesLeft(state, pid, 'road') > 4;
    const rich = p.resources.brick >= 2 && p.resources.lumber >= 2;
    if (wantsSettlement || longest || rich) return { type: 'buildRoad', edge: bestRoad(state, pid, validRoadEdges(state, pid)) };
  }
  if (canBuild(state, 'devCard')) return { type: 'buyDevCard' };

  // Bank trades toward the next goal.
  const goals = [COSTS.city, COSTS.settlement, COSTS.road, COSTS.devCard].filter((cost) => {
    if (cost === COSTS.city) return piecesLeft(state, pid, 'city') > 0 && validCityVertices(state, pid).length;
    if (cost === COSTS.settlement) return piecesLeft(state, pid, 'settlement') > 0 && validSettlementVertices(state, pid).length;
    if (cost === COSTS.road) return piecesLeft(state, pid, 'road') > 0 && validRoadEdges(state, pid).length;
    return state.devDeck.length > 0;
  });
  for (const cost of goals) {
    const miss = missingFor(p.resources, cost);
    const need = RESOURCES.filter((r) => miss[r] > 0);
    if (need.length === 0 || totalResources(miss) > 2) continue;
    for (const r of RESOURCES) {
      if (cost[r]) continue;
      const ratio = tradeRatio(state, pid, r);
      if (p.resources[r] >= ratio && state.bank[need[0]] > 0) return { type: 'bankTrade', give: r, get: need[0] };
    }
    // Trade surplus of a required resource too, if we have way more than needed.
    for (const r of RESOURCES) {
      if (!cost[r]) continue;
      const ratio = tradeRatio(state, pid, r);
      if (p.resources[r] - (cost[r] || 0) >= ratio && state.bank[need[0]] > 0) return { type: 'bankTrade', give: r, get: need[0] };
    }
  }
  if (canAfford(p.resources, COSTS.road) && canBuild(state, 'road') && totalResources(p.resources) > 7) {
    return { type: 'buildRoad', edge: bestRoad(state, pid, validRoadEdges(state, pid)) };
  }
  return { type: 'endTurn' };
}
