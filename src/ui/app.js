import { h, clear } from './dom.js';
import { renderBoard, colorOf } from './board-svg.js';
import {
  initModals,
  showModal,
  closeModal,
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
  totalResources,
} from '../game.js';
import { botAction } from '../ai.js';
import { RESOURCES, RESOURCE_ICON, RESOURCE_LABEL, PLAYER_COLORS, DEFAULT_OPTIONS, COSTS, DEV_CARD_LABEL } from '../constants.js';
import { longestRoadLength } from '../rules.js';

const SAVE_KEY = 'catan-clone-save-v1';
const SETTINGS_KEY = 'catan-clone-setup-v1';
const DICE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');
initModals(modalRoot);

let state = null;
let ui = { mode: null, viewer: null, botToken: 0, reviewing: false };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function save() {
  try {
    if (state) localStorage.setItem(SAVE_KEY, JSON.stringify({ state, viewer: ui.viewer }));
  } catch (e) {
    /* ignore */
  }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.state || data.state.version !== 1) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast(msg, kind = 'error') {
  const el = h('div', { class: `toast toast-${kind}` }, msg);
  toastRoot.append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

function humans() {
  return state.players.filter((p) => !p.isBot);
}

/** The human who must act now (first in the acting list), or null. */
function requiredActor() {
  const actors = actingPlayers(state);
  for (const pid of actors) if (!state.players[pid].isBot) return pid;
  return null;
}

function needsPass() {
  if (!state.options.passDevice || humans().length < 2) return false;
  const req = requiredActor();
  return req !== null && ui.viewer !== req;
}

/** Whose hand is shown on screen. */
function handOwner() {
  const req = requiredActor();
  if (req !== null) return req;
  if (!state.players[state.turn.player].isBot) return state.turn.player;
  // All bots or bot's turn: show the last human viewer, or the current player.
  if (ui.viewer !== null && !state.players[ui.viewer].isBot) return ui.viewer;
  return state.turn.player;
}

function isMyTurn(pid) {
  return state.turn.player === pid && !state.players[pid].isBot;
}

function dispatch(action) {
  try {
    const next = act(state, action);
    ui.mode = null;
    setState(next);
    return true;
  } catch (e) {
    if (e instanceof GameError) toast(e.message);
    else {
      console.error(e);
      toast('Something went wrong: ' + e.message);
    }
    return false;
  }
}

function setState(next) {
  const prevState = state;
  state = next;
  if (ui.mode && (state.pending || state.phase !== 'main')) ui.mode = null;
  // Reset mode when the turn changes.
  if (prevState && prevState.turn.player !== state.turn.player) ui.mode = null;
  closeModal();
  save();
  render();
  announceEvents(prevState);
  scheduleBots();
}

function announceEvents(prev) {
  const ev = state.lastEvent;
  if (!ev) return;
  if (ev.type === 'steal' && !state.players[ev.thief].isBot && (!state.options.passDevice || humans().length < 2 || ui.viewer === ev.thief)) {
    toast(`You stole ${RESOURCE_ICON[ev.resource]} ${RESOURCE_LABEL[ev.resource]} from ${state.players[ev.victim].name}.`, 'info');
  } else if (ev.type === 'devCardBought' && !state.players[ev.player].isBot) {
    toast(`You drew: ${DEV_CARD_LABEL[ev.card]}`, 'info');
  }
  void prev;
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function scheduleBots() {
  if (!state || state.phase === 'ended') return;
  const actors = actingPlayers(state);
  const bot = actors.find((pid) => state.players[pid].isBot && botAction(state, pid));
  if (bot === undefined) return;
  const token = ++ui.botToken;
  const delay = state.phase === 'setup' ? 450 : 650;
  setTimeout(() => {
    if (token !== ui.botToken || !state) return;
    const a = botAction(state, bot);
    if (!a) return;
    try {
      setState(act(state, a));
    } catch (e) {
      console.error('Bot action failed', a, e);
      // Try to recover by ending the turn if possible.
      if (state.turn.player === bot && state.turn.rolled && !state.pending) dispatch({ type: 'endTurn' });
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_OPTIONS, players: defaultPlayers(), ...JSON.parse(raw) };
  } catch (e) {
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

function renderSetupScreen() {
  ui.botToken++;
  closeModal();
  const settings = loadSettings();
  const saved = loadSave();
  const root = h('div', { class: 'setup-screen' });
  const form = h('div', { class: 'setup-card' });
  root.append(form);

  const rerender = () => {
    clear(form);
    form.append(h('h1', { class: 'title' }, '🏝️ Settlers'), h('p', { class: 'subtitle' }, 'A mobile-friendly clone of the classic island-building board game.'));
    if (saved && saved.state.phase !== 'ended') {
      form.append(
        h('div', { class: 'resume-box' },
          h('div', {}, h('strong', {}, 'Game in progress'), h('div', { class: 'muted small' }, `${saved.state.players.map((p) => p.name).join(', ')} · turn ${saved.state.turn.number}`)),
          h('button', { class: 'btn btn-primary', onclick: () => resumeGame(saved) }, 'Resume'),
        ),
      );
    }

    // Players
    form.append(h('h2', {}, 'Players'));
    const countRow = h('div', { class: 'seg' }, [3, 4].map((n) => h('button', { class: `seg-btn ${settings.playerCount === n ? 'active' : ''}`, onclick: () => { settings.playerCount = n; rerender(); } }, `${n} players`)));
    form.append(countRow);
    const list = h('div', { class: 'player-list' });
    for (let i = 0; i < settings.playerCount; i++) {
      const pl = settings.players[i];
      const colorSel = h(
        'select',
        { class: 'color-select', 'aria-label': `Player ${i + 1} color`, onchange: (e) => {
          const other = settings.players.find((o) => o !== pl && o.color === e.target.value);
          if (other) other.color = pl.color;
          pl.color = e.target.value;
          rerender();
        } },
        PLAYER_COLORS.map((c) => h('option', { value: c.id, selected: pl.color === c.id }, c.label)),
      );
      list.append(
        h('div', { class: 'player-row' },
          h('span', { class: 'dot big', style: { background: PLAYER_COLORS.find((c) => c.id === pl.color).hex } }),
          h('input', { type: 'text', class: 'name-input', value: pl.name, maxlength: 14, 'aria-label': `Player ${i + 1} name`, oninput: (e) => { pl.name = e.target.value; } }),
          colorSel,
          h('div', { class: 'seg small' },
            h('button', { class: `seg-btn ${!pl.isBot ? 'active' : ''}`, onclick: () => { pl.isBot = false; rerender(); } }, 'Human'),
            h('button', { class: `seg-btn ${pl.isBot ? 'active' : ''}`, onclick: () => { pl.isBot = true; rerender(); } }, 'Bot'),
          ),
        ),
      );
    }
    form.append(list);

    // Board options
    form.append(h('h2', {}, 'Board'));
    form.append(h('div', { class: 'seg' },
      h('button', { class: `seg-btn ${settings.boardLayout === 'random' ? 'active' : ''}`, onclick: () => { settings.boardLayout = 'random'; rerender(); } }, 'Variable setup'),
      h('button', { class: `seg-btn ${settings.boardLayout === 'beginner' ? 'active' : ''}`, onclick: () => { settings.boardLayout = 'beginner'; rerender(); } }, 'Beginner layout'),
    ));
    const toggle = (key, label, hint, disabled = false) =>
      h('label', { class: `toggle ${disabled ? 'disabled' : ''}` },
        h('input', { type: 'checkbox', checked: !!settings[key], disabled, onchange: (e) => { settings[key] = e.target.checked; } }),
        h('span', { class: 'toggle-text' }, h('span', {}, label), hint ? h('span', { class: 'muted small' }, hint) : null),
      );
    form.append(
      toggle('randomHarbors', 'Shuffle harbors', 'Randomize harbor types around the coast', settings.boardLayout === 'beginner'),
      toggle('balancedNumbers', 'Balanced numbers', 'Never place 6 and 8 tokens next to each other', settings.boardLayout === 'beginner'),
    );

    // Rules options
    form.append(h('h2', {}, 'Rules'));
    form.append(h('div', { class: 'field' }, h('span', {}, 'Victory points to win'), h('div', { class: 'seg' }, [8, 10, 12, 15].map((n) => h('button', { class: `seg-btn ${settings.targetVP === n ? 'active' : ''}`, onclick: () => { settings.targetVP = n; rerender(); } }, n)))));
    form.append(h('div', { class: 'field' }, h('span', {}, 'Discard when holding more than'), h('div', { class: 'seg' }, [7, 9].map((n) => h('button', { class: `seg-btn ${settings.discardLimit === n ? 'active' : ''}`, onclick: () => { settings.discardLimit = n; rerender(); } }, `${n} cards`)))));
    form.append(
      toggle('friendlyRobber', 'Friendly robber', 'The robber cannot be placed next to players with 2 or fewer points'),
      toggle('passDevice', 'Pass-and-play privacy', 'Show a hand-off screen between human players so hands stay hidden'),
    );

    const seedInput = h('input', { type: 'text', class: 'name-input', placeholder: 'random', value: settings.seed ?? '', inputmode: 'numeric', 'aria-label': 'Seed' , oninput: (e) => { settings.seed = e.target.value.trim() === '' ? null : Number(e.target.value) || 0; } });
    form.append(h('details', { class: 'advanced' }, h('summary', {}, 'Advanced'), h('div', { class: 'field' }, h('span', {}, 'Seed (for a repeatable board & dice)'), seedInput)));

    form.append(
      h('div', { class: 'setup-actions' },
        h('button', { class: 'btn btn-primary btn-large', onclick: () => startGame(settings) }, 'Start game'),
        h('button', { class: 'btn', onclick: rulesModal }, 'Rules'),
      ),
    );
  };
  rerender();
  clear(app);
  app.append(root);
}

function startGame(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    /* ignore */
  }
  const options = { ...settings, players: settings.players.slice(0, settings.playerCount).map((p) => ({ ...p, name: p.name.trim() || 'Player' })) };
  state = newGame(options);
  ui = { mode: null, viewer: null, botToken: ui.botToken + 1, reviewing: false };
  const firstHuman = state.players.find((p) => !p.isBot);
  ui.viewer = firstHuman ? firstHuman.id : null;
  if (state.options.passDevice && humans().length >= 2) ui.viewer = null; // force the first hand-off screen
  save();
  render();
  scheduleBots();
}

function resumeGame(saved) {
  state = saved.state;
  ui = { mode: null, viewer: saved.viewer ?? null, botToken: ui.botToken + 1, reviewing: false };
  render();
  scheduleBots();
}

// ---------------------------------------------------------------------------
// Game screen
// ---------------------------------------------------------------------------

function render() {
  if (!state) return renderSetupScreen();
  clear(app);
  const game = h('div', { class: 'game' });
  game.append(renderPlayersBar());
  game.append(h('div', { class: 'board-area' }, renderBoardView()));
  game.append(renderPanel());
  if (needsPass()) game.append(renderPassOverlay());
  app.append(game);
  renderPendingModals();
}

function renderPlayersBar() {
  const bar = h('div', { class: 'players-bar' });
  const actors = new Set(actingPlayers(state));
  const owner = handOwner();
  for (const p of state.players) {
    const vp = visibleVictoryPoints(state, p.id);
    const showHidden = state.phase === 'ended' || (!state.options.passDevice && !p.isBot) || (p.id === owner && !p.isBot);
    const total = countVictoryPoints(state, p.id);
    const chip = h(
      'div',
      { class: `player-chip ${state.turn.player === p.id ? 'current' : ''} ${actors.has(p.id) ? 'acting' : ''}`, style: { '--pc': colorOf(state, p.id) } },
      h('div', { class: 'chip-head' }, h('span', { class: 'dot' }), h('span', { class: 'chip-name' }, p.name), p.isBot ? h('span', { class: 'bot-tag' }, '🤖') : null),
      h('div', { class: 'chip-stats' },
        h('span', { class: 'stat vp', title: 'Victory points' }, `${showHidden && total !== vp ? `${vp}+${total - vp}` : vp} VP`),
        h('span', { class: 'stat', title: 'Resource cards' }, `🂠 ${totalResources(p.resources)}`),
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
  bar.append(h('button', { class: 'btn icon-btn menu-btn', 'aria-label': 'Menu', onclick: openMenu }, '☰'));
  return bar;
}

function renderBoardView() {
  const view = { vertexTargets: new Set(), edgeTargets: new Set(), hexTargets: new Set() };
  const pid = state.turn.player;
  const p = state.players[pid];
  const humanTurn = !p.isBot && !needsPass();
  if (humanTurn && state.phase === 'setup') {
    if (state.setup.step === 'settlement') view.vertexTargets = new Set(validSettlementVertices(state, pid, { setup: true }));
    else view.edgeTargets = new Set(validRoadEdges(state, pid, { fromVertex: state.setup.lastVertex }));
    view.activeColor = colorOf(state, pid);
    view.onVertex = (v) => dispatch({ type: 'placeSettlement', vertex: v });
    view.onEdge = (e) => dispatch({ type: 'placeRoad', edge: e });
  } else if (humanTurn && state.phase === 'main') {
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
  const name = p.name;
  const pend = state.pending;
  if (state.phase === 'ended') return `${state.players[state.winner].name} has won the game!`;
  if (state.phase === 'setup') {
    const which = state.setup.round === 1 ? 'first' : 'second';
    return state.setup.step === 'settlement' ? `${name}: place your ${which} settlement.` : `${name}: place a road next to your new settlement.`;
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
  if (!state.turn.rolled) return `${name}: roll the dice${playableDevCards(state).length ? ' or play a development card' : ''}.`;
  if (ui.mode === 'road') return 'Tap an edge to build a road.';
  if (ui.mode === 'settlement') return 'Tap a corner to build a settlement.';
  if (ui.mode === 'city') return 'Tap one of your settlements to upgrade it.';
  return `${name}: build, trade or end your turn.`;
}

function renderPanel() {
  const panel = h('div', { class: 'panel' });
  const owner = handOwner();
  const p = state.players[owner];
  const cur = state.players[state.turn.player];

  // Status row
  const status = h('div', { class: 'status-row', style: { '--pc': colorOf(state, state.turn.player) } });
  status.append(h('span', { class: 'dot' }));
  status.append(h('span', { class: 'status-text' }, statusText()));
  if (state.turn.dice) status.append(h('span', { class: 'dice', 'aria-label': `Rolled ${state.turn.dice[0] + state.turn.dice[1]}` }, DICE[state.turn.dice[0] - 1], DICE[state.turn.dice[1] - 1], h('span', { class: 'dice-total' }, state.turn.dice[0] + state.turn.dice[1])));
  panel.append(status);

  // Hand
  const hideHand = state.options.passDevice && humans().length >= 2 && needsPass();
  const hand = h('div', { class: 'hand', style: { '--pc': colorOf(state, owner) } });
  hand.append(h('div', { class: 'hand-title' }, h('span', { class: 'dot' }), h('strong', {}, p.name), h('span', { class: 'muted small' }, p.isBot ? ' (bot)' : hideHand ? ' (hidden)' : "'s hand")));
  if (!hideHand && !p.isBot) {
    hand.append(h('div', { class: 'cards' }, RESOURCES.map((r) => h('div', { class: `card res-${r} ${p.resources[r] === 0 ? 'empty' : ''}`, title: RESOURCE_LABEL[r] }, h('span', { class: 'card-icon' }, RESOURCE_ICON[r]), h('span', { class: 'card-count' }, p.resources[r]), h('span', { class: 'card-label' }, RESOURCE_LABEL[r])))));
    const pieces = h('div', { class: 'pieces muted small' }, `Roads ${piecesLeft(state, owner, 'road')} · Settlements ${piecesLeft(state, owner, 'settlement')} · Cities ${piecesLeft(state, owner, 'city')} · Dev cards ${p.devCards.length}`);
    hand.append(pieces);
  } else {
    hand.append(h('div', { class: 'cards hidden-cards' }, h('span', { class: 'muted' }, `${totalResources(p.resources)} resource cards, ${p.devCards.length} development cards`)));
  }
  panel.append(hand);

  // Actions
  const actions = h('div', { class: 'actions' });
  const myTurn = isMyTurn(owner) && !needsPass();
  if (state.phase === 'ended') {
    actions.append(h('button', { class: 'btn btn-primary', onclick: () => gameOverModal(state, newGameFromMenu, closeModal) }, 'Show results'));
    actions.append(h('button', { class: 'btn', onclick: newGameFromMenu }, 'New game'));
  } else if (state.phase === 'setup') {
    if (!cur.isBot) actions.append(h('p', { class: 'muted small' }, 'Tap a highlighted spot on the board.'));
    else actions.append(h('p', { class: 'muted small' }, `${cur.name} is thinking…`));
  } else if (myTurn) {
    const pend = state.pending;
    if (pend && pend.type === 'trade') {
      actions.append(renderTradePanel());
    } else if (pend && (pend.type === 'moveRobber' || pend.type === 'roadBuilding')) {
      actions.append(h('p', { class: 'muted small' }, pend.type === 'moveRobber' ? 'Tap a hex to move the robber there.' : 'Tap a highlighted edge to place a free road.'));
      if (pend.type === 'roadBuilding') actions.append(h('button', { class: 'btn', onclick: () => dispatch({ type: 'skipRoadBuilding' }) }, 'Skip remaining roads'));
    } else if (!pend) {
      if (ui.mode) {
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
    }
  } else {
    const pend = state.pending;
    if (pend && pend.type === 'trade' && !state.players[pend.from].isBot) actions.append(renderTradePanel());
    else if (!cur.isBot) actions.append(h('p', { class: 'muted small' }, `Waiting for ${cur.name}.`));
    else actions.append(h('p', { class: 'muted small' }, `${cur.name} is playing…`));
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
    const row = h('div', { class: 'trade-row', style: { '--pc': colorOf(state, pid) } }, h('span', { class: 'dot' }), h('span', { class: 'trade-name' }, other.name));
    if (resp === null) {
      if (other.isBot) row.append(h('span', { class: 'muted small' }, 'thinking…'));
      else
        row.append(
          h('span', { class: 'trade-btns' },
            h('button', { class: 'btn small', onclick: () => dispatch({ type: 'respondTrade', player: pid, accept: false }) }, 'Decline'),
            h('button', { class: 'btn small btn-primary', onclick: () => dispatch({ type: 'respondTrade', player: pid, accept: true }) }, 'Accept'),
          ),
        );
    } else if (resp === 'accepted') {
      row.append(h('span', { class: 'ok' }, '✔ accepted'));
      if (!from.isBot) row.append(h('button', { class: 'btn small btn-primary', onclick: () => dispatch({ type: 'acceptTrade', partner: pid }) }, 'Trade'));
    } else row.append(h('span', { class: 'muted' }, '✕ declined'));
    rows.append(row);
  }
  box.append(rows);
  if (!from.isBot) box.append(h('button', { class: 'btn btn-wide', onclick: () => dispatch({ type: 'cancelTrade' }) }, 'Withdraw offer'));
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
  showModal({
    title: 'Menu',
    body: h('div', { class: 'menu-list' },
      h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); costsModal(); } }, '🏗️ Building costs'),
      h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); rulesModal(); } }, '📖 Rules summary'),
      h('button', { class: 'btn btn-wide', onclick: () => { closeModal(); openFullLog(); } }, '📜 Full log'),
      h('button', { class: 'btn btn-wide btn-danger', onclick: confirmNewGame }, '🔄 New game'),
    ),
    actions: [{ label: 'Close', onClick: closeModal }],
  });
}

function confirmNewGame() {
  showModal({
    title: 'Abandon this game?',
    body: h('p', {}, 'The current game will be discarded.'),
    actions: [
      { label: 'Keep playing', onClick: closeModal },
      { label: 'New game', onClick: newGameFromMenu, danger: true },
    ],
  });
}

function newGameFromMenu() {
  clearSave();
  state = null;
  ui.botToken++;
  render();
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
      gameOverModal(state, newGameFromMenu, closeModal);
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
    if (entry) discardModal(state, req, entry.count, dispatch);
  } else if (pend.type === 'steal' && state.turn.player === req) {
    stealModal(state, pend.candidates, dispatch);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const saved = loadSave();
if (saved && saved.state.phase !== 'ended' && new URLSearchParams(location.search).get('new') === null) {
  // Show the setup screen with a resume option; players choose.
  renderSetupScreen();
} else {
  renderSetupScreen();
}

// Keep a reference for debugging in the console.
window.__catan = { get state() { return state; }, dispatch };
