import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, sanitizeAction } from '../server/rooms.js';
import { redactFor } from '../server/redact.js';
import { validSettlementVertices, actingPlayers } from '../src/game.js';
import { botAction } from '../src/ai.js';
import { totalResources } from '../src/rules.js';

function fakeClient() {
  return {
    room: null,
    seat: null,
    inbox: [],
    send(msg) {
      this.inbox.push(msg);
    },
    last(t) {
      for (let i = this.inbox.length - 1; i >= 0; i--) if (!t || this.inbox[i].t === t) return this.inbox[i];
      return undefined;
    },
  };
}

function manager() {
  const timers = [];
  const rm = new RoomManager({ schedule: (fn) => (timers.push(fn), fn), cancel: (fn) => timers.splice(timers.indexOf(fn), 1), botDelay: 0 });
  rm.runTimers = (limit = 100000) => {
    let n = 0;
    while (timers.length && n++ < limit) timers.shift()();
  };
  return rm;
}

function lobbyWith(rm, humans = 2, bots = 1) {
  const clients = [];
  const host = fakeClient();
  rm.handle(host, { t: 'create', name: 'Host' });
  clients.push(host);
  const code = host.last('session').room;
  for (let i = 1; i < humans; i++) {
    const c = fakeClient();
    rm.handle(c, { t: 'join', room: code.toLowerCase(), name: `P${i + 1}` });
    clients.push(c);
  }
  for (let i = 0; i < bots; i++) rm.handle(host, { t: 'addBot' });
  return { code, clients };
}

test('create, join, lobby management and start', () => {
  const rm = manager();
  const { code, clients } = lobbyWith(rm, 2, 0);
  const [host, guest] = clients;
  assert.match(code, /^[A-Z]{4}$/);
  let view = guest.last('room').room;
  assert.equal(view.seats.length, 2);
  assert.equal(view.you, 1);
  assert.equal(view.host, 0);
  assert.equal(view.seats[1].name, 'P2');

  // Non-hosts cannot change options or start.
  rm.handle(guest, { t: 'setOptions', options: { targetVP: 8 } });
  assert.equal(guest.last().t, 'error');
  rm.handle(guest, { t: 'start' });
  assert.match(guest.last('error').message, /host/i);

  // Host options are validated.
  rm.handle(host, { t: 'setOptions', options: { targetVP: 8, boardLayout: 'beginner', discardLimit: 3, evil: true } });
  view = guest.last('room').room;
  assert.equal(view.options.targetVP, 8);
  assert.equal(view.options.boardLayout, 'beginner');
  assert.equal(view.options.discardLimit, 7);
  assert.equal(view.options.evil, undefined);

  // Colors swap rather than duplicate.
  rm.handle(guest, { t: 'setColor', color: 'red' });
  view = host.last('room').room;
  assert.equal(view.seats[1].color, 'red');
  assert.equal(view.seats[0].color, 'blue');

  // Needs 3 players.
  rm.handle(host, { t: 'start' });
  assert.match(host.last('error').message, /at least 3/);
  rm.handle(host, { t: 'addBot' });
  rm.handle(host, { t: 'start' });
  const msg = guest.last('room');
  assert.equal(msg.room.phase, 'game');
  assert.equal(msg.state.players.length, 3);
  assert.equal(msg.state.players[2].isBot, true);
  assert.equal(msg.state.options.targetVP, 8);

  // Late joiners are refused.
  const late = fakeClient();
  rm.handle(late, { t: 'join', room: code, name: 'Late' });
  assert.match(late.last('error').message, /already started/);
});

test('only the current player may act, and state is redacted per player', () => {
  const rm = manager();
  const { clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  rm.handle(host, { t: 'start' });
  const room = host.room;

  // Guest cannot place during the host's setup turn.
  const v = validSettlementVertices(room.state, 0, { setup: true })[0];
  rm.handle(guest, { t: 'action', action: { type: 'placeSettlement', vertex: v } });
  assert.match(guest.last('error').message, /not your turn/i);
  rm.handle(host, { t: 'action', action: { type: 'placeSettlement', vertex: v } });
  assert.equal(room.state.board.vertices[v].building.player, 0);

  // Secrets never reach clients.
  const s = guest.last('room').state;
  assert.equal(s.seed, 0);
  assert.equal(s.rngState, 0);
  assert.equal(s.options.seed, null);
  assert.ok(s.devDeck.every((c) => c === 'hidden'));
  assert.equal(s.devDeck.length, 25);
});

test('redaction hides opponents hands, dev cards and private event details', () => {
  const rm = manager();
  const { clients } = lobbyWith(rm, 1, 2);
  rm.handle(clients[0], { t: 'start' });
  const full = structuredClone(clients[0].room.state);
  full.players[0].resources = { brick: 1, lumber: 2, wool: 0, grain: 0, ore: 0 };
  full.players[1].resources = { brick: 3, lumber: 0, wool: 1, grain: 0, ore: 0 };
  full.players[1].devCards = [{ id: 'x', type: 'victoryPoint', boughtTurn: 1 }];
  full.lastEvent = { type: 'steal', thief: 1, victim: 2, resource: 'ore' };
  const mine = redactFor(full, 0);
  assert.deepEqual(mine.players[0].resources, full.players[0].resources);
  assert.equal(mine.players[1].handCount, 4);
  assert.equal(totalResources(mine.players[1].resources), 0);
  assert.deepEqual(mine.players[1].devCards.map((c) => c.type), ['hidden']);
  assert.equal(mine.lastEvent.resource, undefined);
  assert.equal(redactFor(full, 2).lastEvent.resource, 'ore');
  // Ended games reveal everything except the RNG.
  full.phase = 'ended';
  const end = redactFor(full, 0);
  assert.equal(end.players[1].devCards[0].type, 'victoryPoint');
  assert.equal(end.rngState, 0);
});

test('discard and trade responses are bound to the sender seat', () => {
  const rm = manager();
  const { clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  rm.handle(host, { t: 'start' });
  const room = host.room;
  // Fast-forward through setup with bot logic for everyone.
  while (room.state.phase === 'setup') {
    const pid = actingPlayers(room.state)[0];
    rm.apply(room, botAction(room.state, pid));
  }
  rm.runTimers(0);
  room.state.turn.player = 0;
  room.state.turn.rolled = true;
  room.state.players[0].resources = { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 };
  room.state.players[1].resources = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 2 };
  rm.handle(host, { t: 'action', action: { type: 'proposeTrade', offer: { brick: 1 }, request: { ore: 1 } } });
  assert.equal(room.state.pending.type, 'trade');
  // A guest's attempt to answer for someone else is rebound to their own seat.
  rm.handle(guest, { t: 'action', action: { type: 'respondTrade', player: 2, accept: true } });
  assert.equal(room.state.pending.responses[1], 'accepted');
  assert.equal(room.state.pending.responses[2], null);
  // Guest cannot accept on the host's behalf.
  rm.handle(guest, { t: 'action', action: { type: 'acceptTrade', partner: 1 } });
  assert.match(guest.last('error').message, /not your turn/i);
  rm.handle(host, { t: 'action', action: { type: 'acceptTrade', partner: 1 } });
  assert.equal(room.state.players[0].resources.ore, 1);
  assert.equal(room.state.players[1].resources.brick, 1);
});

test('malformed actions are rejected without corrupting state', () => {
  const rm = manager();
  const { clients } = lobbyWith(rm, 1, 2);
  const [host] = clients;
  rm.handle(host, { t: 'start' });
  const room = host.room;
  const before = JSON.stringify(room.state);
  for (const action of [
    null,
    { type: 'constructor' },
    { type: '__proto__' },
    { type: 'placeSettlement', vertex: { toString: 1 } },
    { type: 'placeSettlement', vertex: '__proto__' },
    { type: 'proposeTrade', offer: { brick: '1' }, request: { ore: 1 } },
    { type: 'discard', resources: { brick: -1 } },
  ]) {
    rm.handle(host, { t: 'action', action });
    assert.equal(host.last().t, 'error', JSON.stringify(action));
  }
  rm.handle(host, { t: 'nonsense' });
  rm.handle(host, null);
  assert.equal(JSON.stringify(room.state), before);
  assert.throws(() => sanitizeAction({ type: 'hack' }));
});

test('reconnect with token, replace an absent player with a bot, and take the seat back', () => {
  const rm = manager();
  const { code, clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  const token = guest.last('session').token;
  rm.handle(host, { t: 'start' });
  rm.disconnect(guest);
  assert.equal(host.last('room').room.seats[1].connected, false);

  // Bad token fails cleanly.
  const imposter = fakeClient();
  rm.handle(imposter, { t: 'rejoin', room: code, token: 'nope' });
  assert.equal(imposter.last().t, 'rejoinFailed');

  // Cannot replace a connected player; can replace a disconnected one.
  rm.handle(host, { t: 'replaceWithBot', seat: 0 });
  assert.match(host.last('error').message, /not a human|still connected/);
  rm.handle(host, { t: 'replaceWithBot', seat: 1 });
  assert.equal(host.room.state.players[1].isBot, true);

  const back = fakeClient();
  rm.handle(back, { t: 'rejoin', room: code.toLowerCase(), token });
  const view = back.last('room');
  assert.equal(view.room.you, 1);
  assert.equal(view.state.players[1].isBot, false);
  assert.equal(view.room.seats[1].connected, true);
});

test('a lobby room is deleted when the last human leaves, and idle rooms are swept', () => {
  let now = 0;
  const rm = new RoomManager({ schedule: () => 0, cancel: () => {}, now: () => now, roomTtlMs: 1000 });
  const a = fakeClient();
  rm.handle(a, { t: 'create', name: 'A' });
  rm.handle(a, { t: 'addBot' });
  rm.handle(a, { t: 'leave' });
  assert.equal(rm.rooms.size, 0);

  const b = fakeClient();
  rm.handle(b, { t: 'create', name: 'B' });
  rm.disconnect(b);
  now = 500;
  rm.sweep();
  assert.equal(rm.rooms.size, 1);
  now = 5000;
  rm.sweep();
  assert.equal(rm.rooms.size, 0);
});

test('a networked game with one human and bots can be played to the end', () => {
  const rm = manager();
  const { clients } = lobbyWith(rm, 1, 3);
  const [host] = clients;
  rm.handle(host, { t: 'start' });
  const room = host.room;
  let guard = 0;
  while (room.state.phase !== 'ended' && guard++ < 20000) {
    rm.runTimers(50);
    if (room.state.phase === 'ended') break;
    const actors = actingPlayers(room.state);
    if (actors.includes(0)) {
      // Drive the human seat through the same protocol a browser would use, using the bot's choice.
      const action = botAction(room.state, 0);
      if (action) rm.handle(host, { t: 'action', action });
    }
  }
  assert.equal(room.state.phase, 'ended');
  const final = host.last('room').state;
  assert.equal(final.phase, 'ended');
  // Host restarts back to the lobby.
  rm.handle(host, { t: 'restart' });
  assert.equal(host.last('room').room.phase, 'lobby');
});
