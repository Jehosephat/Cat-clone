import { COSTS, RESOURCES, PIECE_LIMITS } from './constants.js';

export function emptyResources() {
  return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
}

export function totalResources(res) {
  return RESOURCES.reduce((s, r) => s + (res[r] || 0), 0);
}

/** Number of resource cards a player holds. Works on redacted states, where opponents only expose a count. */
export function handSize(player) {
  return typeof player.handCount === 'number' ? player.handCount : totalResources(player.resources);
}

export function canAfford(resources, cost) {
  return Object.entries(cost).every(([r, n]) => (resources[r] || 0) >= n);
}

export function playerById(state, id) {
  return state.players[id];
}

/** Vertices where `playerId` may place a settlement. */
export function validSettlementVertices(state, playerId, { setup = false } = {}) {
  const board = state.board;
  const out = [];
  for (const v of Object.values(board.vertices)) {
    if (v.building) continue;
    // Distance rule: no adjacent buildings.
    if (v.neighbors.some((nk) => board.vertices[nk].building)) continue;
    if (!setup) {
      // Must connect to one of the player's roads.
      if (!v.edges.some((ek) => board.edges[ek].road === playerId)) continue;
    }
    out.push(v.key);
  }
  return out;
}

/** Edges where `playerId` may place a road. `fromVertex` restricts to edges touching that vertex (setup). */
export function validRoadEdges(state, playerId, { fromVertex = null } = {}) {
  const board = state.board;
  const out = [];
  for (const e of Object.values(board.edges)) {
    if (e.road !== null) continue;
    if (fromVertex) {
      if (!e.v.includes(fromVertex)) continue;
      out.push(e.key);
      continue;
    }
    // Road must connect to own road or own building, not passing through an opponent's building.
    let ok = false;
    for (const vk of e.v) {
      const v = board.vertices[vk];
      if (v.building && v.building.player === playerId) {
        ok = true;
        break;
      }
      if (v.building && v.building.player !== playerId) continue; // blocked at this end
      if (v.edges.some((ek) => ek !== e.key && board.edges[ek].road === playerId)) {
        ok = true;
        break;
      }
    }
    if (ok) out.push(e.key);
  }
  return out;
}

export function validCityVertices(state, playerId) {
  return Object.values(state.board.vertices)
    .filter((v) => v.building && v.building.player === playerId && v.building.type === 'settlement')
    .map((v) => v.key);
}

/** Longest continuous road for a player (edges used once, opponent buildings break the chain). */
export function longestRoadLength(board, playerId) {
  const edges = Object.values(board.edges).filter((e) => e.road === playerId);
  if (edges.length === 0) return 0;
  const adj = {};
  for (const e of edges) {
    for (const vk of e.v) {
      if (!adj[vk]) adj[vk] = [];
      adj[vk].push(e);
    }
  }
  const blocked = (vk) => {
    const b = board.vertices[vk].building;
    return b && b.player !== playerId;
  };
  let best = 0;
  const used = new Set();
  const dfs = (vk, len) => {
    if (len > best) best = len;
    if (len > 0 && blocked(vk)) return; // cannot continue through an opponent's building (may start there)
    for (const e of adj[vk]) {
      if (used.has(e.key)) continue;
      used.add(e.key);
      const next = e.v[0] === vk ? e.v[1] : e.v[0];
      dfs(next, len + 1);
      used.delete(e.key);
    }
  };
  for (const vk of Object.keys(adj)) dfs(vk, 0);
  return best;
}

export function countVictoryPoints(state, playerId, { includeHidden = true } = {}) {
  const p = state.players[playerId];
  let vp = 0;
  for (const v of Object.values(state.board.vertices)) {
    if (v.building && v.building.player === playerId) vp += v.building.type === 'city' ? 2 : 1;
  }
  if (state.longestRoad.player === playerId) vp += 2;
  if (state.largestArmy.player === playerId) vp += 2;
  if (includeHidden) vp += p.devCards.filter((c) => c.type === 'victoryPoint').length;
  return vp;
}

export function piecesLeft(state, playerId, type) {
  const p = state.players[playerId];
  const placed = Object.values(state.board[type === 'road' ? 'edges' : 'vertices']).filter((x) =>
    type === 'road' ? x.road === playerId : x.building && x.building.player === playerId && x.building.type === type,
  ).length;
  void p;
  const limit = type === 'road' ? PIECE_LIMITS.roads : type === 'settlement' ? PIECE_LIMITS.settlements : PIECE_LIMITS.cities;
  return limit - placed;
}

/** Best maritime trade ratio for giving a resource. */
export function tradeRatio(state, playerId, resource) {
  let ratio = 4;
  for (const v of Object.values(state.board.vertices)) {
    if (!v.building || v.building.player !== playerId || !v.harbor) continue;
    if (v.harbor === 'any') ratio = Math.min(ratio, 3);
    else if (v.harbor === resource) ratio = Math.min(ratio, 2);
  }
  return ratio;
}

export function playerHarbors(state, playerId) {
  const set = new Set();
  for (const v of Object.values(state.board.vertices)) {
    if (v.building && v.building.player === playerId && v.harbor) set.add(v.harbor);
  }
  return [...set];
}

export { COSTS };
