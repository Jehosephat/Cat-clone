import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, act, actingPlayers } from '../src/game.js';
import { botAction } from '../src/ai.js';

test('four bots can play complete games to a winner', () => {
  for (let seed = 1; seed <= 6; seed++) {
    let s = newGame({
      playerCount: seed % 2 ? 4 : 3,
      seed,
      boardLayout: seed % 3 ? 'random' : 'beginner',
      balancedNumbers: seed % 2 === 0,
      friendlyRobber: seed % 4 === 0,
      players: [{ isBot: true }, { isBot: true }, { isBot: true }, { isBot: true }],
    });
    let steps = 0;
    while (s.phase !== 'ended' && steps < 20000) {
      const actors = actingPlayers(s);
      let acted = false;
      for (const pid of actors) {
        const a = botAction(s, pid);
        if (a) {
          s = act(s, a);
          acted = true;
          break;
        }
      }
      assert.ok(acted, `bot stalled at step ${steps} (pending ${JSON.stringify(s.pending)}, phase ${s.phase})`);
      steps++;
    }
    assert.equal(s.phase, 'ended', `seed ${seed} did not finish`);
    assert.ok(s.winner !== null);
    // Bank never negative, piece limits respected.
    for (const r of Object.keys(s.bank)) assert.ok(s.bank[r] >= 0);
    for (const p of s.players) {
      const roads = Object.values(s.board.edges).filter((e) => e.road === p.id).length;
      assert.ok(roads <= 15);
      for (const r of Object.keys(p.resources)) assert.ok(p.resources[r] >= 0);
    }
  }
});
