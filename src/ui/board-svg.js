import { h } from './dom.js';
import { PLAYER_COLORS, RESOURCE_ICON, TERRAIN_RESOURCE, PIPS } from '../constants.js';

const S = 50; // hex size in SVG units

export const TERRAIN_FILL = {
  hills: '#c8683a',
  forest: '#2e7d4f',
  pasture: '#8ccf63',
  fields: '#e8c252',
  mountains: '#8d919c',
  desert: '#e9d9a6',
};

export const SEA = '#2f6fb0';

export function colorOf(state, pid) {
  const p = state.players[pid];
  const c = PLAYER_COLORS.find((x) => x.id === p.color) || PLAYER_COLORS[pid];
  return c.hex;
}

function settlementPoints(x, y) {
  const pts = [
    [-0.22, 0.2],
    [-0.22, -0.04],
    [0, -0.24],
    [0.22, -0.04],
    [0.22, 0.2],
  ];
  return pts.map(([dx, dy]) => `${x + dx * S},${y + dy * S}`).join(' ');
}

function cityPoints(x, y) {
  const pts = [
    [-0.34, 0.22],
    [-0.34, -0.1],
    [-0.19, -0.3],
    [-0.04, -0.1],
    [-0.04, 0.0],
    [0.34, 0.0],
    [0.34, 0.22],
  ];
  return pts.map(([dx, dy]) => `${x + dx * S},${y + dy * S}`).join(' ');
}

function robberShape(x, y) {
  const g = h('svg:g', { class: 'robber' });
  g.append(h('svg:ellipse', { cx: x, cy: y + 0.28 * S, rx: 0.22 * S, ry: 0.08 * S, fill: '#1b1b1f', stroke: '#fff', 'stroke-width': 1.5 }));
  g.append(h('svg:path', { d: `M ${x - 0.17 * S} ${y + 0.28 * S} Q ${x - 0.2 * S} ${y - 0.02 * S} ${x} ${y - 0.05 * S} Q ${x + 0.2 * S} ${y - 0.02 * S} ${x + 0.17 * S} ${y + 0.28 * S} Z`, fill: '#1b1b1f', stroke: '#fff', 'stroke-width': 1.5 }));
  g.append(h('svg:circle', { cx: x, cy: y - 0.17 * S, r: 0.13 * S, fill: '#1b1b1f', stroke: '#fff', 'stroke-width': 1.5 }));
  return g;
}

/**
 * Render the board.
 * @param state game state
 * @param view { vertexTargets: Set, edgeTargets: Set, hexTargets: Set, highlightVertex, onVertex, onEdge, onHex, activeColor }
 */
export function renderBoard(state, view) {
  const board = state.board;
  const verts = Object.values(board.vertices);
  const xs = verts.map((v) => v.x * S);
  const ys = verts.map((v) => v.y * S);
  const margin = 1.05 * S;
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const maxX = Math.max(...xs) + margin;
  const maxY = Math.max(...ys) + margin;

  const svg = h('svg:svg', {
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    class: 'board',
    role: 'img',
    'aria-label': 'Game board',
  });
  svg.append(h('svg:rect', { x: minX, y: minY, width: maxX - minX, height: maxY - minY, fill: SEA, rx: S * 0.4 }));

  // Hexes
  const hexLayer = h('svg:g', { class: 'hexes' });
  for (const hex of board.hexes) {
    const pts = hex.vertices.map((vk) => `${board.vertices[vk].x * S},${board.vertices[vk].y * S}`).join(' ');
    const g = h('svg:g', { class: `hex terrain-${hex.terrain}` });
    g.append(h('svg:polygon', { points: pts, fill: TERRAIN_FILL[hex.terrain], stroke: '#1c3f66', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    const cx = hex.x * S;
    const cy = hex.y * S;
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (res) g.append(h('svg:text', { x: cx, y: cy - 0.42 * S, class: 'hex-icon', 'text-anchor': 'middle', 'font-size': 0.42 * S }, RESOURCE_ICON[res]));
    else g.append(h('svg:text', { x: cx, y: cy - 0.3 * S, class: 'hex-icon', 'text-anchor': 'middle', 'font-size': 0.42 * S }, '🏜️'));
    if (hex.number) {
      const red = hex.number === 6 || hex.number === 8;
      g.append(h('svg:circle', { cx, cy: cy + 0.2 * S, r: 0.3 * S, fill: '#f6ecd2', stroke: '#8b7340', 'stroke-width': 1.5 }));
      g.append(
        h('svg:text', { x: cx, y: cy + 0.2 * S + 0.08 * S, 'text-anchor': 'middle', 'font-size': (red ? 0.34 : 0.3) * S, 'font-weight': 700, fill: red ? '#c0392b' : '#1f1a12', class: 'token' }, hex.number),
      );
      const pips = PIPS[hex.number];
      const dots = [];
      for (let i = 0; i < pips; i++) dots.push(h('svg:circle', { cx: cx + (i - (pips - 1) / 2) * 0.07 * S, cy: cy + 0.2 * S + 0.2 * S, r: 0.025 * S, fill: red ? '#c0392b' : '#1f1a12' }));
      g.append(...dots);
    }
    hexLayer.append(g);
  }
  svg.append(hexLayer);

  // Harbors
  const harborLayer = h('svg:g', { class: 'harbors' });
  for (const hb of board.harbors) {
    const hex = board.hexes[hb.hex];
    const a = board.vertices[hb.vertices[0]];
    const b = board.vertices[hb.vertices[1]];
    const mx = ((a.x + b.x) / 2) * S;
    const my = ((a.y + b.y) / 2) * S;
    const dx = mx - hex.x * S;
    const dy = my - hex.y * S;
    const len = Math.hypot(dx, dy);
    const px = mx + (dx / len) * 0.5 * S;
    const py = my + (dy / len) * 0.5 * S;
    const g = h('svg:g', { class: 'harbor' });
    for (const v of [a, b]) g.append(h('svg:line', { x1: px, y1: py, x2: v.x * S, y2: v.y * S, stroke: '#f6ecd2', 'stroke-width': 3, 'stroke-dasharray': '4 3', opacity: 0.8 }));
    g.append(h('svg:circle', { cx: px, cy: py, r: 0.3 * S, fill: '#f6ecd2', stroke: '#8b7340', 'stroke-width': 1.5 }));
    if (hb.type === 'any') {
      g.append(h('svg:text', { x: px, y: py + 0.07 * S, 'text-anchor': 'middle', 'font-size': 0.24 * S, 'font-weight': 700, fill: '#1f1a12' }, '3:1'));
    } else {
      g.append(h('svg:text', { x: px, y: py - 0.02 * S, 'text-anchor': 'middle', 'font-size': 0.24 * S }, RESOURCE_ICON[hb.type]));
      g.append(h('svg:text', { x: px, y: py + 0.2 * S, 'text-anchor': 'middle', 'font-size': 0.17 * S, 'font-weight': 700, fill: '#1f1a12' }, '2:1'));
    }
    harborLayer.append(g);
  }
  svg.append(harborLayer);

  // Roads
  const roadLayer = h('svg:g', { class: 'roads' });
  for (const e of Object.values(board.edges)) {
    if (e.road === null) continue;
    const a = board.vertices[e.v[0]];
    const b = board.vertices[e.v[1]];
    const x1 = (a.x + (b.x - a.x) * 0.12) * S;
    const y1 = (a.y + (b.y - a.y) * 0.12) * S;
    const x2 = (a.x + (b.x - a.x) * 0.88) * S;
    const y2 = (a.y + (b.y - a.y) * 0.88) * S;
    roadLayer.append(h('svg:line', { x1, y1, x2, y2, stroke: '#1b1b1f', 'stroke-width': 0.24 * S, 'stroke-linecap': 'round' }));
    roadLayer.append(h('svg:line', { x1, y1, x2, y2, stroke: colorOf(state, e.road), 'stroke-width': 0.15 * S, 'stroke-linecap': 'round' }));
  }
  svg.append(roadLayer);

  // Buildings
  const buildingLayer = h('svg:g', { class: 'buildings' });
  for (const v of verts) {
    if (!v.building) continue;
    const x = v.x * S;
    const y = v.y * S;
    const pts = v.building.type === 'city' ? cityPoints(x, y) : settlementPoints(x, y);
    buildingLayer.append(h('svg:polygon', { points: pts, fill: colorOf(state, v.building.player), stroke: '#1b1b1f', 'stroke-width': 2, 'stroke-linejoin': 'round', class: `building ${v.building.type}` }));
  }
  svg.append(buildingLayer);

  // Robber
  const rh = board.hexes[board.robberHex];
  svg.append(robberShape(rh.x * S + 0.5 * S, rh.y * S + 0.15 * S));

  // Targets
  const targetLayer = h('svg:g', { class: 'targets' });
  const color = view.activeColor || '#fff';
  if (view.hexTargets && view.hexTargets.size) {
    for (const hex of board.hexes) {
      if (!view.hexTargets.has(hex.id)) continue;
      const pts = hex.vertices.map((vk) => `${board.vertices[vk].x * S},${board.vertices[vk].y * S}`).join(' ');
      targetLayer.append(
        h('svg:polygon', {
          points: pts,
          class: 'target hex-target',
          fill: 'rgba(255,255,255,0.25)',
          stroke: '#fff',
          'stroke-width': 3,
          'stroke-dasharray': '6 4',
          onclick: () => view.onHex && view.onHex(hex.id),
        }),
      );
    }
  }
  if (view.edgeTargets && view.edgeTargets.size) {
    for (const ek of view.edgeTargets) {
      const e = board.edges[ek];
      const a = board.vertices[e.v[0]];
      const b = board.vertices[e.v[1]];
      const x1 = (a.x + (b.x - a.x) * 0.2) * S;
      const y1 = (a.y + (b.y - a.y) * 0.2) * S;
      const x2 = (a.x + (b.x - a.x) * 0.8) * S;
      const y2 = (a.y + (b.y - a.y) * 0.8) * S;
      const g = h('svg:g', { class: 'target edge-target', onclick: () => view.onEdge && view.onEdge(ek) });
      g.append(h('svg:line', { x1, y1, x2, y2, stroke: 'rgba(0,0,0,0.001)', 'stroke-width': 0.5 * S, 'stroke-linecap': 'round' }));
      g.append(h('svg:line', { x1, y1, x2, y2, stroke: '#fff', 'stroke-width': 0.22 * S, 'stroke-linecap': 'round', opacity: 0.9 }));
      g.append(h('svg:line', { x1, y1, x2, y2, stroke: color, 'stroke-width': 0.12 * S, 'stroke-linecap': 'round', 'stroke-dasharray': '6 5' }));
      targetLayer.append(g);
    }
  }
  if (view.vertexTargets && view.vertexTargets.size) {
    for (const vk of view.vertexTargets) {
      const v = board.vertices[vk];
      const g = h('svg:g', { class: 'target vertex-target', onclick: () => view.onVertex && view.onVertex(vk) });
      g.append(h('svg:circle', { cx: v.x * S, cy: v.y * S, r: 0.42 * S, fill: 'rgba(0,0,0,0.001)' }));
      g.append(h('svg:circle', { cx: v.x * S, cy: v.y * S, r: 0.28 * S, fill: '#fff', opacity: 0.9 }));
      g.append(h('svg:circle', { cx: v.x * S, cy: v.y * S, r: 0.2 * S, fill: color, stroke: '#1b1b1f', 'stroke-width': 1.5 }));
      targetLayer.append(g);
    }
  }
  svg.append(targetLayer);
  return svg;
}
