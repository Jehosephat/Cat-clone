import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRollOff, needsRoll, pendingRollers, isComplete, addRoll, rollOrder, describeRollOff } from '../src/rolloff.js';

test('everyone rolls once; distinct values settle the order immediately', () => {
  let rolls = createRollOff(3);
  assert.deepEqual(pendingRollers(rolls), [0, 1, 2]);
  rolls = addRoll(rolls, 1, 4);
  assert.deepEqual(pendingRollers(rolls), [0, 2]);
  assert.equal(needsRoll(rolls, 1), false); // has rolled; waits for the others
  rolls = addRoll(rolls, 0, 2);
  rolls = addRoll(rolls, 2, 6);
  assert.equal(isComplete(rolls), true);
  assert.deepEqual(rollOrder(rolls), [2, 1, 0]);
  assert.equal(describeRollOff(['A', 'B', 'C'], rolls), 'Roll-off: C 6, B 4, A 2. C goes first.');
});

test('tied players re-roll against each other only', () => {
  let rolls = createRollOff(4);
  for (const [pid, v] of [[0, 6], [1, 3], [2, 6], [3, 3]]) rolls = addRoll(rolls, pid, v);
  assert.equal(isComplete(rolls), false);
  assert.deepEqual(pendingRollers(rolls), [0, 1, 2, 3]);
  rolls = addRoll(rolls, 0, 5);
  // Player 0 has rolled ahead; player 2 still owes a die, player 0 waits.
  assert.equal(needsRoll(rolls, 0), false);
  assert.equal(needsRoll(rolls, 2), true);
  rolls = addRoll(rolls, 2, 5); // tie again; the pair on 3 still owes its second die first
  assert.deepEqual(pendingRollers(rolls), [1, 3]);
  rolls = addRoll(rolls, 3, 6);
  rolls = addRoll(rolls, 1, 1);
  assert.deepEqual(pendingRollers(rolls), [0, 2]);
  rolls = addRoll(rolls, 2, 1);
  rolls = addRoll(rolls, 0, 2);
  assert.equal(isComplete(rolls), true);
  assert.deepEqual(rollOrder(rolls), [0, 2, 3, 1]);
  assert.throws(() => addRoll(rolls, 0, 3), /do not need/);
  assert.throws(() => addRoll(createRollOff(2), 0, 7), /1 to 6/);
  assert.match(describeRollOff(['A', 'B', 'C', 'D'], rolls), /A 6→5→2, C 6→5→1, D 3→6, B 3→1\. A goes first\./);
});

test('random roll-offs always terminate with a strict order', () => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return 1 + (seed % 6);
  };
  for (let n = 3; n <= 4; n++) {
    for (let game = 0; game < 200; game++) {
      let rolls = createRollOff(n);
      let steps = 0;
      while (!isComplete(rolls) && steps++ < 1000) {
        const p = pendingRollers(rolls);
        rolls = addRoll(rolls, p[game % p.length], rnd());
      }
      assert.equal(isComplete(rolls), true);
      const order = rollOrder(rolls);
      assert.equal(new Set(order).size, n);
      for (let i = 1; i < order.length; i++) {
        const a = rolls[order[i - 1]];
        const b = rolls[order[i]];
        const m = Math.min(a.length, b.length);
        let decided = false;
        for (let k = 0; k < m && !decided; k++) {
          if (a[k] !== b[k]) {
            assert.ok(a[k] > b[k]);
            decided = true;
          }
        }
        assert.ok(decided, 'adjacent players must be strictly ordered');
      }
    }
  }
});
