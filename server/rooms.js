import { randomBytes, randomInt } from 'node:crypto';
import { newGame, act, GameError, actingPlayers } from '../src/game.js';
import { botAction } from '../src/ai.js';
import { createRollOff, addRoll, needsRoll, pendingRollers, isComplete, rollOrder, describeRollOff } from '../src/rolloff.js';
import { makeUndoOffer, restoreFromOffer } from '../src/undo.js';
import { PLAYER_COLORS, DEFAULT_OPTIONS, RESOURCES } from '../src/constants.js';
import { redactFor } from './redact.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O to avoid confusion with 1 and 0
const CODE_LENGTH = 4;
const MAX_SEATS = 4;
const MIN_SEATS = 3;
const NAME_MAX = 16;
const CHAT_MAX_LENGTH = 280;
const CHAT_HISTORY = 200;
const COLOR_IDS = PLAYER_COLORS.map((c) => c.id);

// Actions a non-current player may take for themselves; everything else is reserved for the current player.
const SELF_ACTIONS = new Set(['discard', 'respondTrade']);

class RoomError extends Error {}

function fail(msg) {
  throw new RoomError(msg);
}

function cleanName(name, fallback) {
  const n = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '';
  return n || fallback;
}

const str = (v) => (typeof v === 'string' && v.length <= 64 ? v : undefined);
const int = (v) => (Number.isInteger(v) ? v : undefined);
const resMap = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const r of RESOURCES) if (v[r] !== undefined) out[r] = v[r];
  return out;
};

/** Build a clean action object from untrusted client input, keeping only the fields each action uses. */
export function sanitizeAction(raw) {
  if (!raw || typeof raw !== 'object') fail('Invalid action.');
  const type = str(raw.type);
  switch (type) {
    case 'placeSettlement':
    case 'buildSettlement':
    case 'buildCity':
      return { type, vertex: str(raw.vertex) };
    case 'placeRoad':
    case 'buildRoad':
      return { type, edge: str(raw.edge) };
    case 'roll':
    case 'buyDevCard':
    case 'endTurn':
    case 'cancelTrade':
    case 'skipRoadBuilding':
      return { type };
    case 'discard':
      return { type, resources: resMap(raw.resources) };
    case 'moveRobber':
      return { type, hex: int(raw.hex) };
    case 'steal':
      return { type, victim: int(raw.victim) };
    case 'playDevCard':
      return {
        type,
        card: str(raw.card),
        resources: Array.isArray(raw.resources) ? raw.resources.slice(0, 2).map(str) : undefined,
        resource: str(raw.resource),
      };
    case 'bankTrade':
      return { type, give: str(raw.give), get: str(raw.get) };
    case 'proposeTrade':
      return { type, offer: resMap(raw.offer), request: resMap(raw.request) };
    case 'respondTrade':
      return { type, accept: raw.accept === true };
    case 'acceptTrade':
      return { type, partner: int(raw.partner) };
    default:
      return fail('Unknown action.');
  }
}

/** Validate lobby options sent by the host; unknown keys are dropped and bad values fall back to defaults. */
export function sanitizeOptions(raw, current = DEFAULT_OPTIONS) {
  const o = { ...current };
  if (!raw || typeof raw !== 'object') return o;
  if (raw.boardLayout === 'random' || raw.boardLayout === 'beginner') o.boardLayout = raw.boardLayout;
  for (const k of ['randomHarbors', 'balancedNumbers', 'friendlyRobber', 'undo']) if (typeof raw[k] === 'boolean') o[k] = raw[k];
  if ([8, 10, 12, 15].includes(raw.targetVP)) o.targetVP = raw.targetVP;
  if ([7, 9].includes(raw.discardLimit)) o.discardLimit = raw.discardLimit;
  return o;
}

function lobbyOptions() {
  const { boardLayout, randomHarbors, balancedNumbers, friendlyRobber, targetVP, discardLimit, undo } = DEFAULT_OPTIONS;
  return { boardLayout, randomHarbors, balancedNumbers, friendlyRobber, targetVP, discardLimit, undo };
}

/**
 * Holds every room in memory and implements the multiplayer protocol.
 * A "client" is any object with a `send(message)` method; the WebSocket layer wraps sockets in one.
 */
export class RoomManager {
  constructor({ schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t), botDelay = 700, maxRooms = 1000, roomTtlMs = 3 * 60 * 60 * 1000, now = () => Date.now(), log = () => {}, roll = () => randomInt(1, 7) } = {}) {
    this.rooms = new Map();
    this.roll = roll; // (seatIndex) => 1..6, injectable for tests
    this.schedule = schedule;
    this.cancel = cancel;
    this.botDelay = botDelay;
    this.maxRooms = maxRooms;
    this.roomTtlMs = roomTtlMs;
    this.now = now;
    this.log = log;
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  /** Handle one parsed message from a client. Errors are reported back to that client only. */
  handle(client, msg) {
    try {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') fail('Bad message.');
      switch (msg.t) {
        case 'create':
          return this.create(client, msg);
        case 'join':
          return this.join(client, msg);
        case 'rejoin':
          return this.rejoin(client, msg);
        case 'leave':
          return this.leave(client);
        case 'setColor':
          return this.setColor(client, msg);
        case 'setName':
          return this.setName(client, msg);
        case 'setOptions':
          return this.setOptions(client, msg);
        case 'addBot':
          return this.addBot(client);
        case 'removeSeat':
          return this.removeSeat(client, msg);
        case 'start':
          return this.start(client);
        case 'rollDie':
          return this.rollDie(client);
        case 'cancelRollOff':
          return this.cancelRollOff(client);
        case 'action':
          return this.action(client, msg);
        case 'undo':
          return this.undo(client);
        case 'dismissUndo':
          return this.dismissUndo(client);
        case 'replaceWithBot':
          return this.replaceWithBot(client, msg);
        case 'restart':
          return this.restart(client);
        case 'chat':
          return this.chat(client, msg);
        case 'ping':
          return client.send({ t: 'pong' });
        default:
          fail('Unknown message.');
      }
    } catch (e) {
      if (e instanceof RoomError || e instanceof GameError) client.send({ t: 'error', message: e.message });
      else {
        this.log('Unexpected error', e);
        client.send({ t: 'error', message: 'Server error.' });
      }
    }
    return undefined;
  }

  /** A client's connection closed. Its seat is kept so the player can reconnect. */
  disconnect(client) {
    const room = client.room;
    if (!room) return;
    client.seat.clients.delete(client);
    client.room = null;
    client.seat = null;
    room.lastActivity = this.now();
    this.broadcast(room);
  }

  /** Remove rooms nobody has been connected to for a while. */
  sweep() {
    const cutoff = this.now() - this.roomTtlMs;
    for (const [code, room] of this.rooms) {
      if (this.connectedHumans(room).length === 0 && room.lastActivity < cutoff) this.deleteRoom(code);
    }
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  create(client, msg) {
    this.detach(client);
    if (this.rooms.size >= this.maxRooms) fail('The server is full. Try again later.');
    const code = this.newCode();
    const room = { code, phase: 'lobby', seats: [], host: null, options: lobbyOptions(), state: null, rolloff: null, undo: null, undoTimer: null, chat: [], chatId: 0, seq: 0, botTimer: null, lastActivity: this.now() };
    this.rooms.set(code, room);
    const seat = this.addSeat(room, { name: cleanName(msg.name, 'Player 1'), isBot: false });
    room.host = seat;
    this.attach(client, room, seat);
    this.log(`room ${code} created`);
    this.broadcast(room);
  }

  join(client, msg) {
    const room = this.findRoom(msg.room);
    if (room.phase === 'rolloff') fail('That game is just starting; ask the host to go back to the lobby.');
    if (room.phase !== 'lobby') fail('That game has already started.');
    if (room.seats.length >= MAX_SEATS) fail('That game is full.');
    this.detach(client);
    const seat = this.addSeat(room, { name: cleanName(msg.name, `Player ${room.seats.length + 1}`), isBot: false });
    this.attach(client, room, seat);
    this.broadcast(room);
  }

  rejoin(client, msg) {
    const room = typeof msg.room === 'string' ? this.rooms.get(msg.room.toUpperCase()) : null;
    const seat = room && typeof msg.token === 'string' ? room.seats.find((s) => s.token === msg.token) : null;
    if (!seat) {
      client.send({ t: 'rejoinFailed', message: 'That game is no longer available.' });
      return;
    }
    this.detach(client);
    if (seat.replacedByBot) {
      seat.isBot = false;
      seat.replacedByBot = false;
      if (room.state) {
        const idx = room.seats.indexOf(seat);
        room.state = structuredClone(room.state);
        room.state.players[idx].isBot = false;
        room.state.log.push({ turn: room.state.turn.number, player: idx, text: `${seat.name} is back and takes over from the bot.` });
        room.seq += 1;
      }
    }
    this.attach(client, room, seat);
    this.broadcast(room);
  }

  leave(client) {
    const room = client.room;
    if (!room) return;
    const seat = client.seat;
    this.detach(client);
    if ((room.phase === 'lobby' || room.phase === 'rolloff') && seat.clients.size === 0) {
      if (room.phase === 'rolloff') this.backToLobby(room); // the table changed; roll again from the lobby
      room.seats.splice(room.seats.indexOf(seat), 1);
      if (room.host === seat) room.host = room.seats.find((s) => !s.isBot) || null;
      if (!room.seats.some((s) => !s.isBot)) {
        this.deleteRoom(room.code);
        return;
      }
    }
    this.broadcast(room);
  }

  setColor(client, msg) {
    const { room, seat } = this.lobbyContext(client);
    if (!COLOR_IDS.includes(msg.color)) fail('Unknown color.');
    const other = room.seats.find((s) => s !== seat && s.color === msg.color);
    if (other) other.color = seat.color; // swap with whoever had it
    seat.color = msg.color;
    this.broadcast(room);
  }

  setName(client, msg) {
    const { room, seat } = this.lobbyContext(client);
    seat.name = cleanName(msg.name, seat.name);
    this.broadcast(room);
  }

  setOptions(client, msg) {
    const { room } = this.lobbyContext(client, { host: true });
    room.options = sanitizeOptions(msg.options, room.options);
    this.broadcast(room);
  }

  addBot(client) {
    const { room } = this.lobbyContext(client, { host: true });
    if (room.seats.length >= MAX_SEATS) fail('All seats are taken.');
    const n = room.seats.filter((s) => s.isBot).length + 1;
    this.addSeat(room, { name: `Bot ${n}`, isBot: true });
    this.broadcast(room);
  }

  removeSeat(client, msg) {
    const { room, seat } = this.lobbyContext(client, { host: true });
    const target = room.seats[int(msg.seat)];
    if (!target) fail('No such seat.');
    if (target === seat) fail('Use Leave to leave the room.');
    for (const c of target.clients) {
      c.room = null;
      c.seat = null;
      c.send({ t: 'kicked', message: 'The host removed you from the game.' });
    }
    target.clients.clear();
    room.seats.splice(room.seats.indexOf(target), 1);
    this.broadcast(room);
  }

  /** The host starts: everyone rolls a die for the starting position before the board appears. */
  start(client) {
    const { room } = this.lobbyContext(client, { host: true });
    if (room.seats.length < MIN_SEATS) fail(`You need at least ${MIN_SEATS} players. Add bots to fill the empty seats.`);
    room.phase = 'rolloff';
    room.rolloff = createRollOff(room.seats.length);
    room.seq += 1;
    this.broadcast(room);
    this.scheduleRollOffBots(room);
  }

  rollDie(client) {
    const room = client.room;
    if (!room || room.phase !== 'rolloff') fail('There is no roll-off going on.');
    const idx = room.seats.indexOf(client.seat);
    if (!needsRoll(room.rolloff, idx)) fail('You have already rolled. Wait for the others.');
    this.recordRoll(room, idx, this.roll(idx));
  }

  cancelRollOff(client) {
    const room = client.room;
    if (!room || room.phase !== 'rolloff') fail('There is no roll-off going on.');
    if (!this.isHost(room, client.seat)) fail('Only the host can go back to the lobby.');
    this.backToLobby(room);
    this.broadcast(room);
  }

  backToLobby(room) {
    if (room.botTimer) this.cancel(room.botTimer);
    room.botTimer = null;
    this.clearUndo(room);
    room.phase = 'lobby';
    room.rolloff = null;
    room.state = null;
    room.seq += 1;
  }

  recordRoll(room, idx, value) {
    room.rolloff = addRoll(room.rolloff, idx, value);
    room.lastActivity = this.now();
    if (isComplete(room.rolloff)) {
      this.beginGame(room);
      return;
    }
    this.broadcast(room);
    this.scheduleRollOffBots(room);
  }

  scheduleRollOffBots(room) {
    if (room.botTimer || room.phase !== 'rolloff') return;
    const bot = pendingRollers(room.rolloff).find((idx) => room.seats[idx].isBot);
    if (bot === undefined) return;
    room.botTimer = this.schedule(() => {
      room.botTimer = null;
      if (!this.rooms.has(room.code) || room.phase !== 'rolloff' || !needsRoll(room.rolloff, bot)) return;
      this.recordRoll(room, bot, this.roll(bot));
    }, this.botDelay);
  }

  beginGame(room) {
    const order = rollOrder(room.rolloff);
    room.state = newGame({
      ...room.options,
      playerCount: room.seats.length,
      passDevice: false,
      seed: null,
      turnOrder: order,
      players: room.seats.map((s) => ({ name: s.name, color: s.color, isBot: s.isBot })),
    });
    room.state.log.unshift({ turn: 0, player: order[0], text: describeRollOff(room.seats.map((s) => s.name), room.rolloff) });
    room.phase = 'game';
    room.rolloff = null;
    room.seq += 1;
    this.log(`room ${room.code} started with ${room.seats.length} players`);
    this.broadcast(room);
    this.scheduleBots(room);
  }

  restart(client) {
    const room = client.room;
    if (!room || room.phase !== 'game') fail('No game to restart.');
    if (room.state.phase !== 'ended') fail('The game is still in progress.');
    if (!this.isHost(room, client.seat)) fail('Only the host can start a new game.');
    room.phase = 'lobby';
    room.state = null;
    room.seq += 1;
    this.broadcast(room);
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  /** A chat line from a seated player, kept for the life of the room and sent to everyone at the table. */
  chat(client, msg) {
    const room = client.room;
    if (!room) fail('You are not in a room.');
    const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
    if (!text) fail('Type a message first.');
    if (text.length > CHAT_MAX_LENGTH) fail(`Messages can be up to ${CHAT_MAX_LENGTH} characters.`);
    const seat = client.seat;
    const message = { id: ++room.chatId, seat: room.seats.indexOf(seat), name: seat.name, text, at: this.now() };
    room.chat.push(message);
    if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
    room.lastActivity = this.now();
    for (const s of room.seats) for (const c of s.clients) c.send({ t: 'chat', message });
  }

  // -------------------------------------------------------------------------
  // Game
  // -------------------------------------------------------------------------

  action(client, msg) {
    const room = client.room;
    if (!room || room.phase !== 'game') fail('No game in progress.');
    const seatIdx = room.seats.indexOf(client.seat);
    const action = sanitizeAction(msg.action);
    const state = room.state;
    // The game holds while someone else may still undo.
    const hold = this.activeUndo(room);
    if (hold && hold.player !== seatIdx) fail(`${room.seats[hold.player].name} can still undo for a moment. Please wait.`);
    if (SELF_ACTIONS.has(action.type)) action.player = seatIdx;
    else if (state.turn.player !== seatIdx) fail("It's not your turn.");
    this.apply(room, action, seatIdx);
  }

  replaceWithBot(client, msg) {
    const room = client.room;
    if (!room || room.phase !== 'game') fail('No game in progress.');
    const idx = int(msg.seat);
    const target = room.seats[idx];
    if (!target || target.isBot) fail('That seat is not a human player.');
    if (target.clients.size > 0) fail('That player is still connected.');
    target.isBot = true;
    target.replacedByBot = true;
    room.state = structuredClone(room.state);
    room.state.players[idx].isBot = true;
    room.state.log.push({ turn: room.state.turn.number, player: idx, text: `A bot takes over for ${target.name}.` });
    room.seq += 1;
    this.broadcast(room);
    this.scheduleBots(room);
  }

  /** Apply an action; `by` is the seat of the human who sent it (null for bots), which decides whether an undo is offered. */
  apply(room, action, by = null) {
    const prev = room.state;
    room.state = act(prev, action);
    room.seq += 1;
    room.lastActivity = this.now();
    const offer = room.options.undo ? makeUndoOffer(prev, room.state, action.type, by, this.now()) : null;
    this.clearUndo(room);
    if (offer) {
      room.undo = { ...offer, seq: room.seq };
      // When the window closes untouched, tell everyone so the hold lifts and a face-down card turns over.
      room.undoTimer = this.schedule(() => {
        room.undoTimer = null;
        if (!this.rooms.has(room.code) || !room.undo || room.undo.seq !== room.seq) return;
        room.undo = null;
        room.seq += 1; // the players' views change (a face-down card turns over), so clients must re-read the state
        this.broadcast(room);
        this.scheduleBots(room);
      }, offer.until - this.now() + 10);
    }
    if (room.state.phase === 'ended') this.log(`room ${room.code} finished`);
    this.broadcast(room);
    this.scheduleBots(room);
  }

  clearUndo(room) {
    if (room.undoTimer) this.cancel(room.undoTimer);
    room.undoTimer = null;
    room.undo = null;
  }

  /** The open undo offer, if it is still valid for the current state and has not expired. */
  activeUndo(room) {
    const u = room.undo;
    if (!u || u.seq !== room.seq || this.now() > u.until) return null;
    return u;
  }

  undo(client) {
    const room = client.room;
    if (!room || room.phase !== 'game') fail('No game in progress.');
    const u = this.activeUndo(room);
    const idx = room.seats.indexOf(client.seat);
    if (!u || u.player !== idx) fail('Nothing to undo.');
    room.state = restoreFromOffer(u, client.seat.name);
    this.clearUndo(room);
    room.seq += 1;
    room.lastActivity = this.now();
    this.broadcast(room);
    this.scheduleBots(room);
  }

  /** The actor keeps the move and releases the hold early. */
  dismissUndo(client) {
    const room = client.room;
    if (!room || room.phase !== 'game') fail('No game in progress.');
    const u = this.activeUndo(room);
    const idx = room.seats.indexOf(client.seat);
    if (!u || u.player !== idx) return; // nothing to release; not an error worth reporting
    this.clearUndo(room);
    room.seq += 1;
    this.broadcast(room);
    this.scheduleBots(room);
  }

  scheduleBots(room) {
    if (room.botTimer || room.phase !== 'game' || room.state.phase === 'ended') return;
    const bot = this.nextBot(room);
    if (bot === null) return;
    // While a human may still undo, bots hold off so the undo stays possible.
    const u = this.activeUndo(room);
    const delay = u ? u.until - this.now() + 50 : room.state.phase === 'setup' ? Math.round(this.botDelay * 0.7) : this.botDelay;
    room.botTimer = this.schedule(() => {
      room.botTimer = null;
      if (!this.rooms.has(room.code) || room.phase !== 'game') return;
      if (this.activeUndo(room)) {
        this.scheduleBots(room); // the window was renewed by another human action; wait again
        return;
      }
      this.runBot(room);
    }, delay);
  }

  nextBot(room) {
    const state = room.state;
    for (const pid of actingPlayers(state)) {
      if (state.players[pid].isBot && botAction(state, pid)) return pid;
    }
    return null;
  }

  runBot(room) {
    const pid = this.nextBot(room);
    if (pid === null) return;
    const action = botAction(room.state, pid);
    try {
      this.apply(room, action);
    } catch (e) {
      this.log(`bot action failed in room ${room.code}`, action, e.message);
      const s = room.state;
      // Recover rather than stalling the table.
      if (s.turn.player === pid && s.turn.rolled && !s.pending) this.apply(room, { type: 'endTurn' });
      else if (s.pending && s.pending.type === 'roadBuilding' && s.turn.player === pid) this.apply(room, { type: 'skipRoadBuilding' });
    }
  }

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  /** Send every connected player their own view of the room. */
  broadcast(room) {
    const u = room.phase === 'game' ? this.activeUndo(room) : null;
    const faceDownCardOf = u && u.label === 'card purchase' ? u.player : null;
    room.seats.forEach((seat, idx) => {
      if (seat.clients.size === 0) return;
      const msg = {
        t: 'room',
        room: this.publicRoom(room, idx),
        seq: room.seq,
        state: room.state ? redactFor(room.state, idx, { faceDownCardOf }) : null,
        undo: u ? { player: u.player, label: u.label, remainingMs: u.until - this.now() } : null,
      };
      for (const c of seat.clients) c.send(msg);
    });
  }

  publicRoom(room, you) {
    return {
      code: room.code,
      phase: room.phase,
      you,
      host: room.seats.indexOf(this.effectiveHost(room)),
      options: room.options,
      seats: room.seats.map((s) => ({ name: s.name, color: s.color, isBot: s.isBot, connected: s.isBot || s.clients.size > 0, replacedByBot: !!s.replacedByBot })),
      rolloff: room.rolloff ? { rolls: room.rolloff, pending: pendingRollers(room.rolloff) } : null,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  newCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return fail('Could not allocate a room code.');
  }

  findRoom(code) {
    const room = typeof code === 'string' ? this.rooms.get(code.trim().toUpperCase()) : null;
    if (!room) fail('No game with that code.');
    return room;
  }

  addSeat(room, { name, isBot }) {
    const used = new Set(room.seats.map((s) => s.color));
    const color = COLOR_IDS.find((c) => !used.has(c));
    const seat = { name, color, isBot, token: isBot ? null : randomBytes(18).toString('base64url'), clients: new Set(), replacedByBot: false };
    room.seats.push(seat);
    room.lastActivity = this.now();
    return seat;
  }

  attach(client, room, seat) {
    client.room = room;
    client.seat = seat;
    seat.clients.add(client);
    room.lastActivity = this.now();
    client.send({ t: 'session', room: room.code, token: seat.token });
    client.send({ t: 'chatHistory', messages: room.chat });
  }

  /** Disconnect a client from its current room without notifying it (used before joining another). */
  detach(client) {
    if (client.room) this.disconnect(client);
  }

  connectedHumans(room) {
    return room.seats.filter((s) => !s.isBot && s.clients.size > 0);
  }

  /** The host, or the first connected human if the host is away, so a table never gets stuck. */
  effectiveHost(room) {
    if (room.host && room.host.clients.size > 0) return room.host;
    return this.connectedHumans(room)[0] || room.host;
  }

  isHost(room, seat) {
    return this.effectiveHost(room) === seat;
  }

  lobbyContext(client, { host = false } = {}) {
    const room = client.room;
    if (!room) fail('You are not in a room.');
    if (room.phase !== 'lobby') fail('The game has already started.');
    if (host && !this.isHost(room, client.seat)) fail('Only the host can do that.');
    return { room, seat: client.seat };
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.botTimer) this.cancel(room.botTimer);
    this.clearUndo(room);
    this.rooms.delete(code);
    this.log(`room ${code} closed`);
  }
}
