import {
  BEGINNER_LAYOUT,
  TERRAIN_COUNTS,
  NUMBER_SPIRAL,
  HARBOR_SEQUENCE,
  TERRAIN_RESOURCE,
} from './constants.js';

// Pointy-top hexes in axial coordinates (q, r). Board is a hexagon of radius 2 (19 hexes).
const SQRT3 = Math.sqrt(3);
export const HEX_SIZE = 1; // unit size; the renderer scales.

// Neighbor offsets indexed by edge direction: 0=E,1=SE,2=SW,3=W,4=NW,5=NE
export const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
];

export function hexCenter(q, r, size = HEX_SIZE) {
  return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
}

// Corner k is at angle (60k - 30) degrees (screen coords, y down).
export function hexCorner(center, k, size = HEX_SIZE) {
  const ang = (Math.PI / 180) * (60 * k - 30);
  return { x: center.x + size * Math.cos(ang), y: center.y + size * Math.sin(ang) };
}

function keyOf(p) {
  return `${p.x.toFixed(3)},${p.y.toFixed(3)}`.replace(/-0\.000/g, '0.000');
}

export function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function allHexCoords(radius = 2) {
  const coords = [];
  for (let r = -radius; r <= radius; r++) {
    for (let q = -radius; q <= radius; q++) {
      if (Math.abs(q + r) <= radius) coords.push({ q, r });
    }
  }
  return coords;
}

// Rows top-to-bottom, left-to-right (3,4,5,4,3) as the rulebook draws them.
export function hexRows(radius = 2) {
  const rows = [];
  for (let r = -radius; r <= radius; r++) {
    const row = [];
    for (let q = Math.max(-radius, -radius - r); q <= Math.min(radius, radius - r); q++) row.push({ q, r });
    rows.push(row);
  }
  return rows;
}

// Hexes at a given ring distance, ordered going around.
function ring(radius) {
  if (radius === 0) return [{ q: 0, r: 0 }];
  const out = [];
  // Start at the "west" corner and walk around counter-clockwise (screen coords).
  let q = -radius;
  let r = 0;
  const walk = [
    [1, -1], // NE
    [1, 0], // E
    [0, 1], // SE
    [-1, 1], // SW
    [-1, 0], // W
    [0, -1], // NW
  ];
  // The walking order above produces: start W corner, move NE along the top-left side...
  // Actually, we want each side to be walked `radius` steps.
  for (const [dq, dr] of walk) {
    for (let i = 0; i < radius; i++) {
      out.push({ q, r });
      q += dq;
      r += dr;
    }
  }
  return out;
}

/**
 * Build the topology of the board (hexes, vertices, edges) independent of terrain.
 */
export function buildTopology(radius = 2) {
  const hexes = [];
  const vertices = {};
  const edges = {};
  const coordIndex = {};

  const coords = allHexCoords(radius);
  coords.forEach((c, i) => {
    const center = hexCenter(c.q, c.r);
    const corners = [];
    for (let k = 0; k < 6; k++) corners.push(hexCorner(center, k));
    const cornerKeys = corners.map(keyOf);
    const hex = { id: i, q: c.q, r: c.r, x: center.x, y: center.y, vertices: cornerKeys, edges: [] };
    hexes.push(hex);
    coordIndex[`${c.q},${c.r}`] = i;
    cornerKeys.forEach((vk, k) => {
      if (!vertices[vk]) {
        vertices[vk] = { key: vk, x: corners[k].x, y: corners[k].y, hexes: [], edges: [], neighbors: [], harbor: null, building: null };
      }
      if (!vertices[vk].hexes.includes(i)) vertices[vk].hexes.push(i);
    });
    for (let k = 0; k < 6; k++) {
      const a = cornerKeys[k];
      const b = cornerKeys[(k + 1) % 6];
      const ek = edgeKey(a, b);
      if (!edges[ek]) edges[ek] = { key: ek, v: [a, b].sort(), hexes: [], road: null };
      if (!edges[ek].hexes.includes(i)) edges[ek].hexes.push(i);
      hex.edges.push(ek);
      if (!vertices[a].edges.includes(ek)) vertices[a].edges.push(ek);
      if (!vertices[b].edges.includes(ek)) vertices[b].edges.push(ek);
      if (!vertices[a].neighbors.includes(b)) vertices[a].neighbors.push(b);
      if (!vertices[b].neighbors.includes(a)) vertices[b].neighbors.push(a);
    }
  });

  return { hexes, vertices, edges, coordIndex, radius };
}

/** Coastal edges (touching exactly one hex) ordered clockwise starting at the top-left. */
export function coastalEdgesClockwise(topo) {
  const coast = Object.values(topo.edges).filter((e) => e.hexes.length === 1);
  const withAngle = coast.map((e) => {
    const a = topo.vertices[e.v[0]];
    const b = topo.vertices[e.v[1]];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // Angle measured so that the top-left of the board (angle ~ -150deg) comes first and
    // increases clockwise in screen coordinates (y down).
    let ang = Math.atan2(my, mx);
    ang -= (-150 * Math.PI) / 180;
    while (ang < 0) ang += Math.PI * 2;
    return { e, ang };
  });
  withAngle.sort((p, q) => p.ang - q.ang);
  return withAngle.map((w) => w.e);
}

// Harbor positions are spaced around the 30 coastal edges in a 3,3,4 pattern.
export function harborEdgeIndices() {
  const gaps = [3, 3, 4, 3, 3, 4, 3, 3, 4];
  const idx = [];
  let pos = 1;
  for (const g of gaps) {
    idx.push(pos);
    pos += g;
  }
  return idx;
}

function spiralOrder(radius, startCorner) {
  // Outer ring starting at a given corner index (0..5) rotated, then inward.
  const order = [];
  for (let rad = radius; rad >= 1; rad--) {
    const ringHexes = ring(rad);
    const offset = (startCorner * rad) % ringHexes.length;
    for (let i = 0; i < ringHexes.length; i++) order.push(ringHexes[(i + offset) % ringHexes.length]);
  }
  order.push({ q: 0, r: 0 });
  return order;
}

function neighborsOf(topo, hex) {
  const out = [];
  for (const [dq, dr] of DIRS) {
    const id = topo.coordIndex[`${hex.q + dq},${hex.r + dr}`];
    if (id !== undefined) out.push(topo.hexes[id]);
  }
  return out;
}

export function hasAdjacentRedNumbers(topo, hexes) {
  for (const h of hexes) {
    if (h.number !== 6 && h.number !== 8) continue;
    for (const n of neighborsOf(topo, h)) {
      if (n.number === 6 || n.number === 8) return true;
    }
  }
  return false;
}

/**
 * Generate a full board.
 * @param {object} options {boardLayout, randomHarbors, balancedNumbers}
 * @param {object} rng
 */
export function generateBoard(options, rng) {
  const topo = buildTopology(2);
  const hexes = topo.hexes.map((h) => ({ ...h, terrain: null, number: null }));

  if (options.boardLayout === 'beginner') {
    const rows = hexRows(2);
    rows.forEach((row, ri) => {
      row.forEach((c, ci) => {
        const [terrain, number] = BEGINNER_LAYOUT[ri][ci];
        const h = hexes[topo.coordIndex[`${c.q},${c.r}`]];
        h.terrain = terrain;
        h.number = number;
      });
    });
  } else {
    let attempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempts++;
      const tiles = [];
      for (const [t, n] of Object.entries(TERRAIN_COUNTS)) for (let i = 0; i < n; i++) tiles.push(t);
      const shuffled = rng.shuffle(tiles);
      const order = spiralOrder(2, rng.int(6));
      let numIdx = 0;
      for (let i = 0; i < order.length; i++) {
        const h = hexes[topo.coordIndex[`${order[i].q},${order[i].r}`]];
        h.terrain = shuffled[i];
        h.number = h.terrain === 'desert' ? null : NUMBER_SPIRAL[numIdx++];
      }
      if (!options.balancedNumbers || !hasAdjacentRedNumbers(topo, hexes)) break;
      if (attempts > 500) {
        // Fallback: shuffle number tokens randomly until balanced.
        const numbered = hexes.filter((h) => h.terrain !== 'desert');
        let tries = 0;
        do {
          const nums = rng.shuffle(NUMBER_SPIRAL);
          numbered.forEach((h, i) => (h.number = nums[i]));
          tries++;
        } while (hasAdjacentRedNumbers(topo, hexes) && tries < 5000);
        break;
      }
    }
  }

  // Harbors
  const coast = coastalEdgesClockwise(topo);
  const harborTypes = options.randomHarbors ? rng.shuffle(HARBOR_SEQUENCE) : HARBOR_SEQUENCE.slice();
  const harbors = [];
  harborEdgeIndices().forEach((ci, i) => {
    const e = coast[ci];
    const type = harborTypes[i];
    harbors.push({ edge: e.key, type, vertices: e.v.slice(), hex: e.hexes[0] });
    for (const vk of e.v) topo.vertices[vk].harbor = type;
  });

  const desert = hexes.find((h) => h.terrain === 'desert');
  return {
    radius: 2,
    hexes,
    vertices: topo.vertices,
    edges: topo.edges,
    coordIndex: topo.coordIndex,
    harbors,
    robberHex: desert ? desert.id : 0,
  };
}

export function hexResource(hex) {
  return TERRAIN_RESOURCE[hex.terrain];
}

export function hexNeighbors(board, hex) {
  return neighborsOf(board, hex);
}
