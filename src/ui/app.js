import { h, clear } from './dom.js';
import { renderBoard, colorOf } from './board-svg.js';
import {
  initModals,
  showModal,
  closeModal,
  currentModalTag,
  resourceChip,
  discardModal,
  stealModal,
  yearOfPlentyModal,
  monopolyModal,
  devCardsModal,
  tradeModal,
  gameOverModal,
  costsModal,
  rulesModal,
  colorHex,
} from './modals.js';
import {
  newGame,
  act,
  GameError,
  actingPlayers,
  canRoll,
  canBuild,
  playableDevCards,
  validRobberHexes,
  validSettlementVertices,
  validRoadEdges,
  validCityVertices,
  countVictoryPoints,
  visibleVictoryPoints,
  piecesLeft,
  turnOrderOf,
} from '../game.js';
import { botAction } from '../ai.js';
import { createRollOff, addRoll, pendingRollers, isComplete, rollOrder, describeRollOff } from '../rolloff.js';
import { createRng } from '../rng.js';
import { makeUndoOffer, restoreFromOffer } from '../undo.js';
import { ding, kaching, blip, primeAudio, soundEnabled, setSoundEnabled, stats as soundStats } from './sound.js';
import { renderGameStats } from './stats-charts.js';
import { RESOURCES, RESOURCE_ICON, RESOURCE_LABEL, PLAYER_COLORS, DEFAULT_OPTIONS, COSTS, DEV_CARD_LABEL } from '../constants.js';
import { longestRoadLength, handSize } from '../rules.js';
import { createConnection, loadSession, saveSession } from './net.js';

const SAVE_KEY = 'catan-clone-save-v1';
const SETTINGS_KEY = 'catan-clone-setup-v1';
const NAME_KEY = 'catan-online-name-v1';
const DICE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');
initModals(modalRoot);

/** 'local' (one device, pass-and-play + bots), 'online' (server-hosted room), or null (home screen). */
let mode = null;
let state = null;
let ui = { mode: null, viewer: null, botToken: 0, reviewing: false, screen: 'home' };
let net = null;
let online = freshOnline();

function freshOnline() {
  return { room: null, seq: -1, status: 'closed', wantRejoin: false, undo: null, chat: [], chatUnread: 0 };
}

const QUICK_CHAT = ['👋 Hi!', 'Anyone have ore?', 'Trade?', 'Nice move!', 'Good game!', '😄', '😱', '👍'];

/** Local-mode undo offer: {state, player, label, until, result} where `result` is the state the offer belongs to. */
let localUndo = null;
let undoTimer = null;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function save() {
  if (mode === 'local' && state) storageSet(SAVE_KEY, JSON.stringify({ state, viewer: ui.viewer }));
}

function loadSave() {
  try {
    const data = JSON.parse(storageGet(SAVE_KEY));
    if (!data || !data.state || data.state.version !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

function clearSave() {
  storageSet(SAVE_KEY, null);
}

function savedName() {
  return storageGet(NAME_KEY) || '';
}

function urlRoom() {
  const code = new URLSearchParams(location.search).get('room');
  return code && /^[A-Za-z]{4}$/.test(code) ? code.toUpperCase() : null;
}

function setUrlRoom(code) {
  const url = code ? `${location.pathname}?room=${code}` : location.pathname;
  history.replaceState(null, '', url);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast(msg, kind = 'error') {
  const el = h('div', { class: `toast toast-${kind}`, onclick: kind === 'chat' ? () => { el.remove(); toggleChat(true); } : null }, msg);
  toastRoot.append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'chat' ? 4000 : 2800);
}

function isOnline() {
  return mode === 'online';
}

function mySeat() {
  return online.room ? online.room.you : null;
}

function humans() {
  return state.players.filter((p) => !p.isBot);
}

/** Whether this device may act for player `pid`. */
function canControl(pid) {
  if (state.players[pid].isBot) return false;
  return isOnline() ? pid === mySeat() : true;
}

/** The player this device must act for right now, or null. */
function requiredActor() {
  const actors = actingPlayers(state);
  for (const pid of actors) if (canControl(pid)) return pid;
  return null;
}

function needsPass() {
  if (isOnline() || !state.options.passDevice || humans().length < 2) return false;
  const req = requiredActor();
  return req !== null && ui.viewer !== req;
}

/** Whose hand is shown on screen. */
function handOwner() {
  if (isOnline()) return mySeat();
  const req = requiredActor();
  if (req !== null) return req;
  if (!state.players[state.turn.player].isBot) return state.turn.player;
  if (ui.viewer !== null && !state.players[ui.viewer].isBot) return ui.viewer;
  return state.turn.player;
}

function isMyTurn(pid) {
  return state.turn.player === pid && canControl(pid);
}

/** Identifies "what this device should be doing"; open dialogs are closed when it changes. */
function contextKey() {
  if (!state) return '';
  return [state.phase, state.turn.number, state.turn.rolled, state.pending ? state.pending.type : '', requiredActor()].join('|');
}

function dispatch(action) {
  closeModal();
  ui.mode = null;
  if (isOnline()) {
    if (!net || !net.isOpen) {
      toast('Reconnecting… try again in a moment.');
      render();
      return false;
    }
    net.send({ t: 'action', action });
    return true;
  }
  try {
    const prev = state;
    const next = act(prev, action);
    const actor = action.player !== undefined ? action.player : prev.turn.player;
    const offer = prev.options.undo && !prev.players[actor].isBot ? makeUndoOffer(prev, next, action.type, actor, Date.now()) : null;
    localUndo = offer ? { ...offer, result: next } : null;
    setState(next);
    return true;
  } catch (e) {
    if (e instanceof GameError) toast(e.message);
    else {
      console.error(e);
      toast('Something went wrong: ' + e.message);
    }
    render();
    return false;
  }
}

function setState(next) {
  const prevKey = contextKey();
  const prevState = state;
  const prevActor = prevState ? requiredActor() : null;
  state = next;
  if (localUndo && localUndo.result !== next) localUndo = null; // any other change overtakes the offer
  // Sounds: "ka-ching" when another player's trade offer arrives for someone on this device,
  // otherwise a ding when it becomes this device's move (a turn starting, or a prompt such as a discard).
  const actor = state.phase === 'ended' ? null : requiredActor();
  if (incomingTradeOffer(prevState)) kaching();
  else if (actor !== null && actor !== prevActor) ding();
  if (prevState && prevState.turn.player !== state.turn.player) ui.mode = null;
  if (ui.mode && (state.pending || state.phase !== 'main')) ui.mode = null;
  if (prevKey !== contextKey() && currentModalTag() !== 'gameover') closeModal();
  save();
  render();
  announceEvents();
  if (!isOnline()) scheduleBots();
}

/** A trade offer from another player has just appeared, and a human on this device is asked to answer it. */
function incomingTradeOffer(prevState) {
  const t = state.pending;
  if (!t || t.type !== 'trade') return false;
  if (prevState && prevState.pending && prevState.pending.type === 'trade') return false; // same offer, e.g. a response came in
  if (isOnline()) return t.from !== mySeat() && mySeat() in t.responses;
  return Object.keys(t.responses).some((id) => !state.players[id].isBot);
}

function announceEvents() {
  const ev = state.lastEvent;
  if (!ev) return;
  if (isOnline()) {
    const me = mySeat();
    if (ev.type === 'steal' && ev.resource) {
      const what = `${RESOURCE_ICON[ev.resource]} ${RESOURCE_LABEL[ev.resource]}`;
      if (ev.thief === me) toast(`You stole ${what} from ${state.players[ev.victim].name}.`, 'info');
      else if (ev.victim === me) toast(`${state.players[ev.thief].name} stole ${what} from you.`, 'info');
    } else if (ev.type === 'devCardBought' && ev.card && ev.player === me) {
      toast(`You drew: ${DEV_CARD_LABEL[ev.card]}`, 'info');
    }
    return;
  }
  if (ev.type === 'steal' && !state.players[ev.thief].isBot && (!state.options.passDevice || humans().length < 2 || ui.viewer === ev.thief)) {
    toast(`You stole ${RESOURCE_ICON[ev.resource]} ${RESOURCE_LABEL[ev.resource]} from ${state.players[ev.victim].name}.`, 'info');
  } else if (ev.type === 'devCardBought' && !state.players[ev.player].isBot) {
    toast(`You drew: ${DEV_CARD_LABEL[ev.card]}`, 'info');
  }
}

// ---------------------------------------------------------------------------
// Local bots
// ---------------------------------------------------------------------------

function scheduleBots() {
  if (!state || state.phase === 'ended' || isOnline()) return;
  const actors = actingPlayers(state);
  const bot = actors.find((pid) => state.players[pid].isBot && botAction(state, pid));
  if (bot === undefined) return;
  const token = ++ui.botToken;
  const undoLeft = localUndo ? localUndo.until - Date.now() : 0;
  const delay = undoLeft > 0 ? undoLeft + 50 : state.phase === 'setup' ? 450 : 650; // bots wait while a human may still undo
  setTimeout(() => {
    if (token !== ui.botToken || !state || isOnline()) return;
    const a = botAction(state, bot);
    if (!a) return;
    try {
      setState(act(state, a));
    } catch (e) {
      console.error('Bot action failed', a, e);
      if (state.turn.player === bot && state.turn.rolled && !state.pending) dispatch({ type: 'endTurn' });
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Online connection
// ---------------------------------------------------------------------------

function ensureNet() {
  if (net) return;
  net = createConnection({
    onStatus(status) {
      const was = online.status;
      online.status = status;
      if (status === 'open') {
        const session = loadSession();
        if (session && (online.room || online.wantRejoin)) net.send({ t: 'rejoin', room: session.room, token: session.token });
      }
      if (was !== status && mode === 'online') render();
    },
    onMessage: onNetMessage,
  });
}

function onNetMessage(msg) {
  if (mode !== 'online') return;
  switch (msg.t) {
    case 'session':
      saveSession({ room: msg.room, token: msg.token });
      setUrlRoom(msg.room);
      break;
    case 'room':
      handleRoom(msg);
      break;
    case 'error':
      toast(msg.message);
      if (online.room) render();
      else leaveOnline({ notify: false });
      break;
    case 'rejoinFailed':
    case 'kicked':
      saveSession(null);
      leaveOnline({ notify: false });
      toast(msg.message);
      break;
    case 'chatHistory':
      online.chat = Array.isArray(msg.messages) ? msg.messages : [];
      render();
      break;
    case 'chat':
      receiveChat(msg.message);
      break;
    default:
      break;
  }
}

function handleRoom(msg) {
  const prevRoom = online.room;
  online.room = msg.room;
  online.wantRejoin = false;
  online.undo = msg.undo && msg.room.phase === 'game' ? { label: msg.undo.label, until: Date.now() + msg.undo.remainingMs } : null;
  if (msg.room.phase === 'lobby' || msg.room.phase === 'rolloff') {
    if (!prevRoom || prevRoom.phase !== msg.room.phase) {
      closeModal();
      state = null;
      ui.reviewing = false;
      ui.mode = null;
    }
    online.seq = msg.seq;
    render();
    return;
  }
  if (prevRoom && prevRoom.phase !== 'game') {
    state = null; // a new game is starting
    ui.reviewing = false;
  }
  if (msg.seq !== online.seq || !state) {
    online.seq = msg.seq;
    setState(msg.state);
  } else {
    state = msg.state; // same game state, e.g. someone connected or disconnected
    render();
  }
}

function receiveChat(message) {
  if (!message) return;
  online.chat.push(message);
  if (online.chat.length > 200) online.chat.splice(0, online.chat.length - 200);
  const mine = message.seat === mySeat();
  if (!mine && !ui.chatOpen) {
    online.chatUnread += 1;
    toast(`💬 ${message.name}: ${message.text.length > 90 ? message.text.slice(0, 90) + '…' : message.text}`, 'chat');
    blip();
  }
  render();
}

function sendChat(text) {
  const t = (text || '').trim();
  if (!t) return;
  send({ t: 'chat', text: t.slice(0, 280) });
}

function toggleChat(open = !ui.chatOpen) {
  ui.chatOpen = open;
  if (open) online.chatUnread = 0;
  render();
}

function chatButton(extraClass = '') {
  const n = online.chatUnread;
  return h('button', { class: `btn chat-btn ${extraClass}`, 'aria-label': n ? `Chat, ${n} unread` : 'Chat', onclick: () => toggleChat(true) }, '💬', n ? h('span', { class: 'chat-badge' }, n > 9 ? '9+' : n) : null);
}

function renderChatDrawer() {
  const me = mySeat();
  const seats = online.room ? online.room.seats : [];
  const list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
  if (!online.chat.length) list.append(h('p', { class: 'muted small chat-empty' }, 'No messages yet. Say hi!'));
  let lastSeat = null;
  for (const m of online.chat) {
    const own = m.seat === me;
    const color = seats[m.seat] ? colorHex({ players: [{ color: seats[m.seat].color }] }, 0) : '#999';
    const row = h('div', { class: `chat-msg ${own ? 'own' : ''}` });
    if (m.seat !== lastSeat && !own) row.append(h('div', { class: 'chat-name' }, h('span', { class: 'dot', style: { background: color } }), m.name));
    row.append(h('div', { class: 'chat-bubble' }, m.text));
    list.append(row);
    lastSeat = m.seat;
  }
  const input = h('input', {
    type: 'text', class: 'name-input chat-input', placeholder: 'Message…', maxlength: 280, 'data-keep': 'chat-input', 'aria-label': 'Chat message', autocomplete: 'off', enterkeyhint: 'send',
    onkeydown: (e) => { if (e.key === 'Enter') { sendChat(input.value); input.value = ''; } },
  });
  const drawer = h('div', { class: 'chat-drawer', role: 'dialog', 'aria-label': 'Chat' },
    h('div', { class: 'chat-head' }, h('strong', {}, '💬 Chat'), h('span', { class: 'muted small' }, online.status === 'open' ? '' : 'reconnecting…'), h('button', { class: 'btn small', 'aria-label': 'Close chat', onclick: () => toggleChat(false) }, '✕')),
    list,
    h('div', { class: 'chat-quick' }, QUICK_CHAT.map((q) => h('button', { class: 'chip', onclick: () => sendChat(q) }, q))),
    h('div', { class: 'chat-compose' }, input, h('button', { class: 'btn btn-primary', 'aria-label': 'Send', onclick: () => { sendChat(input.value); input.value = ''; input.focus(); } }, 'Send')),
  );
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  return drawer;
}

function startOnline(firstMessage) {
  mode = 'online';
  online = freshOnline();
  state = null;
  ensureNet();
  if (firstMessage) net.send(firstMessage);
  else online.wantRejoin = true;
  render();
}

function leaveOnline({ notify = true } = {}) {
  if (net) {
    if (notify) net.send({ t: 'leave' });
    const n = net;
    net = null;
    setTimeout(() => n.close(), notify ? 150 : 0);
  }
  if (notify) saveSession(null);
  mode = null;
  state = null;
  online = freshOnline();
  ui = { mode: null, viewer: null, botToken: ui.botToken + 1, reviewing: false, screen: 'home' };
  closeModal();
  setUrlRoom(null);
  render();
}

function send(msg) {
  if (net) net.send(msg);
}

// ---------------------------------------------------------------------------
// Shared form helpers
// ---------------------------------------------------------------------------

function segRow(choices, value, onPick, { disabled = false, small = false } = {}) {
  return h(
    'div',
    { class: `seg ${small ? 'small' : ''}` },
    choices.map(([val, label]) => h('button', { class: `seg-btn ${value === val ? 'active' : ''}`, disabled, onclick: () => onPick(val) }, label)),
  );
}

function toggleRow(label, hint, checked, onChange, disabled = false) {
  return h('label', { class: `toggle ${disabled ? 'disabled' : ''}` },
    h('input', { type: 'checkbox', checked: !!checked, disabled, onchange: (e) => onChange(e.target.checked) }),
    h('span', { class: 'toggle-text' }, h('span', {}, label), hint ? h('span', { class: 'muted small' }, hint) : null),
  );
}

/** Board and rule options shared by the local setup screen and the online lobby. */
function optionControls(opts, onChange, { readOnly = false } = {}) {
  const set = (patch) => onChange({ ...opts, ...patch });
  const beginner = opts.boardLayout === 'beginner';
  return [
    h('h2', {}, 'Board'),
    segRow([['random', 'Variable setup'], ['beginner', 'Beginner layout']], opts.boardLayout, (v) => set({ boardLayout: v }), { disabled: readOnly }),
    toggleRow('Shuffle harbors', 'Randomize harbor types around the coast', opts.randomHarbors, (v) => set({ randomHarbors: v }), readOnly || beginner),
    toggleRow('Balanced numbers', 'Never place 6 and 8 tokens next to each other', opts.balancedNumbers, (v) => set({ balancedNumbers: v }), readOnly || beginner),
    h('h2', {}, 'Rules'),
    h('div', { class: 'field' }, h('span', {}, 'Victory points to win'), segRow([8, 10, 12, 15].map((n) => [n, String(n)]), opts.targetVP, (v) => set({ targetVP: v }), { disabled: readOnly })),
    h('div', { class: 'field' }, h('span', {}, 'Discard when holding more than'), segRow([[7, '7 cards'], [9, '9 cards']], opts.discardLimit, (v) => set({ discardLimit: v }), { disabled: readOnly })),
    toggleRow('Friendly robber', 'The robber cannot be placed next to players with 2 or fewer points', opts.friendlyRobber, (v) => set({ friendlyRobber: v }), readOnly),
    toggleRow('Undo window', 'After most actions, offer a 4-second undo. Trades, dice rolls, card purchases and steals cannot be undone.', opts.undo, (v) => set({ undo: v }), readOnly),
  ];
}

/** Re-render while keeping focus and caret in a text field tagged with data-keep. */
function preservingFocus(build) {
  const active = document.activeElement;
  const keep = active && active.dataset ? active.dataset.keep : null;
  const value = keep ? active.value : null;
  const sel = keep ? [active.selectionStart, active.selectionEnd] : null;
  build();
  if (!keep) return;
  const el = app.querySelector(`[data-keep="${keep}"]`);
  if (!el) return;
  el.value = value;
  el.focus();
  try {
    el.setSelectionRange(sel[0], sel[1]);
  } catch {
    /* not a text input */
  }
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

function renderHome() {
  const form = h('div', { class: 'setup-card' });
  const linkRoom = urlRoom();
  const session = loadSession();
  const saved = loadSave();

  form.append(h('h1', { class: 'title' }, '🏝️ Settlers'), h('p', { class: 'subtitle' }, 'Build, trade and settle the island with friends.'));

  if (session) {
    form.append(
      h('div', { class: 'resume-box' },
        h('div', {}, h('strong', {}, 'Online game in progress'), h('div', { class: 'muted small' }, `Room ${session.room}`)),
        h('button', { class: 'btn btn-primary', onclick: () => startOnline(null) }, 'Rejoin'),
      ),
    );
  }

  const nameInput = h('input', {
    type: 'text', class: 'name-input', maxlength: 16, placeholder: 'Your name', value: savedName(), 'data-keep': 'name', 'aria-label': 'Your name', autocomplete: 'nickname',
    oninput: (e) => storageSet(NAME_KEY, e.target.value.trim()),
  });
  const codeInput = h('input', {
    type: 'text', class: 'name-input code-input', maxlength: 4, placeholder: 'CODE', value: linkRoom || '', 'data-keep': 'code', 'aria-label': 'Room code', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
    oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); },
    onkeydown: (e) => { if (e.key === 'Enter') join(); },
  });
  const name = () => nameInput.value.trim();
  const create = () => {
    if (!name()) {
      toast('Enter your name first.');
      nameInput.focus();
      return;
    }
    startOnline({ t: 'create', name: name() });
  };
  const join = () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!name()) {
      toast('Enter your name first.');
      nameInput.focus();
      return;
    }
    if (!/^[A-Z]{4}$/.test(code)) {
      toast('Enter the 4-letter room code.');
      codeInput.focus();
      return;
    }
    saveSession(null);
    startOnline({ t: 'join', room: code, name: name() });
  };

  form.append(
    h('h2', {}, 'Play online'),
    h('div', { class: 'field-stack' }, h('label', { class: 'muted small' }, 'Your name'), nameInput),
    h('div', { class: 'online-actions' },
      h('button', { class: `btn ${linkRoom ? '' : 'btn-primary'} btn-large`, onclick: create }, 'Create a game'),
      h('div', { class: 'join-row' }, codeInput, h('button', { class: `btn ${linkRoom ? 'btn-primary' : ''} btn-large`, onclick: join }, 'Join')),
    ),
    h('p', { class: 'muted small' }, 'Create a game and share the 4-letter code or link. Everyone plays from their own phone or computer.'),
    h('h2', {}, 'Play on this device'),
    h('p', { class: 'muted small' }, 'Pass-and-play between people sharing one device, or play against bots. No connection needed.'),
    h('div', { class: 'setup-actions' },
      h('button', { class: 'btn', onclick: () => { ui.screen = 'local'; render(); } }, 'Set up local game'),
      saved && saved.state.phase !== 'ended' ? h('button', { class: 'btn', onclick: () => resumeLocal(saved) }, 'Resume local game') : null,
      h('button', { class: 'btn', onclick: rulesModal }, 'Rules'),
    ),
  );
  return h('div', { class: 'setup-screen' }, form);
}

function renderConnecting() {
  const session = loadSession();
  const label = online.wantRejoin && session ? `Reconnecting to room ${session.room}…` : 'Connecting…';
  return h('div', { class: 'setup-screen' },
    h('div', { class: 'setup-card center' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', {}, label),
      h('button', { class: 'btn', onclick: () => { saveSession(null); leaveOnline({ notify: false }); } }, 'Cancel'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Online lobby
// ---------------------------------------------------------------------------

function shareLink() {
  return `${location.origin}${location.pathname}?room=${online.room.code}`;
}

async function copyLink() {
  const link = shareLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied.', 'info');
  } catch {
    showModal({ title: 'Invite link', body: h('input', { class: 'name-input', value: link, readonly: true, onfocus: (e) => e.target.select() }), actions: [{ label: 'Close', onClick: closeModal }] });
  }
}

function renderLobby() {
  const room = online.room;
  const me = room.you;
  const isHost = room.host === me;
  const form = h('div', { class: 'setup-card' });

  form.append(
    h('div', { class: 'lobby-head' },
      h('div', {}, h('div', { class: 'muted small' }, 'Room code'), h('div', { class: 'room-code' }, room.code)),
      h('div', { class: 'lobby-share' },
        chatButton(),
        h('button', { class: 'btn', onclick: copyLink }, '🔗 Copy link'),
        navigator.share ? h('button', { class: 'btn', onclick: () => navigator.share({ title: 'Join my Settlers game', text: `Join my game with code ${room.code}`, url: shareLink() }).catch(() => {}) }, 'Share') : null,
      ),
    ),
  );
  if (online.status !== 'open') form.append(h('div', { class: 'conn-inline' }, 'Reconnecting…'));

  form.append(h('h2', {}, `Players (${room.seats.length}/4)`));
  const list = h('div', { class: 'player-list' });
  room.seats.forEach((s, idx) => {
    const color = PLAYER_COLORS.find((c) => c.id === s.color);
    const tags = [];
    if (idx === me) tags.push(h('span', { class: 'pill' }, 'you'));
    if (idx === room.host) tags.push(h('span', { class: 'pill' }, 'host'));
    if (s.isBot) tags.push(h('span', { class: 'pill' }, s.replacedByBot ? '🤖 stand-in' : '🤖 bot'));
    if (!s.connected) tags.push(h('span', { class: 'pill warn' }, 'offline'));
    list.append(
      h('div', { class: 'player-row' },
        h('span', { class: 'dot big', style: { background: color ? color.hex : '#999' } }),
        idx === me
          ? h('input', { type: 'text', class: 'name-input', value: s.name, maxlength: 16, 'data-keep': 'lobby-name', 'aria-label': 'Your name', onchange: (e) => { storageSet(NAME_KEY, e.target.value.trim()); send({ t: 'setName', name: e.target.value }); } })
          : h('span', { class: 'seat-name' }, s.name),
        h('span', { class: 'seat-tags' }, tags),
        idx === me
          ? h('select', { class: 'color-select', 'aria-label': 'Your color', onchange: (e) => send({ t: 'setColor', color: e.target.value }) },
              PLAYER_COLORS.map((c) => h('option', { value: c.id, selected: s.color === c.id }, c.label)))
          : null,
        isHost && idx !== me ? h('button', { class: 'btn small', 'aria-label': `Remove ${s.name}`, onclick: () => send({ t: 'removeSeat', seat: idx }) }, '✕') : null,
      ),
    );
  });
  for (let i = room.seats.length; i < 4; i++) {
    list.append(h('div', { class: 'player-row empty-seat' }, h('span', { class: 'dot big' }), h('span', { class: 'muted' }, 'Open seat')));
  }
  form.append(list);
  if (isHost && room.seats.length < 4) form.append(h('div', { class: 'setup-actions' }, h('button', { class: 'btn', onclick: () => send({ t: 'addBot' }) }, '🤖 Add bot')));
  form.append(h('p', { class: 'muted small' }, 'Games need 3 or 4 players. Fill empty seats with bots if you are short.'));

  form.append(...optionControls(room.options, (opts) => send({ t: 'setOptions', options: opts }), { readOnly: !isHost }));
  if (!isHost) form.append(h('p', { class: 'muted small' }, 'Only the host can change the options.'));

  const canStart = room.seats.length >= 3;
  form.append(
    h('div', { class: 'setup-actions' },
      isHost
        ? h('button', { class: 'btn btn-primary btn-large', disabled: !canStart, onclick: () => send({ t: 'start' }) }, canStart ? 'Start game' : 'Need 3 players')
        : h('div', { class: 'waiting' }, 'Waiting for the host to start…'),
      h('button', { class: 'btn', onclick: () => leaveOnline() }, 'Leave'),
    ),
  );
  return h('div', { class: 'setup-screen' }, form);
}

// ---------------------------------------------------------------------------
// Local setup screen
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = storageGet(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_OPTIONS, players: defaultPlayers(), ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_OPTIONS, players: defaultPlayers() };
}

function defaultPlayers() {
  return [
    { name: 'Player 1', color: 'red', isBot: false },
    { name: 'Player 2', color: 'blue', isBot: true },
    { name: 'Player 3', color: 'white', isBot: true },
    { name: 'Player 4', color: 'orange', isBot: true },
  ];
}

let localSettings = null;

function renderLocalSetup() {
  if (!localSettings) localSettings = loadSettings();
  const settings = localSettings;
  const form = h('div', { class: 'setup-card' });
  const rerender = () => render();

  form.append(
    h('div', { class: 'lobby-head' }, h('h1', { class: 'title small-title' }, 'Local game'), h('button', { class: 'btn', onclick: () => { ui.screen = 'home'; render(); } }, '← Back')),
    h('p', { class: 'subtitle' }, 'Everyone plays on this device. Bots can fill any seat.'),
    h('h2', {}, 'Players'),
    segRow([[3, '3 players'], [4, '4 players']], settings.playerCount, (n) => { settings.playerCount = n; rerender(); }),
  );
  const list = h('div', { class: 'player-list' });
  for (let i = 0; i < settings.playerCount; i++) {
    const pl = settings.players[i];
    list.append(
      h('div', { class: 'player-row' },
        h('span', { class: 'dot big', style: { background: PLAYER_COLORS.find((c) => c.id === pl.color).hex } }),
        h('input', { type: 'text', class: 'name-input', value: pl.name, maxlength: 14, 'data-keep': `local-name-${i}`, 'aria-label': `Player ${i + 1} name`, oninput: (e) => { pl.name = e.target.value; } }),
        h('select', { class: 'color-select', 'aria-label': `Player ${i + 1} color`, onchange: (e) => {
          const other = settings.players.find((o) => o !== pl && o.color === e.target.value);
          if (other) other.color = pl.color;
          pl.color = e.target.value;
          rerender();
        } }, PLAYER_COLORS.map((c) => h('option', { value: c.id, selected: pl.color === c.id }, c.label))),
        segRow([[false, 'Human'], [true, 'Bot']], pl.isBot, (v) => { pl.isBot = v; rerender(); }, { small: true }),
      ),
    );
  }
  form.append(list);
  form.append(...optionControls(settings, (opts) => { Object.assign(settings, opts); rerender(); }));
  form.append(toggleRow('Pass-and-play privacy', 'Show a hand-off screen between human players so hands stay hidden', settings.passDevice, (v) => { settings.passDevice = v; }));

  const seedInput = h('input', { type: 'text', class: 'name-input', placeholder: 'random', value: settings.seed ?? '', inputmode: 'numeric', 'aria-label': 'Seed', 'data-keep': 'seed', oninput: (e) => { settings.seed = e.target.value.trim() === '' ? null : Number(e.target.value) || 0; } });
  form.append(h('details', { class: 'advanced' }, h('summary', {}, 'Advanced'), h('div', { class: 'field' }, h('span', {}, 'Seed (for a repeatable board & dice)'), seedInput)));

  form.append(
    h('div', { class: 'setup-actions' },
      h('button', { class: 'btn btn-primary btn-large', onclick: () => startLocal(settings) }, 'Start game'),
      h('button', { class: 'btn', onclick: rulesModal }, 'Rules'),
    ),
  );
  return h('div', { class: 'setup-screen' }, form);
}

let localRollOff = null;

/** Local games start with the roll-off for the first player; the board appears once the order is settled. */
function startLocal(settings) {
  storageSet(SETTINGS_KEY, JSON.stringify(settings));
  const options = { ...settings, players: settings.players.slice(0, settings.playerCount).map((p) => ({ ...p, name: p.name.trim() || 'Player' })) };
  mode = null;
  state = null;
  ui = { mode: null, viewer: null, botToken: ui.botToken + 1, reviewing: false, screen: 'rolloff' };
  const seeded = options.seed !== null && options.seed !== undefined;
  localRollOff = { options, rolls: createRollOff(options.players.length), rng: seeded ? createRng((options.seed ^ 0x5bd1e995) >>> 0) : null };
  render();
  scheduleLocalRollOffBots();
}

function localDie() {
  return localRollOff.rng ? 1 + localRollOff.rng.int(6) : 1 + Math.floor(Math.random() * 6);
}

function localRoll(pid) {
  if (!localRollOff) return;
  try {
    localRollOff.rolls = addRoll(localRollOff.rolls, pid, localDie());
  } catch (e) {
    toast(e.message);
    return;
  }
  if (isComplete(localRollOff.rolls)) {
    beginLocal(localRollOff.options, localRollOff.rolls);
    return;
  }
  render();
  scheduleLocalRollOffBots();
}

function scheduleLocalRollOffBots() {
  if (!localRollOff) return;
  const { options, rolls } = localRollOff;
  const bot = pendingRollers(rolls).find((pid) => options.players[pid].isBot);
  if (bot === undefined) return;
  const token = ++ui.botToken;
  setTimeout(() => {
    if (token !== ui.botToken || !localRollOff || ui.screen !== 'rolloff') return;
    localRoll(bot);
  }, 600);
}

function cancelLocalRollOff() {
  localRollOff = null;
  ui.botToken++;
  ui.screen = 'local';
  render();
}

function beginLocal(options, rolls) {
  const order = rollOrder(rolls);
  localRollOff = null;
  mode = 'local';
  ui = { mode: null, viewer: null, botToken: ui.botToken + 1, reviewing: false, screen: 'game' };
  state = newGame({ ...options, turnOrder: order });
  state.log.unshift({ turn: 0, player: order[0], text: describeRollOff(options.players.map((p) => p.name), rolls) });
  const firstHuman = state.players.find((p) => !p.isBot);
  ui.viewer = firstHuman ? firstHuman.id : null;
  if (state.options.passDevice && humans().length >= 2) ui.viewer = null; // force the first hand-off screen
  if (requiredActor() !== null) ding();
  save();
  render();
  scheduleBots();
}

// ---------------------------------------------------------------------------
// Roll-off screen (shared by the online lobby and local games)
// ---------------------------------------------------------------------------

/**
 * @param view {players: [{name, color, isBot}], rolls, canRoll(pid), onRoll(pid), footer: Node[], note?: string}
 */
function renderRollOffScreen(view) {
  const { players, rolls } = view;
  const pending = pendingRollers(rolls);
  const rerolling = pending.length > 0 && pending.every((pid) => rolls[pid].length > 0);
  const form = h('div', { class: 'setup-card' });
  form.append(
    h('h1', { class: 'title small-title' }, '🎲 Roll for first player'),
    h('p', { class: 'subtitle' }, 'Everyone rolls one die. The highest roll goes first and play continues in order of the dice. Ties roll again.'),
  );
  if (view.note) form.append(h('div', { class: 'conn-inline' }, view.note));
  const list = h('div', { class: 'player-list' });
  players.forEach((p, pid) => {
    const color = PLAYER_COLORS.find((c) => c.id === p.color);
    const isPending = pending.includes(pid);
    const dice = h('span', { class: 'dice-row', 'aria-label': rolls[pid].length ? `Rolled ${rolls[pid].join(' then ')}` : 'Not rolled yet' },
      rolls[pid].map((v, i) => h('span', { class: `die-face ${i === rolls[pid].length - 1 ? 'latest' : 'old'}` }, DICE[v - 1])),
      rolls[pid].length === 0 ? h('span', { class: 'die-face empty' }, '🎲') : null,
    );
    let action;
    if (isPending && view.canRoll(pid)) action = h('button', { class: 'btn btn-primary', onclick: () => view.onRoll(pid) }, rolls[pid].length ? 'Roll again' : '🎲 Roll');
    else if (isPending) action = h('span', { class: 'muted small' }, p.isBot ? 'rolling…' : rolls[pid].length ? 'tied, rolls again' : 'waiting to roll');
    else action = h('span', { class: 'ok' }, rolls[pid].length ? '✓' : '');
    list.append(
      h('div', { class: `player-row rolloff-row ${isPending ? 'pending' : ''}` },
        h('span', { class: 'dot big', style: { background: color ? color.hex : '#999' } }),
        h('span', { class: 'seat-name' }, p.name, p.isBot ? h('span', { class: 'pill' }, '🤖') : null),
        dice,
        h('span', { class: 'rolloff-action' }, action),
      ),
    );
  });
  form.append(list);
  if (rerolling) form.append(h('p', { class: 'muted small' }, 'Tie! The tied players roll again against each other.'));
  else form.append(h('p', { class: 'muted small' }, 'The board appears as soon as every die has been rolled.'));
  form.append(h('div', { class: 'setup-actions' }, view.footer));
  return h('div', { class: 'setup-screen' }, form);
}

function renderOnlineRollOff() {
  const room = online.room;
  const me = room.you;
  const isHost = room.host === me;
  return renderRollOffScreen({
    players: room.seats,
    rolls: room.rolloff.rolls,
    canRoll: (pid) => pid === me && online.status === 'open',
    onRoll: () => send({ t: 'rollDie' }),
    note: online.status !== 'open' ? 'Reconnecting…' : null,
    footer: [
      isHost ? h('button', { class: 'btn', onclick: () => send({ t: 'cancelRollOff' }) }, '← Back to lobby') : h('div', { class: 'waiting' }, 'Waiting for everyone to roll…'),
      chatButton(),
      h('button', { class: 'btn', onclick: () => leaveOnline() }, 'Leave'),
    ],
  });
}

function renderLocalRollOff() {
  const { options, rolls } = localRollOff;
  return renderRollOffScreen({
    players: options.players,
    rolls,
    canRoll: (pid) => !options.players[pid].isBot,
    onRoll: localRoll,
    footer: [h('button', { class: 'btn', onclick: cancelLocalRollOff }, '← Back')],
  });
}

function resumeLocal(saved) {
  mode = 'local';
  state = saved.state;
  ui = { mode: null, viewer: saved.viewer ?? null, botToken: ui.botToken + 1, reviewing: false, screen: 'game' };
  render();
  scheduleBots();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  preservingFocus(() => {
    clear(app);
    if (isOnline()) {
      if (!online.room) app.append(renderConnecting());
      else if (online.room.phase === 'lobby') app.append(renderLobby());
      else if (online.room.phase === 'rolloff' && online.room.rolloff) app.append(renderOnlineRollOff());
      else if (state) renderGame();
      else app.append(renderConnecting());
      if (online.room && ui.chatOpen) app.append(renderChatDrawer());
      return;
    }
    if (mode === 'local' && state) renderGame();
    else if (ui.screen === 'rolloff' && localRollOff) app.append(renderLocalRollOff());
    else if (ui.screen === 'local') app.append(renderLocalSetup());
    else app.append(renderHome());
  });
}

/** The undo offer this device may take right now, or null. */
function activeUndo() {
  const now = Date.now();
  if (isOnline()) return online.undo && online.undo.until > now ? online.undo : null;
  if (!localUndo || localUndo.until <= now || localUndo.result !== state) return null;
  // In pass-and-play the device may already have been handed on.
  if (state.options.passDevice && humans().length >= 2 && ui.viewer !== localUndo.player) return null;
  return localUndo;
}

function takeUndo() {
  if (isOnline()) {
    online.undo = null;
    send({ t: 'undo' });
    render();
    return;
  }
  const u = activeUndo();
  if (!u) return;
  localUndo = null;
  ui.mode = null;
  closeModal();
  setState(restoreFromOffer(u, state.players[u.player].name));
}

function renderUndoBanner(offer) {
  const remaining = Math.max(0, offer.until - Date.now());
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => render(), remaining + 30); // slide the banner away when the window closes
  return h('div', { class: 'undo-banner', role: 'status' },
    h('button', { class: 'btn btn-primary undo-btn', onclick: takeUndo }, `↩ Undo ${offer.label}`),
    h('div', { class: 'undo-progress' }, h('div', { class: 'undo-progress-bar', style: { animationDuration: `${remaining}ms` } })),
  );
}

function renderGame() {
  const game = h('div', { class: 'game' });
  game.append(renderPlayersBar());
  game.append(h('div', { class: 'board-area' }, renderBoardView()));
  game.append(renderPanel());
  const undo = activeUndo();
  if (undo) game.append(renderUndoBanner(undo));
  if (isOnline() && online.status !== 'open') game.append(h('div', { class: 'conn-banner', role: 'status' }, 'Connection lost. Reconnecting…'));
  if (needsPass()) game.append(renderPassOverlay());
  app.append(game);
  renderPendingModals();
}

function renderPlayersBar() {
  const bar = h('div', { class: 'players-bar' });
  const actors = new Set(actingPlayers(state));
  const owner = handOwner();
  const seats = isOnline() ? online.room.seats : null;
  for (const pid of turnOrderOf(state)) {
    const p = state.players[pid];
    const vp = visibleVictoryPoints(state, p.id);
    const showHidden = state.phase === 'ended' || (isOnline() ? p.id === mySeat() : (!state.options.passDevice && !p.isBot) || (p.id === owner && !p.isBot));
    const total = countVictoryPoints(state, p.id);
    const offline = seats && seats[p.id] && !seats[p.id].connected;
    const chip = h(
      'div',
      { class: `player-chip ${state.turn.player === p.id ? 'current' : ''} ${actors.has(p.id) ? 'acting' : ''} ${offline ? 'offline' : ''}`, style: { '--pc': colorOf(state, p.id) } },
      h('div', { class: 'chip-head' },
        h('span', { class: 'dot' }),
        h('span', { class: 'chip-name' }, p.name),
        isOnline() && p.id === mySeat() ? h('span', { class: 'you-tag' }, 'you') : null,
        p.isBot ? h('span', { class: 'bot-tag', title: 'Bot' }, '🤖') : null,
        offline ? h('span', { class: 'offline-tag', title: 'Disconnected' }, 'offline') : null,
      ),
      h('div', { class: 'chip-stats' },
        h('span', { class: 'stat vp', title: 'Victory points' }, `${showHidden && total !== vp ? `${vp}+${total - vp}` : vp} VP`),
        h('span', { class: 'stat', title: 'Resource cards' }, `🂠 ${handSize(p)}`),
        h('span', { class: 'stat', title: 'Development cards' }, `🃏 ${p.devCards.length}`),
        h('span', { class: 'stat', title: 'Knights played' }, `⚔️ ${p.knightsPlayed}`),
        h('span', { class: 'stat', title: 'Longest road' }, `🛣️ ${longestRoadLength(state.board, p.id)}`),
      ),
      h('div', { class: 'chip-badges' },
        state.longestRoad.player === p.id ? h('span', { class: 'badge' }, 'Longest Road') : null,
        state.largestArmy.player === p.id ? h('span', { class: 'badge' }, 'Largest Army') : null,
      ),
    );
    bar.append(chip);
  }
  if (isOnline()) bar.append(chatButton('icon-btn'));
  bar.append(h('button', { class: 'btn icon-btn menu-btn', 'aria-label': 'Menu', onclick: openMenu }, '☰'));
  return bar;
}

function renderBoardView() {
  const view = { vertexTargets: new Set(), edgeTargets: new Set(), hexTargets: new Set() };
  const pid = state.turn.player;
  const myMove = canControl(pid) && !needsPass();
  if (myMove && state.phase === 'setup') {
    if (state.setup.step === 'settlement') view.vertexTargets = new Set(validSettlementVertices(state, pid, { setup: true }));
    else view.edgeTargets = new Set(validRoadEdges(state, pid, { fromVertex: state.setup.lastVertex }));
    view.activeColor = colorOf(state, pid);
    view.onVertex = (v) => dispatch({ type: 'placeSettlement', vertex: v });
    view.onEdge = (e) => dispatch({ type: 'placeRoad', edge: e });
  } else if (myMove && state.phase === 'main') {
    view.activeColor = colorOf(state, pid);
    const pend = state.pending;
    if (pend && pend.type === 'moveRobber') {
      view.hexTargets = new Set(validRobberHexes(state));
      view.onHex = (id) => dispatch({ type: 'moveRobber', hex: id });
    } else if (pend && pend.type === 'roadBuilding') {
      view.edgeTargets = new Set(validRoadEdges(state, pid));
      view.onEdge = (e) => dispatch({ type: 'placeRoad', edge: e });
    } else if (!pend && ui.mode === 'road') {
      view.edgeTargets = new Set(validRoadEdges(state, pid));
      view.onEdge = (e) => dispatch({ type: 'buildRoad', edge: e });
    } else if (!pend && ui.mode === 'settlement') {
      view.vertexTargets = new Set(validSettlementVertices(state, pid));
      view.onVertex = (v) => dispatch({ type: 'buildSettlement', vertex: v });
    } else if (!pend && ui.mode === 'city') {
      view.vertexTargets = new Set(validCityVertices(state, pid));
      view.onVertex = (v) => dispatch({ type: 'buildCity', vertex: v });
    }
  }
  return renderBoard(state, view);
}

function statusText() {
  const p = state.players[state.turn.player];
  const mine = isOnline() && state.turn.player === mySeat();
  const name = mine ? 'Your turn' : p.name;
  const pend = state.pending;
  if (state.phase === 'ended') return `${state.players[state.winner].name} has won the game!`;
  if (state.phase === 'setup') {
    const which = state.setup.round === 1 ? 'first' : 'second';
    return state.setup.step === 'settlement' ? `${name}: place ${mine ? 'your' : 'a'} ${which} settlement.` : `${name}: place a road next to the new settlement.`;
  }
  if (pend) {
    switch (pend.type) {
      case 'discard':
        return `${pend.players.map((d) => state.players[d.player].name).join(', ')} must discard cards.`;
      case 'moveRobber':
        return `${name}: move the robber to another hex.`;
      case 'steal':
        return `${name}: choose a player to steal from.`;
      case 'roadBuilding':
        return `${name}: place ${pend.remaining} free road${pend.remaining > 1 ? 's' : ''}.`;
      case 'trade':
        return `${state.players[pend.from].name} is proposing a trade.`;
      default:
        return '';
    }
  }
  if (!state.turn.rolled) return `${name}: roll the dice${isMyTurn(state.turn.player) && playableDevCards(state).length ? ' or play a development card' : ''}.`;
  if (ui.mode === 'road') return 'Tap an edge to build a road.';
  if (ui.mode === 'settlement') return 'Tap a corner to build a settlement.';
  if (ui.mode === 'city') return 'Tap one of your settlements to upgrade it.';
  return `${name}: build, trade or end the turn.`;
}

function renderPanel() {
  const panel = h('div', { class: 'panel' });
  const owner = handOwner();
  const p = state.players[owner];
  const cur = state.players[state.turn.player];

  const status = h('div', { class: 'status-row', style: { '--pc': colorOf(state, state.turn.player) } });
  status.append(h('span', { class: 'dot' }));
  status.append(h('span', { class: 'status-text' }, statusText()));
  if (state.turn.dice) status.append(h('span', { class: 'dice', 'aria-label': `Rolled ${state.turn.dice[0] + state.turn.dice[1]}` }, DICE[state.turn.dice[0] - 1], DICE[state.turn.dice[1] - 1], h('span', { class: 'dice-total' }, state.turn.dice[0] + state.turn.dice[1])));
  panel.append(status);

  // Hand
  const hideHand = needsPass() || (p.isBot && !isOnline());
  const hand = h('div', { class: 'hand', style: { '--pc': colorOf(state, owner) } });
  hand.append(h('div', { class: 'hand-title' }, h('span', { class: 'dot' }), h('strong', {}, isOnline() ? 'Your hand' : p.name), h('span', { class: 'muted small' }, isOnline() ? '' : p.isBot ? ' (bot)' : hideHand ? ' (hidden)' : "'s hand")));
  if (!hideHand) {
    hand.append(h('div', { class: 'cards' }, RESOURCES.map((r) => h('div', { class: `card res-${r} ${p.resources[r] === 0 ? 'empty' : ''}`, title: RESOURCE_LABEL[r] }, h('span', { class: 'card-icon' }, RESOURCE_ICON[r]), h('span', { class: 'card-count' }, p.resources[r]), h('span', { class: 'card-label' }, RESOURCE_LABEL[r])))));
    hand.append(h('div', { class: 'pieces muted small' }, `Roads ${piecesLeft(state, owner, 'road')} · Settlements ${piecesLeft(state, owner, 'settlement')} · Cities ${piecesLeft(state, owner, 'city')} · Dev cards ${p.devCards.length}`));
  } else {
    hand.append(h('div', { class: 'cards hidden-cards' }, h('span', { class: 'muted' }, `${handSize(p)} resource cards, ${p.devCards.length} development cards`)));
  }
  panel.append(hand);

  // Actions
  const actions = h('div', { class: 'actions' });
  const myTurn = isMyTurn(state.turn.player) && state.turn.player === owner && !needsPass();
  const pend = state.pending;
  if (state.phase === 'ended') {
    actions.append(h('button', { class: 'btn btn-primary', onclick: openGameOver }, 'Show results'));
    actions.append(endGameButton());
  } else if (state.phase === 'setup') {
    if (canControl(cur.id)) actions.append(h('p', { class: 'muted small' }, 'Tap a highlighted spot on the board.'));
    else actions.append(h('p', { class: 'muted small' }, cur.isBot ? `${cur.name} is thinking…` : `Waiting for ${cur.name}…`));
  } else if (myTurn) {
    if (pend && pend.type === 'trade') {
      actions.append(renderTradePanel());
    } else if (pend && (pend.type === 'moveRobber' || pend.type === 'roadBuilding')) {
      actions.append(h('p', { class: 'muted small' }, pend.type === 'moveRobber' ? 'Tap a hex to move the robber there.' : 'Tap a highlighted edge to place a free road.'));
      if (pend.type === 'roadBuilding') actions.append(h('button', { class: 'btn', onclick: () => dispatch({ type: 'skipRoadBuilding' }) }, 'Skip remaining roads'));
    } else if (pend) {
      actions.append(h('p', { class: 'muted small' }, 'Waiting for other players…'));
    } else if (ui.mode) {
      actions.append(h('button', { class: 'btn btn-wide', onclick: () => { ui.mode = null; render(); } }, '✕ Cancel'));
    } else {
      const devPlayable = playableDevCards(state).length > 0;
      const cardsBtn = h('button', { class: `btn ${devPlayable ? 'btn-accent' : ''}`, onclick: () => openDevCards(owner) }, `🃏 Cards (${p.devCards.length})`);
      if (!state.turn.rolled) {
        actions.append(
          h('button', { class: 'btn btn-primary btn-large', disabled: !canRoll(state), onclick: () => dispatch({ type: 'roll' }) }, '🎲 Roll dice'),
          cardsBtn,
        );
      } else {
        actions.append(
          h('button', { class: 'btn', disabled: !canBuild(state, 'road'), onclick: () => { ui.mode = 'road'; render(); } }, 'Road', costIcons(COSTS.road)),
          h('button', { class: 'btn', disabled: !canBuild(state, 'settlement'), onclick: () => { ui.mode = 'settlement'; render(); } }, 'Settlement', costIcons(COSTS.settlement)),
          h('button', { class: 'btn', disabled: !canBuild(state, 'city'), onclick: () => { ui.mode = 'city'; render(); } }, 'City', costIcons(COSTS.city)),
          h('button', { class: 'btn', disabled: !canBuild(state, 'devCard'), onclick: () => dispatch({ type: 'buyDevCard' }) }, 'Dev card', costIcons(COSTS.devCard)),
          h('button', { class: 'btn', onclick: () => tradeModal(state, owner, dispatch) }, '🔁 Trade'),
          cardsBtn,
          h('button', { class: 'btn btn-end btn-wide', onclick: () => dispatch({ type: 'endTurn' }) }, 'End turn ➜'),
        );
      }
    }
  } else {
    if (pend && pend.type === 'trade') actions.append(renderTradePanel());
    else if (pend && pend.type === 'discard' && requiredActor() !== null) actions.append(h('p', { class: 'muted small' }, 'You must discard cards.'));
    else if (cur.isBot) actions.append(h('p', { class: 'muted small' }, `${cur.name} is playing…`));
    else actions.append(h('p', { class: 'muted small' }, `Waiting for ${cur.name}…`));
    if (!p.isBot && !hideHand) actions.append(h('button', { class: 'btn', onclick: () => openDevCards(owner, false) }, `🃏 Cards (${p.devCards.length})`));
  }
  panel.append(actions);

  // Log
  const entries = state.log.slice(-8).reverse();
  panel.append(
    h('div', { class: 'log' },
      h('div', { class: 'log-head' }, h('span', {}, 'Log'), h('button', { class: 'btn small', onclick: openFullLog }, 'Show all')),
      h('ul', {}, entries.map((e) => h('li', {}, e.player !== null && e.player !== undefined ? h('span', { class: 'dot', style: { background: colorHex(state, e.player) } }) : null, e.text))),
    ),
  );
  return panel;
}

function costIcons(cost) {
  return h('span', { class: 'cost-icons' }, Object.entries(cost).map(([r, n]) => `${RESOURCE_ICON[r]}${n > 1 ? n : ''}`).join(''));
}

function renderTradePanel() {
  const t = state.pending;
  const from = state.players[t.from];
  const box = h('div', { class: 'trade-panel' });
  box.append(h('div', { class: 'trade-summary' }, h('strong', {}, from.name), ' offers ', ...RESOURCES.filter((r) => t.offer[r]).map((r) => resourceChip(r, t.offer[r])), ' for ', ...RESOURCES.filter((r) => t.request[r]).map((r) => resourceChip(r, t.request[r]))));
  const rows = h('div', { class: 'trade-rows' });
  for (const [pidStr, resp] of Object.entries(t.responses)) {
    const pid = Number(pidStr);
    const other = state.players[pid];
    const row = h('div', { class: 'trade-row', style: { '--pc': colorOf(state, pid) } }, h('span', { class: 'dot' }), h('span', { class: 'trade-name' }, isOnline() && pid === mySeat() ? `${other.name} (you)` : other.name));
    if (resp === null) {
      if (canControl(pid)) {
        row.append(
          h('span', { class: 'trade-btns' },
            h('button', { class: 'btn small', onclick: () => dispatch({ type: 'respondTrade', player: pid, accept: false }) }, 'Decline'),
            h('button', { class: 'btn small btn-primary', onclick: () => dispatch({ type: 'respondTrade', player: pid, accept: true }) }, 'Accept'),
          ),
        );
      } else row.append(h('span', { class: 'muted small' }, other.isBot ? 'thinking…' : 'deciding…'));
    } else if (resp === 'accepted') {
      row.append(h('span', { class: 'ok' }, '✔ accepted'));
      if (canControl(t.from)) row.append(h('button', { class: 'btn small btn-primary', onclick: () => dispatch({ type: 'acceptTrade', partner: pid }) }, 'Trade'));
    } else row.append(h('span', { class: 'muted' }, '✕ declined'));
    rows.append(row);
  }
  box.append(rows);
  if (canControl(t.from)) box.append(h('button', { class: 'btn btn-wide', onclick: () => dispatch({ type: 'cancelTrade' }) }, 'Withdraw offer'));
  return box;
}

function openDevCards(pid, canPlay = true) {
  devCardsModal(state, pid, {
    canPlay: canPlay && isMyTurn(pid),
    onPlay: (card) => {
      if (card.type === 'yearOfPlenty') yearOfPlentyModal(state, card, dispatch);
      else if (card.type === 'monopoly') monopolyModal(card, dispatch);
      else dispatch({ type: 'playDevCard', card: card.id });
    },
  });
}

function openFullLog() {
  showModal({
    title: 'Game log',
    className: 'modal-wide',
    body: h('ul', { class: 'full-log' }, state.log.slice().reverse().map((e) => h('li', {}, h('span', { class: 'muted small' }, `T${e.turn} `), e.player !== null && e.player !== undefined ? h('span', { class: 'dot', style: { background: colorHex(state, e.player) } }) : null, e.text))),
    actions: [{ label: 'Close', onClick: closeModal }],
  });
}

function openMenu() {
  const items = [
    h('button', { class: 'btn btn-wide', onclick: () => { setSoundEnabled(!soundEnabled()); closeModal(); openMenu(); } }, soundEnabled() ? '🔔 Sound effects: on' : '🔕 Sound effects: off'),
    h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); costsModal(); } }, '🏗️ Building costs'),
    h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); rulesModal(); } }, '📖 Rules summary'),
    h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); openFullLog(); } }, '📜 Full log'),
  ];
  if (state.phase === 'ended') items.push(h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); openDiceStats(); } }, '📊 Game stats'));
  if (isOnline()) {
    const room = online.room;
    items.unshift(h('div', { class: 'menu-room' }, h('span', { class: 'muted small' }, 'Room'), h('strong', { class: 'room-code small' }, room.code), h('button', { class: 'btn small', onclick: copyLink }, '🔗 Copy link')));
    const away = room.seats.map((s, idx) => ({ s, idx })).filter(({ s }) => !s.isBot && !s.connected);
    if (away.length && state.phase !== 'ended') {
      items.push(h('p', { class: 'muted small' }, 'Disconnected players can be handed to a bot so the game can continue. They take their seat back when they return.'));
      for (const { s, idx } of away) items.push(h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); send({ t: 'replaceWithBot', seat: idx }); } }, `🤖 Let a bot play for ${s.name}`));
    }
    items.push(h('button', { class: 'btn btn-wide btn-danger', onclick: confirmLeaveOnline }, '🚪 Leave game'));
  } else {
    items.push(h('button', { class: 'btn btn-wide btn-danger', onclick: confirmNewLocalGame }, '🔄 New game'));
  }
  showModal({ title: 'Menu', body: h('div', { class: 'menu-list' }, items), actions: [{ label: 'Close', onClick: closeModal }] });
}

function confirmLeaveOnline() {
  showModal({
    title: 'Leave this game?',
    body: h('p', {}, state.phase === 'ended' ? 'You will return to the home screen.' : 'You can rejoin from the home screen while the room is open. Others can let a bot play for you meanwhile.'),
    actions: [
      { label: 'Stay', onClick: closeModal },
      { label: 'Leave', onClick: () => leaveOnline(), danger: true },
    ],
  });
}

function confirmNewLocalGame() {
  showModal({
    title: 'Abandon this game?',
    body: h('p', {}, 'The current game will be discarded.'),
    actions: [
      { label: 'Keep playing', onClick: closeModal },
      { label: 'New game', onClick: newLocalGame, danger: true },
    ],
  });
}

function newLocalGame() {
  clearSave();
  closeModal();
  state = null;
  mode = null;
  ui.botToken++;
  ui.screen = 'local';
  render();
}

function endGameButton() {
  if (!isOnline()) return h('button', { class: 'btn', onclick: newLocalGame }, 'New game');
  if (online.room.host === mySeat()) return h('button', { class: 'btn', onclick: () => send({ t: 'restart' }) }, 'Back to lobby');
  return h('button', { class: 'btn', onclick: () => leaveOnline() }, 'Leave');
}

function openDiceStats() {
  showModal({
    title: 'Game statistics',
    className: 'modal-wide',
    body: renderGameStats(state),
    actions: [
      state.phase === 'ended' ? { label: 'Back to results', onClick: () => { closeModal(); openGameOver(); } } : null,
      { label: 'Close', onClick: closeModal },
    ].filter(Boolean),
  });
}

function openGameOver() {
  if (!isOnline()) {
    gameOverModal(state, newLocalGame, closeModal, 'New game', openDiceStats);
    return;
  }
  if (online.room.host === mySeat()) gameOverModal(state, () => { closeModal(); send({ t: 'restart' }); }, closeModal, 'Play again', openDiceStats);
  else gameOverModal(state, () => leaveOnline(), closeModal, 'Leave', openDiceStats);
}

function renderPassOverlay() {
  const req = requiredActor();
  const p = state.players[req];
  let why = 'It is your turn.';
  const pend = state.pending;
  if (pend && pend.type === 'discard') why = 'You must discard cards.';
  else if (pend && pend.type === 'trade') why = 'Your trade offer is waiting.';
  return h('div', { class: 'pass-overlay' },
    h('div', { class: 'pass-card', style: { '--pc': colorOf(state, req) } },
      h('div', { class: 'pass-dot' }),
      h('h2', {}, `Pass the device to ${p.name}`),
      h('p', { class: 'muted' }, why),
      h('button', { class: 'btn btn-primary btn-large', onclick: () => { ui.viewer = req; save(); render(); } }, `I'm ${p.name}`),
    ),
  );
}

function renderPendingModals() {
  if (state.phase === 'ended') {
    if (!ui.reviewing) {
      ui.reviewing = true;
      openGameOver();
    }
    return;
  }
  if (needsPass()) return;
  const pend = state.pending;
  if (!pend) return;
  const req = requiredActor();
  if (req === null) return;
  if (pend.type === 'discard') {
    const entry = pend.players.find((d) => d.player === req);
    if (entry && currentModalTag() !== 'discard') discardModal(state, req, entry.count, dispatch);
  } else if (pend.type === 'steal' && state.turn.player === req && currentModalTag() !== 'steal') {
    stealModal(state, pend.candidates, dispatch);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(function boot() {
  primeAudio();
  const session = loadSession();
  const linked = urlRoom();
  if (session && (!linked || linked === session.room)) startOnline(null);
  else render();
})();

// Keep a reference for debugging in the console.
window.__catan = {
  get state() {
    return state;
  },
  get room() {
    return online.room;
  },
  get sound() {
    return soundStats;
  },
  dispatch,
  /** Load a saved local game ({state, viewer}) for debugging. */
  load(saved) {
    resumeLocal(saved);
  },
};
