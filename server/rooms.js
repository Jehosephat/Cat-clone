import { randomBytes, randomInt } from 'node:crypto';
import { newGame, act, GameError, actingPlayers } from '../src/game.js';
import { botAction } from '../src/ai.js';
import { PLAYER_COLORS, DEFAULT_OPTIONS, RESOURCES } from '../src/constants.js';
import { redactFor } from './redact.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O to avoid confusion with 1 and 0
const CODE_LENGTH = 4;
const MAX_SEATS = 4;
const MIN_SEATS = 3;
const NAME_MAX = 16;
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
  for (const k of ['randomHarbors', 'balancedNumbers', 'friendlyRobber']) if (typeof raw[k] === 'boolean') o[k] = raw[k];
  if ([8, 10, 12, 15].includes(raw.targetVP)) o.targetVP = raw.targetVP;
  if ([7, 9].includes(raw.discardLimit)) o.discardLimit = raw.discardLimit;
  return o;
}

function lobbyOptions() {
  const { boardLayout, randomHarbors, balancedNumbers, friendlyRobber, targetVP, discardLimit } = DEFAULT_OPTIONS;
  return { boardLayout, randomHarbors, balancedNumbers, friendlyRobber, targetVP, discardLimit };
}

/**
 * Holds every room in memory and implements the multiplayer protocol.
 * A "client" is any object with a `send(message)` method; the WebSocket layer wraps sockets in one.
 */
export class RoomManager {
  constructor({ schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t), botDelay = 700, maxRooms = 1000, roomTtlMs = 3 * 60 * 60 * 1000, now = () => Date.now(), log = () => {} } = {}) {
    this.rooms = new Map();
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
        case 'action':
          return this.action(client, msg);
        case 'replaceWithBot':
          return this.replaceWithBot(client, msg);
        case 'restart':
          return this.restart(client);
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
    const room = { code, phase: 'lobby', seats: [], host: null, options: lobbyOptions(), state: null, seq: 0, botTimer: null, lastActivity: this.now() };
    this.rooms.set(code, room);
    const seat = this.addSeat(room, { name: cleanName(msg.name, 'Player 1'), isBot: false });
    room.host = seat;
    this.attach(client, room, seat);
    this.log(`room ${code} created`);
    this.broadcast(room);
  }

  join(client, msg) {
    const room = this.findRoom(msg.room);
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
    if (room.phase === 'lobby' && seat.clients.size === 0) {
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

  start(client) {
    const { room } = this.lobbyContext(client, { host: true });
    if (room.seats.length < MIN_SEATS) fail(`You need at least ${MIN_SEATS} players. Add bots to fill the empty seats.`);
    room.state = newGame({
      ...room.options,
      playerCount: room.seats.length,
      passDevice: false,
      seed: null,
      players: room.seats.map((s) => ({ name: s.name, color: s.color, isBot: s.isBot })),
    });
    room.phase = 'game';
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
  // Game
  // -------------------------------------------------------------------------

  action(client, msg) {
    const room = client.room;
    if (!room || room.phase !== 'game') fail('No game in progress.');
    const seatIdx = room.seats.indexOf(client.seat);
    const action = sanitizeAction(msg.action);
    const state = room.state;
    if (SELF_ACTIONS.has(action.type)) action.player = seatIdx;
    else if (state.turn.player !== seatIdx) fail("It's not your turn.");
    this.apply(room, action);
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
    this.broadcast(room);
    this.scheduleBots(room);
  }

  apply(room, action) {
    room.state = act(room.state, action);
    room.seq += 1;
    room.lastActivity = this.now();
    if (room.state.phase === 'ended') this.log(`room ${room.code} finished`);
    this.broadcast(room);
    this.scheduleBots(room);
  }

  scheduleBots(room) {
    if (room.botTimer || room.phase !== 'game' || room.state.phase === 'ended') return;
    const bot = this.nextBot(room);
    if (bot === null) return;
    room.botTimer = this.schedule(() => {
      room.botTimer = null;
      if (!this.rooms.has(room.code) || room.phase !== 'game') return;
      this.runBot(room);
    }, room.state.phase === 'setup' ? Math.round(this.botDelay * 0.7) : this.botDelay);
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
    room.seats.forEach((seat, idx) => {
      if (seat.clients.size === 0) return;
      const msg = {
        t: 'room',
        room: this.publicRoom(room, idx),
        seq: room.seq,
        state: room.state ? redactFor(room.state, idx) : null,
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
    this.rooms.delete(code);
    this.log(`room ${code} closed`);
  }
}
