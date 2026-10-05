import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBoard, buildTopology, coastalEdgesClockwise, hasAdjacentRedNumbers } from '../src/board.js';
import { createRng } from '../src/rng.js';

test('topology has 19 hexes, 54 vertices, 72 edges and 30 coastal edges', () => {
  const topo = buildTopology(2);
  assert.equal(topo.hexes.length, 19);
  assert.equal(Object.keys(topo.vertices).length, 54);
  assert.equal(Object.keys(topo.edges).length, 72);
  assert.equal(coastalEdgesClockwise(topo).length, 30);
  for (const v of Object.values(topo.vertices)) {
    assert.ok(v.neighbors.length >= 2 && v.neighbors.length <= 3);
    assert.equal(v.neighbors.length, v.edges.length);
  }
});

test('random board has correct terrain and number distribution', () => {
  for (let seed = 1; seed < 30; seed++) {
    const board = generateBoard({ boardLayout: 'random', randomHarbors: true, balancedNumbers: false }, createRng(seed));
    const counts = {};
    const numbers = {};
    for (const h of board.hexes) {
      counts[h.terrain] = (counts[h.terrain] || 0) + 1;
      if (h.number) numbers[h.number] = (numbers[h.number] || 0) + 1;
      if (h.terrain === 'desert') {
        assert.equal(h.number, null);
        assert.equal(board.robberHex, h.id);
      } else assert.ok(h.number >= 2 && h.number <= 12 && h.number !== 7);
    }
    assert.deepEqual(counts, { hills: 3, forest: 4, pasture: 4, fields: 4, mountains: 3, desert: 1 });
    assert.deepEqual(numbers, { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 });
    assert.equal(board.harbors.length, 9);
    const types = board.harbors.map((h) => h.type).sort();
    assert.deepEqual(types, ['any', 'any', 'any', 'any', 'brick', 'grain', 'lumber', 'ore', 'wool']);
    // Each harbor edge is coastal and its vertices know the harbor type.
    for (const hb of board.harbors) {
      assert.equal(board.edges[hb.edge].hexes.length, 1);
      for (const v of hb.vertices) assert.equal(board.vertices[v].harbor, hb.type);
    }
    // No vertex has two harbors.
    const harborVerts = board.harbors.flatMap((h) => h.vertices);
    assert.equal(new Set(harborVerts).size, 18);
  }
});

test('balanced numbers option avoids adjacent 6/8', () => {
  for (let seed = 1; seed < 40; seed++) {
    const board = generateBoard({ boardLayout: 'random', randomHarbors: true, balancedNumbers: true }, createRng(seed));
    assert.equal(hasAdjacentRedNumbers(board, board.hexes), false);
  }
});

test('beginner board matches the rulebook layout', () => {
  const board = generateBoard({ boardLayout: 'beginner', randomHarbors: false }, createRng(1));
  const center = board.hexes[board.coordIndex['0,0']];
  assert.equal(center.terrain, 'desert');
  const topLeft = board.hexes[board.coordIndex['0,-2']];
  assert.equal(topLeft.terrain, 'mountains');
  assert.equal(topLeft.number, 10);
  assert.equal(hasAdjacentRedNumbers(board, board.hexes), false);
  assert.equal(board.harbors[0].type, 'any');
  assert.equal(board.harbors[1].type, 'grain');
});
