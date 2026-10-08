import { h, clear } from './dom.js';
import { RESOURCES, RESOURCE_ICON, RESOURCE_LABEL, DEV_CARD_LABEL, DEV_CARD_TEXT, COSTS } from '../constants.js';
import { tradeRatio, countVictoryPoints, playableDevCards } from '../game.js';
import { emptyResources, totalResources, handSize } from '../rules.js';

let modalRoot = null;

export function initModals(root) {
  modalRoot = root;
}

export function closeModal() {
  if (!modalRoot) return;
  clear(modalRoot);
  modalRoot.classList.remove('open');
  delete modalRoot.dataset.tag;
}

/** Tag of the open modal ('' when it has none), or null when no modal is open. */
export function currentModalTag() {
  if (!modalRoot || !modalRoot.classList.contains('open')) return null;
  return modalRoot.dataset.tag || '';
}

/** Show a modal. opts: {title, body: Node|Node[], actions: [{label, onClick, primary, disabled}], dismissible, className, tag} */
export function showModal(opts) {
  clear(modalRoot);
  if (opts.tag) modalRoot.dataset.tag = opts.tag;
  else delete modalRoot.dataset.tag;
  const card = h('div', { class: `modal-card ${opts.className || ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Dialog' });
  if (opts.title) card.append(h('h2', { class: 'modal-title' }, opts.title));
  const body = h('div', { class: 'modal-body' }, opts.body);
  card.append(body);
  if (opts.actions && opts.actions.length) {
    card.append(
      h(
        'div',
        { class: 'modal-actions' },
        opts.actions.map((a) =>
          h('button', { class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`, disabled: a.disabled, onclick: a.onClick }, a.label),
        ),
      ),
    );
  }
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (ev) => ev.target === backdrop && opts.dismissible !== false && closeModal() }, card);
  modalRoot.append(backdrop);
  modalRoot.classList.add('open');
  return { card, body };
}

export function resourceChip(res, n, extra = '') {
  return h('span', { class: `res-chip res-${res} ${extra}` }, h('span', { class: 'res-icon' }, RESOURCE_ICON[res]), n !== undefined ? h('span', { class: 'res-count' }, n) : null);
}

export function costLine(cost) {
  return h('span', { class: 'cost' }, Object.entries(cost).map(([r, n]) => resourceChip(r, n)));
}

/**
 * Resource stepper row. limits: {res: max}. Returns {el, values, onChange}.
 */
export function stepperRow(label, limits, onChange, { max = Infinity, showMax = true } = {}) {
  const values = emptyResources();
  const el = h('div', { class: 'stepper-row' });
  const render = () => {
    clear(el);
    if (label) el.append(h('div', { class: 'stepper-label' }, label));
    const row = h('div', { class: 'steppers' });
    const total = totalResources(values);
    for (const r of RESOURCES) {
      const lim = limits[r] ?? 0;
      row.append(
        h(
          'div',
          { class: `stepper res-${r} ${lim === 0 ? 'stepper-empty' : ''}` },
          h('div', { class: 'stepper-icon' }, RESOURCE_ICON[r]),
          h('div', { class: 'stepper-ctrl' },
            h('button', { class: 'stepper-btn', disabled: values[r] <= 0, onclick: () => { values[r]--; render(); onChange(values); } }, '−'),
            h('span', { class: 'stepper-val' }, values[r]),
            h('button', { class: 'stepper-btn', disabled: values[r] >= lim || total >= max, onclick: () => { values[r]++; render(); onChange(values); } }, '+'),
          ),
          showMax ? h('div', { class: 'stepper-max' }, lim === Infinity ? '' : `of ${lim}`) : null,
        ),
      );
    }
    el.append(row);
  };
  render();
  return { el, values, reset: () => { for (const r of RESOURCES) values[r] = 0; render(); } };
}

export function discardModal(state, pid, count, dispatch) {
  const p = state.players[pid];
  let picked;
  const update = () => {
    const n = totalResources(picked);
    confirmBtn.disabled = n !== count;
    confirmBtn.textContent = `Discard ${n}/${count}`;
  };
  const stepper = stepperRow(null, p.resources, () => update(), { max: count });
  picked = stepper.values;
  const confirmBtn = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => dispatch({ type: 'discard', player: pid, resources: { ...picked } }) }, `Discard 0/${count}`);
  showModal({
    title: `${p.name}: discard ${count} cards`,
    body: [h('p', { class: 'muted' }, 'A 7 was rolled. You hold more than ' + state.options.discardLimit + ' cards, so you must discard half of them.'), stepper.el, h('div', { class: 'modal-actions' }, confirmBtn)],
    dismissible: false,
    tag: 'discard',
  });
}

export function stealModal(state, candidates, dispatch) {
  showModal({
    title: 'Steal from whom?',
    body: h(
      'div',
      { class: 'choice-list' },
      candidates.map((pid) => {
        const p = state.players[pid];
        return h('button', { class: 'btn choice', onclick: () => dispatch({ type: 'steal', victim: pid }) }, h('span', { class: 'dot', style: { background: colorHex(state, pid) } }), `${p.name} (${handSize(p)} cards)`);
      }),
    ),
    dismissible: false,
    tag: 'steal',
  });
}

export function colorHex(state, pid) {
  const map = { red: '#d64545', blue: '#3b6fd6', white: '#f3f1ea', orange: '#f0932b' };
  return map[state.players[pid].color] || '#999';
}

export function yearOfPlentyModal(state, card, dispatch) {
  const limits = {};
  for (const r of RESOURCES) limits[r] = state.bank[r];
  const stepper = stepperRow('Take 2 resources from the bank', limits, () => update(), { max: 2 });
  const btn = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => {
    const picks = [];
    for (const r of RESOURCES) for (let i = 0; i < stepper.values[r]; i++) picks.push(r);
    dispatch({ type: 'playDevCard', card: card.id, resources: picks });
  } }, 'Take');
  const update = () => { btn.disabled = totalResources(stepper.values) !== 2; };
  showModal({ title: 'Year of Plenty', body: [stepper.el, h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), btn)] });
}

export function monopolyModal(card, dispatch) {
  showModal({
    title: 'Monopoly: choose a resource',
    body: h('div', { class: 'choice-list' }, RESOURCES.map((r) => h('button', { class: `btn choice res-${r}`, onclick: () => dispatch({ type: 'playDevCard', card: card.id, resource: r }) }, RESOURCE_ICON[r], ' ', RESOURCE_LABEL[r]))),
    actions: [{ label: 'Cancel', onClick: closeModal }],
  });
}

export function devCardsModal(state, pid, { onPlay, canPlay }) {
  const p = state.players[pid];
  const playable = canPlay ? playableDevCards(state).map((c) => c.id) : [];
  const groups = {};
  for (const c of p.devCards) (groups[c.type] = groups[c.type] || []).push(c);
  const body = [];
  if (!p.devCards.length) body.push(h('p', { class: 'muted' }, 'You have no development cards.'));
  for (const [type, cards] of Object.entries(groups)) {
    const first = cards.find((c) => playable.includes(c.id)) || cards[0];
    const isPlayable = playable.includes(first.id);
    let why = '';
    if (!isPlayable && type !== 'victoryPoint' && canPlay !== false) {
      if (state.turn.devPlayed) why = 'Already played a card this turn';
      else if (cards.every((c) => c.boughtTurn === state.turn.number)) why = 'Bought this turn';
      else if (state.pending) why = 'Finish the current action first';
    }
    body.push(
      h(
        'div',
        { class: `dev-card dev-${type}` },
        h('div', { class: 'dev-head' }, h('strong', {}, DEV_CARD_LABEL[type]), h('span', { class: 'pill' }, `×${cards.length}`)),
        h('p', { class: 'dev-text' }, DEV_CARD_TEXT[type]),
        type !== 'victoryPoint'
          ? h('div', { class: 'dev-actions' }, why ? h('span', { class: 'muted small' }, why) : null, h('button', { class: 'btn btn-primary small', disabled: !isPlayable, onclick: () => onPlay(first) }, 'Play'))
          : h('div', { class: 'dev-actions' }, h('span', { class: 'muted small' }, 'Counts automatically toward victory.')),
      ),
    );
  }
  showModal({ title: `${p.name}'s development cards`, body, actions: [{ label: 'Close', onClick: closeModal }] });
}

export function tradeModal(state, pid, dispatch) {
  const p = state.players[pid];
  let tab = 'players';
  const { body } = showModal({ title: 'Trade', body: [], className: 'modal-wide' });
  const render = () => {
    clear(body);
    const tabs = h(
      'div',
      { class: 'tabs' },
      h('button', { class: `tab ${tab === 'players' ? 'active' : ''}`, onclick: () => { tab = 'players'; render(); } }, 'With players'),
      h('button', { class: `tab ${tab === 'bank' ? 'active' : ''}`, onclick: () => { tab = 'bank'; render(); } }, 'Bank & harbors'),
    );
    body.append(tabs);
    if (tab === 'players') {
      const offer = stepperRow('You give', p.resources, () => update());
      const limits = {};
      for (const r of RESOURCES) limits[r] = 19;
      const request = stepperRow('You want', limits, () => update(), { showMax: false });
      const btn = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => dispatch({ type: 'proposeTrade', offer: { ...offer.values }, request: { ...request.values } }) }, 'Propose trade');
      const update = () => {
        const o = totalResources(offer.values);
        const q = totalResources(request.values);
        const overlap = RESOURCES.some((r) => offer.values[r] > 0 && request.values[r] > 0);
        btn.disabled = o === 0 || q === 0 || overlap;
      };
      body.append(offer.el, request.el, h('p', { class: 'muted small' }, 'Other players will be asked to accept or decline. You pick who to trade with.'), h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), btn));
    } else {
      let giveRes = RESOURCES.find((r) => p.resources[r] >= tradeRatio(state, pid, r)) || null;
      let getRes = null;
      const box = h('div', {});
      const renderBank = () => {
        clear(box);
        box.append(h('div', { class: 'stepper-label' }, 'Give'));
        box.append(
          h(
            'div',
            { class: 'choice-row' },
            RESOURCES.map((r) => {
              const ratio = tradeRatio(state, pid, r);
              const ok = p.resources[r] >= ratio;
              return h('button', { class: `btn choice-sq res-${r} ${giveRes === r ? 'selected' : ''}`, disabled: !ok, onclick: () => { giveRes = r; renderBank(); } }, h('span', { class: 'big' }, RESOURCE_ICON[r]), h('span', { class: 'small' }, `${ratio}:1`), h('span', { class: 'small muted' }, `have ${p.resources[r]}`));
            }),
          ),
        );
        box.append(h('div', { class: 'stepper-label' }, 'Receive'));
        box.append(
          h(
            'div',
            { class: 'choice-row' },
            RESOURCES.map((r) =>
              h('button', { class: `btn choice-sq res-${r} ${getRes === r ? 'selected' : ''}`, disabled: r === giveRes || state.bank[r] < 1, onclick: () => { getRes = r; renderBank(); } }, h('span', { class: 'big' }, RESOURCE_ICON[r]), h('span', { class: 'small muted' }, `bank ${state.bank[r]}`)),
            ),
          ),
        );
        const ratio = giveRes ? tradeRatio(state, pid, giveRes) : null;
        box.append(
          h('div', { class: 'modal-actions' },
            h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
            h('button', { class: 'btn btn-primary', disabled: !giveRes || !getRes, onclick: () => dispatch({ type: 'bankTrade', give: giveRes, get: getRes }) }, giveRes && getRes ? `Trade ${ratio} ${RESOURCE_ICON[giveRes]} for 1 ${RESOURCE_ICON[getRes]}` : 'Trade'),
          ),
        );
      };
      renderBank();
      body.append(box);
    }
  };
  render();
}

export function gameOverModal(state, onNewGame, onReview, newGameLabel = 'New game', onStats = null) {
  const ranking = state.players
    .map((p) => ({ p, vp: countVictoryPoints(state, p.id) }))
    .sort((a, b) => b.vp - a.vp);
  showModal({
    title: `${state.players[state.winner].name} wins!`,
    body: h(
      'ol',
      { class: 'ranking' },
      ranking.map(({ p, vp }) =>
        h('li', {}, h('span', { class: 'dot', style: { background: colorHex(state, p.id) } }), h('strong', {}, p.name), ` – ${vp} VP`, p.devCards.filter((c) => c.type === 'victoryPoint').length ? h('span', { class: 'muted small' }, ` (${p.devCards.filter((c) => c.type === 'victoryPoint').length} hidden)`) : null),
      ),
    ),
    actions: [
      { label: 'Review board', onClick: onReview },
      onStats ? { label: '🎲 Dice stats', onClick: onStats } : null,
      { label: newGameLabel, onClick: onNewGame, primary: true },
    ].filter(Boolean),
    dismissible: false,
    tag: 'gameover',
  });
}

export function costsModal() {
  const rows = [
    ['Road', COSTS.road, '0 VP'],
    ['Settlement', COSTS.settlement, '1 VP'],
    ['City', COSTS.city, '2 VP'],
    ['Development card', COSTS.devCard, ''],
  ];
  showModal({
    title: 'Building costs',
    body: [
      h('table', { class: 'cost-table' }, rows.map(([name, cost, vp]) => h('tr', {}, h('td', {}, name), h('td', {}, costLine(cost)), h('td', { class: 'muted' }, vp)))),
      h('p', { class: 'muted small' }, 'Longest Road (5+ roads) and Largest Army (3+ knights) are each worth 2 VP. First to reach the target on their own turn wins.'),
    ],
    actions: [{ label: 'Close', onClick: closeModal }],
  });
}

export function rulesModal() {
  showModal({
    title: 'Rules summary',
    className: 'modal-wide',
    body: h('div', { class: 'rules' },
      h('h3', {}, 'Setup'),
      h('p', {}, 'Players place one settlement and one adjacent road in turn order, then a second pair in reverse order. The second settlement yields one resource from each adjacent hex. Settlements must be at least two edges apart.'),
      h('h3', {}, 'Your turn'),
      h('ol', {},
        h('li', {}, 'Roll the dice. Every settlement adjacent to a hex with that number produces 1 resource (cities 2). The robber blocks its hex.'),
        h('li', {}, 'On a 7, everyone with more than 7 cards discards half. You move the robber to a new hex and steal a random card from a player with a building there.'),
        h('li', {}, 'Trade with other players, or with the bank at 4:1 (3:1 or 2:1 with a harbor).'),
        h('li', {}, 'Build roads, settlements and cities, or buy development cards.'),
      ),
      h('h3', {}, 'Development cards'),
      h('p', {}, 'You may play one development card per turn (even before rolling), but not one bought this turn. Victory point cards stay hidden and count automatically.'),
      h('h3', {}, 'Winning'),
      h('p', {}, 'The first player to reach the target number of victory points on their own turn wins. If the bank cannot pay everyone for a roll, nobody receives that resource.'),
    ),
    actions: [{ label: 'Close', onClick: closeModal }],
  });
}
