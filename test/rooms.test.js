import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, sanitizeAction } from '../server/rooms.js';
import { redactFor } from '../server/redact.js';
import { validSettlementVertices, validRoadEdges, actingPlayers } from '../src/game.js';
import { botAction } from '../src/ai.js';
import { totalResources } from '../src/rules.js';
import { pendingRollers } from '../src/rolloff.js';

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

function manager({ undo = false } = {}) {
  const timers = [];
  const clock = { now: 0 };
  // Dice for the roll-off default to 6 - seat, so seat order is turn order unless a test overrides `rm.roll`.
  const rm = new RoomManager({
    schedule: (fn, ms) => (timers.push({ fn, ms }), fn),
    cancel: (fn) => { const i = timers.findIndex((t) => t.fn === fn); if (i >= 0) timers.splice(i, 1); },
    botDelay: 0,
    roll: (idx) => 6 - idx,
    now: () => clock.now,
  });
  rm.clock = clock;
  rm.timers = timers;
  rm.runTimers = (limit = 100000) => {
    let n = 0;
    while (timers.length && n++ < limit) {
      const t = timers.shift();
      clock.now += t.ms; // fake time advances by each timer's delay
      t.fn();
    }
  };
  rm.undoByDefault = undo;
  return rm;
}

/** Send 'start' and then roll for every human until the game begins (bots roll on timers). */
function startGame(rm, clients) {
  const host = clients[0];
  rm.handle(host, { t: 'start' });
  let guard = 0;
  while (host.room && host.room.phase === 'rolloff' && guard++ < 1000) {
    rm.runTimers(10);
    const pending = host.room.rolloff ? pendingRollers(host.room.rolloff) : [];
    for (const c of clients) {
      if (!host.room || host.room.phase !== 'rolloff') break;
      const idx = host.room.seats.indexOf(c.seat);
      if (pending.includes(idx)) rm.handle(c, { t: 'rollDie' });
    }
  }
}

function lobbyWith(rm, humans = 2, bots = 1) {
  const clients = [];
  const host = fakeClient();
  rm.handle(host, { t: 'create', name: 'Host' });
  if (!rm.undoByDefault) rm.handle(host, { t: 'setOptions', options: { undo: false } }); // keep older tests' bot timing
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
  startGame(rm, clients);
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
  startGame(rm, clients);
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
  startGame(rm, clients);
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
  startGame(rm, clients);
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
  startGame(rm, clients);
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
  startGame(rm, clients);
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
  startGame(rm, clients);
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


test('the starting player is decided by a roll-off, with ties re-rolled', () => {
  const rm = manager();
  const { clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  // Nobody can roll before the host starts.
  rm.handle(guest, { t: 'rollDie' });
  assert.match(guest.last('error').message, /no roll-off/i);
  rm.handle(host, { t: 'start' });
  const room = host.room;
  assert.equal(room.phase, 'rolloff');
  let view = guest.last('room').room;
  assert.equal(view.phase, 'rolloff');
  assert.deepEqual(view.rolloff.rolls, [[], [], []]);
  assert.deepEqual(view.rolloff.pending, [0, 1, 2]);
  assert.equal(guest.last('room').state, null);
  // Late joiners are told the game is starting.
  const late = fakeClient();
  rm.handle(late, { t: 'join', room: room.code, name: 'Late' });
  assert.match(late.last('error').message, /starting/);

  // Everyone rolls a 6: the bot on its timer, the humans by hand.
  rm.roll = () => 6;
  rm.runTimers(5);
  assert.deepEqual(room.rolloff[2], [6]);
  rm.handle(guest, { t: 'rollDie' });
  assert.deepEqual(room.rolloff[1], [6]);
  rm.handle(guest, { t: 'rollDie' });
  assert.match(guest.last('error').message, /already rolled/);
  rm.handle(host, { t: 'rollDie' });
  assert.equal(room.phase, 'rolloff');
  view = guest.last('room').room;
  assert.deepEqual(view.rolloff.rolls, [[6], [6], [6]]);
  assert.deepEqual(view.rolloff.pending, [0, 1, 2]);

  // Re-roll: host 2, guest 5, bot 3.
  rm.roll = (idx) => [2, 5, 3][idx];
  rm.runTimers(5);
  rm.handle(host, { t: 'rollDie' });
  assert.equal(room.phase, 'rolloff');
  rm.handle(guest, { t: 'rollDie' });
  assert.equal(room.phase, 'game');
  const state = host.last('room').state;
  assert.deepEqual(state.turnOrder, [1, 2, 0]);
  assert.equal(state.turn.player, 1);
  assert.equal(state.log[0].text, 'Roll-off: P2 6→5, Bot 1 6→3, Host 6→2. P2 goes first.');
  assert.equal(host.last('room').room.rolloff, null);
  assert.equal(host.last('room').room.phase, 'game');
});

test('the host can return a roll-off to the lobby, and a leaving player resets it', () => {
  const rm = manager();
  const { clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  rm.handle(host, { t: 'start' });
  rm.handle(guest, { t: 'cancelRollOff' });
  assert.match(guest.last('error').message, /host/);
  rm.handle(host, { t: 'cancelRollOff' });
  assert.equal(host.room.phase, 'lobby');
  assert.equal(host.room.rolloff, null);
  assert.equal(guest.last('room').room.rolloff, null);
  // Options can be changed again, then start once more; a leaving guest sends everyone back.
  rm.handle(host, { t: 'start' });
  rm.handle(guest, { t: 'rollDie' });
  rm.handle(guest, { t: 'leave' });
  assert.equal(host.room.phase, 'lobby');
  assert.equal(host.room.seats.length, 2);
  rm.handle(host, { t: 'addBot' });
  startGame(rm, [host]);
  assert.equal(host.room.phase, 'game');
  assert.equal(host.room.state.players.length, 3);
});


test('undo: offered to the actor for a few seconds, bots wait, and it expires or is overtaken', () => {
  const rm = manager({ undo: true });
  const { clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  assert.equal(host.last('room').room.options.undo, true);
  startGame(rm, clients);
  const room = host.room;
  assert.equal(room.state.turn.player, 0);

  // Host places a settlement: the host gets an offer, the guest does not.
  const v = validSettlementVertices(room.state, 0, { setup: true })[0];
  rm.handle(host, { t: 'action', action: { type: 'placeSettlement', vertex: v } });
  const offer = host.last('room').undo;
  assert.equal(offer.label, 'settlement placement');
  assert.equal(offer.remainingMs, 4000);
  assert.equal(guest.last('room').undo, null);
  // Only the actor may undo.
  rm.handle(guest, { t: 'undo' });
  assert.match(guest.last('error').message, /nothing to undo/i);
  rm.handle(host, { t: 'undo' });
  assert.equal(room.state.board.vertices[v].building, null);
  assert.equal(room.state.setup.step, 'settlement');
  assert.match(room.state.log.at(-1).text, /Host takes back their settlement placement/);
  assert.equal(host.last('room').undo, null);
  // A second undo has nothing to take back.
  rm.handle(host, { t: 'undo' });
  assert.match(host.last('error').message, /nothing to undo/i);

  // Place again, then let the window expire: too late.
  rm.handle(host, { t: 'action', action: { type: 'placeSettlement', vertex: v } });
  rm.clock.now += 4001;
  rm.handle(host, { t: 'undo' });
  assert.match(host.last('error').message, /nothing to undo/i);
  assert.equal(room.state.board.vertices[v].building.player, 0);

  // Finish the host's placement; the next seat is the guest, so another human action overtakes the offer.
  const e = validRoadEdges(room.state, 0, { fromVertex: v })[0];
  rm.handle(host, { t: 'action', action: { type: 'placeRoad', edge: e } });
  assert.equal(host.last('room').undo.label, 'road placement');
  assert.equal(room.state.turn.player, 1);
  const v2 = validSettlementVertices(room.state, 1, { setup: true })[0];
  rm.handle(guest, { t: 'action', action: { type: 'placeSettlement', vertex: v2 } });
  rm.handle(host, { t: 'undo' });
  assert.match(host.last('error').message, /nothing to undo/i);
  assert.equal(guest.last('room').undo.label, 'settlement placement');

  // Guest finishes: the bot is next, but it must wait out the guest's undo window.
  const e2 = validRoadEdges(room.state, 1, { fromVertex: v2 })[0];
  rm.handle(guest, { t: 'action', action: { type: 'placeRoad', edge: e2 } });
  assert.equal(room.state.turn.player, 2);
  assert.equal(rm.timers.length, 1);
  assert.ok(rm.timers[0].ms >= 4000, `bot delay was ${rm.timers[0].ms}`);
  // The guest changes their mind in time; the bot timer then finds nothing to do for the bot.
  rm.handle(guest, { t: 'undo' });
  assert.equal(room.state.turn.player, 1);
  rm.runTimers(5);
  assert.equal(room.state.turn.player, 1);
  rm.handle(guest, { t: 'action', action: { type: 'placeRoad', edge: e2 } });
  rm.runTimers(5);
  assert.equal(room.state.board.vertices[validSettlementVertices(room.state, 2, { setup: true })[0]].building, null);
  // Bot moves happen after the window and never carry an offer.
  assert.ok(room.state.turn.player !== 2 || room.state.setup.step !== 'settlement' || rm.timers.length > 0);
});

test('undo: trades with players are never undoable, and the option can be turned off', () => {
  const rm = manager({ undo: true });
  const { clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  startGame(rm, clients);
  const room = host.room;
  while (room.state.phase === 'setup') {
    const pid = actingPlayers(room.state)[0];
    rm.apply(room, botAction(room.state, pid));
  }
  rm.runTimers(0);
  room.state.turn.player = 0;
  room.state.turn.rolled = true;
  room.state.players[0].resources = { brick: 4, lumber: 0, wool: 0, grain: 0, ore: 0 };
  room.state.players[1].resources = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 2 };
  rm.handle(host, { t: 'action', action: { type: 'bankTrade', give: 'brick', get: 'ore' } });
  assert.equal(host.last('room').undo.label, 'bank trade');
  rm.handle(host, { t: 'undo' });
  assert.equal(room.state.players[0].resources.brick, 4);
  rm.handle(host, { t: 'action', action: { type: 'proposeTrade', offer: { brick: 1 }, request: { ore: 1 } } });
  assert.equal(host.last('room').undo, null);
  rm.handle(guest, { t: 'action', action: { type: 'respondTrade', accept: true } });
  assert.equal(guest.last('room').undo, null);
  rm.handle(host, { t: 'action', action: { type: 'acceptTrade', partner: 1 } });
  assert.equal(host.last('room').undo, null);
  rm.handle(host, { t: 'undo' });
  assert.match(host.last('error').message, /nothing to undo/i);
  assert.equal(room.state.players[0].resources.ore, 1);

  const off = manager();
  const l2 = lobbyWith(off, 1, 2);
  startGame(off, l2.clients);
  const r2 = l2.clients[0].room;
  assert.equal(r2.options.undo, false);
  const vv = validSettlementVertices(r2.state, 0, { setup: true })[0];
  off.handle(l2.clients[0], { t: 'action', action: { type: 'placeSettlement', vertex: vv } });
  assert.equal(l2.clients[0].last('room').undo, null);
  off.handle(l2.clients[0], { t: 'undo' });
  assert.match(l2.clients[0].last('error').message, /nothing to undo/i);
});


test('chat: messages reach every seat, history is replayed on rejoin, and bad input is rejected', () => {
  const rm = manager();
  const { code, clients } = lobbyWith(rm, 2, 1);
  const [host, guest] = clients;
  assert.deepEqual(guest.last('chatHistory').messages, []);
  const outsider = fakeClient();
  rm.handle(outsider, { t: 'chat', text: 'hi' });
  assert.match(outsider.last('error').message, /not in a room/);
  rm.handle(host, { t: 'chat', text: '   ' });
  assert.match(host.last('error').message, /type a message/i);
  rm.handle(host, { t: 'chat', text: 'x'.repeat(281) });
  assert.match(host.last('error').message, /280/);
  rm.handle(host, { t: 'chat', text: '  Anyone\u0007 have   ore?  ' });
  const m = guest.last('chat').message;
  assert.equal(m.text, 'Anyone have ore?');
  assert.equal(m.seat, 0);
  assert.equal(m.name, 'Host');
  assert.equal(host.last('chat').message.id, m.id);
  rm.handle(guest, { t: 'chat', text: 'Nope, sorry' });
  assert.equal(host.last('chat').message.text, 'Nope, sorry');
  // Chat keeps working once the game is on, and a reconnecting player gets the history.
  startGame(rm, clients);
  rm.handle(guest, { t: 'chat', text: 'gl hf' });
  assert.equal(host.last('chat').message.text, 'gl hf');
  const token = guest.last('session').token;
  rm.disconnect(guest);
  const back = fakeClient();
  rm.handle(back, { t: 'rejoin', room: code, token });
  assert.deepEqual(back.last('chatHistory').messages.map((x) => x.text), ['Anyone have ore?', 'Nope, sorry', 'gl hf']);
  // History is capped.
  for (let i = 0; i < 230; i++) rm.handle(host, { t: 'chat', text: `m${i}` });
  assert.equal(host.room.chat.length, 200);
  assert.equal(host.room.chat[0].text, 'm30');
});
