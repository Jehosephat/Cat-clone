// End-of-game statistics: the dice distribution (totals rolled against the expected
// count) and resource production per player, each with a table view of the same numbers.
import { h } from './dom.js';
import { colorOf } from './board-svg.js';
import { RESOURCES, RESOURCE_ICON, RESOURCE_LABEL } from '../constants.js';
import { emptyResources, totalResources } from '../rules.js';

const COLORS = { rolled: '#3f86cc', seven: '#b3861f' }; // validated for the dark panel surface
const SURFACE = '#16283d';

/** Probability of each two-dice total. */
export function expectedShare(total) {
  return (6 - Math.abs(7 - total)) / 36;
}

export function diceSummary(state) {
  const rolls = (state.stats && state.stats.rolls) || new Array(13).fill(0);
  const n = rolls.reduce((a, b) => a + b, 0);
  const totals = [];
  for (let t = 2; t <= 12; t++) totals.push({ total: t, count: rolls[t], expected: n * expectedShare(t) });
  const playerRolls = (state.stats && state.stats.playerRolls) || state.players.map(() => new Array(13).fill(0));
  const players = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    rolls: playerRolls[p.id].reduce((a, b) => a + b, 0),
    sevens: playerRolls[p.id][7],
  }));
  return { n, totals, players };
}

function niceMax(v) {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}

export function renderDiceStats(state) {
  const { n, totals, players } = diceSummary(state);
  const root = h('div', { class: 'dice-stats' });
  if (n === 0) {
    root.append(h('p', { class: 'muted' }, 'No dice were rolled in this game.'));
    return root;
  }
  const maxCount = Math.max(...totals.map((t) => Math.max(t.count, t.expected)));
  const yMax = niceMax(Math.ceil(maxCount));
  const W = 360;
  const H = 210;
  const pad = { top: 22, right: 10, bottom: 28, left: 28 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const slot = plotW / 11;
  const barW = Math.min(24, slot * 0.62);
  const y = (v) => pad.top + plotH - (v / yMax) * plotH;
  const x = (i) => pad.left + slot * i + slot / 2;

  let selected = null;
  const svg = h('svg:svg', { viewBox: `0 0 ${W} ${H}`, class: 'dice-chart', role: 'img', 'aria-label': `Dice totals rolled, ${n} rolls` });

  const draw = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    // Gridlines: baseline, half, top (hairline, recessive).
    const ticks = [0, yMax / 2, yMax].filter((v, i, a) => a.indexOf(v) === i);
    for (const v of ticks) {
      svg.append(h('svg:line', { x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v), stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 1 }));
      svg.append(h('svg:text', { x: pad.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-tick' }, Number.isInteger(v) ? v : v.toFixed(1)));
    }
    const maxTotal = totals.reduce((m, t) => (t.count > m.count ? t : m), totals[0]);
    totals.forEach((t, i) => {
      const cx = x(i);
      const fill = t.total === 7 ? COLORS.seven : COLORS.rolled;
      const top = y(t.count);
      const base = y(0);
      const r = Math.min(4, Math.max(0, (base - top) / 2));
      // Rounded data end, square at the baseline.
      const d = `M ${cx - barW / 2} ${base} V ${top + r} Q ${cx - barW / 2} ${top} ${cx - barW / 2 + r} ${top} H ${cx + barW / 2 - r} Q ${cx + barW / 2} ${top} ${cx + barW / 2} ${top + r} V ${base} Z`;
      const g = h('svg:g', { class: `chart-col ${selected === t.total ? 'selected' : ''}`, onclick: () => { selected = selected === t.total ? null : t.total; draw(); } });
      g.append(h('svg:rect', { x: cx - slot / 2, y: pad.top, width: slot, height: plotH, fill: 'rgba(0,0,0,0.001)' })); // hit target bigger than the mark
      if (t.count > 0) g.append(h('svg:path', { d, fill, opacity: selected && selected !== t.total ? 0.55 : 1 }));
      g.append(h('svg:title', {}, `${t.total}: rolled ${t.count} times, expected ${t.expected.toFixed(1)}`));
      // Expected marker with a 2px surface ring.
      g.append(h('svg:circle', { cx, cy: y(t.expected), r: 5.5, fill: SURFACE }));
      g.append(h('svg:circle', { cx, cy: y(t.expected), r: 3.5, fill: 'none', stroke: '#eef3f8', 'stroke-width': 1.6 }));
      // Direct label on the most-rolled total only; everything else lives in the tooltip and table.
      if (t === maxTotal && t.count > 0 && selected === null) svg.append(h('svg:text', { x: cx, y: top - 6, 'text-anchor': 'middle', class: 'chart-label' }, t.count));
      svg.append(h('svg:text', { x: cx, y: H - pad.bottom + 16, 'text-anchor': 'middle', class: `chart-tick ${t.total === 7 ? 'strong' : ''}` }, t.total));
      svg.append(g);
    });
    if (selected !== null) {
      const t = totals.find((q) => q.total === selected);
      const i = selected - 2;
      const cx = x(i);
      const label = `${t.total}: ${t.count} rolled · ${t.expected.toFixed(1)} expected`;
      const w = label.length * 5.6 + 14;
      const bx = Math.min(Math.max(cx - w / 2, pad.left), W - pad.right - w);
      const by = Math.max(2, y(Math.max(t.count, t.expected)) - 30);
      svg.append(h('svg:rect', { x: bx, y: by, width: w, height: 20, rx: 5, fill: '#1e3650', stroke: 'rgba(255,255,255,0.2)' }));
      svg.append(h('svg:text', { x: bx + w / 2, y: by + 14, 'text-anchor': 'middle', class: 'chart-tooltip' }, label));
    }
  };
  draw();

  const sevens = totals[5].count;
  const headline = h('div', { class: 'dice-headline' },
    h('div', { class: 'stat-tile' }, h('div', { class: 'stat-label' }, 'Rolls'), h('div', { class: 'stat-value' }, n)),
    h('div', { class: 'stat-tile' }, h('div', { class: 'stat-label' }, 'Sevens'), h('div', { class: 'stat-value' }, sevens), h('div', { class: 'stat-sub muted small' }, `expected ${(n / 6).toFixed(1)}`)),
    h('div', { class: 'stat-tile' }, h('div', { class: 'stat-label' }, 'Most rolled'), h('div', { class: 'stat-value' }, totals.reduce((m, t) => (t.count > m.count ? t : m), totals[0]).total)),
  );
  const legend = h('div', { class: 'chart-legend' },
    h('span', {}, h('span', { class: 'swatch', style: { background: COLORS.rolled } }), 'Rolled'),
    h('span', {}, h('span', { class: 'swatch', style: { background: COLORS.seven } }), '7 (robber)'),
    h('span', {}, h('span', { class: 'swatch ring' }), 'Expected'),
  );

  // Table view of the same numbers, plus who rolled what.
  const table = h('table', { class: 'cost-table dice-table', hidden: true },
    h('thead', {}, h('tr', {}, h('th', {}, 'Total'), h('th', {}, 'Rolled'), h('th', {}, 'Expected'), h('th', {}, 'Share'))),
    h('tbody', {}, totals.map((t) => h('tr', { class: t.total === 7 ? 'strong' : '' }, h('td', {}, t.total), h('td', {}, t.count), h('td', {}, t.expected.toFixed(1)), h('td', {}, `${((100 * t.count) / n).toFixed(0)}%`)))),
  );
  const perPlayer = h('div', { class: 'dice-players' },
    players.map((p) => h('span', { class: 'dice-player' }, h('span', { class: 'dot', style: { background: colorOf(state, p.id) } }), `${p.name}: ${p.rolls} rolls, ${p.sevens} seven${p.sevens === 1 ? '' : 's'}`)),
  );
  const toggle = h('button', { class: 'btn small', onclick: () => { table.hidden = !table.hidden; toggle.textContent = table.hidden ? 'Show table' : 'Hide table'; } }, 'Show table');
  root.append(headline, svg, legend, h('p', { class: 'muted small' }, 'Tap a column for its numbers. Rings show how often each total should come up over this many rolls.'), perPlayer, h('div', { class: 'dice-actions' }, toggle), table);
  return root;
}

// Stack order and colors chosen for adjacent-segment legibility on the dark surface
// (validated, including colorblind separation); the 2px gaps and legend carry the rest.
const PRODUCTION_ORDER = ['ore', 'brick', 'wool', 'grain', 'lumber'];
const PRODUCTION_COLORS = { ore: '#3987e5', brick: '#d95926', wool: '#199e70', grain: '#c98500', lumber: '#008300' };

export function productionSummary(state) {
  const stats = state.stats || {};
  const production = stats.production || state.players.map(() => emptyResources());
  const robbed = stats.robbed || state.players.map(() => emptyResources());
  const players = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    produced: production[p.id] || emptyResources(),
    total: totalResources(production[p.id] || emptyResources()),
    robbed: totalResources(robbed[p.id] || emptyResources()),
  }));
  const byResource = emptyResources();
  for (const p of players) for (const r of RESOURCES) byResource[r] += p.produced[r];
  return { players, byResource, total: totalResources(byResource) };
}

export function renderProductionStats(state) {
  const { players, byResource, total } = productionSummary(state);
  const root = h('div', { class: 'dice-stats' });
  if (total === 0) {
    root.append(h('p', { class: 'muted' }, 'No resources were produced by the dice in this game.'));
    return root;
  }
  const top = players.reduce((m, p) => (p.total > m.total ? p : m), players[0]);
  const topRes = RESOURCES.reduce((m, r) => (byResource[r] > byResource[m] ? r : m), RESOURCES[0]);
  root.append(
    h('div', { class: 'dice-headline' },
      h('div', { class: 'stat-tile' }, h('div', { class: 'stat-label' }, 'Produced'), h('div', { class: 'stat-value' }, total)),
      h('div', { class: 'stat-tile' }, h('div', { class: 'stat-label' }, 'Top producer'), h('div', { class: 'stat-value small-value' }, top.name), h('div', { class: 'stat-sub muted small' }, `${top.total} cards`)),
      h('div', { class: 'stat-tile' }, h('div', { class: 'stat-label' }, 'Most common'), h('div', { class: 'stat-value' }, RESOURCE_ICON[topRes]), h('div', { class: 'stat-sub muted small' }, `${RESOURCE_LABEL[topRes]} ${byResource[topRes]}`)),
    ),
  );

  const W = 360;
  const rowH = 36;
  const pad = { top: 26, right: 34, bottom: 22, left: 78 }; // left: room for the player name; top: room for a tooltip
  const H = pad.top + rowH * players.length + pad.bottom;
  const plotW = W - pad.left - pad.right;
  const maxTotal = Math.max(...players.map((p) => p.total), 1);
  const xMax = niceMax(maxTotal);
  const x = (v) => pad.left + (v / xMax) * plotW;
  const barH = 22;
  const gap = 2;
  let selected = null; // {pid, res}
  const svg = h('svg:svg', { viewBox: `0 0 ${W} ${H}`, class: 'dice-chart production-chart', role: 'img', 'aria-label': 'Resources produced per player' });

  const draw = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ticks = [0, xMax / 2, xMax].filter((v, i, a) => a.indexOf(v) === i);
    for (const v of ticks) {
      svg.append(h('svg:line', { x1: x(v), x2: x(v), y1: pad.top, y2: H - pad.bottom, stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 1 }));
      svg.append(h('svg:text', { x: x(v), y: H - pad.bottom + 14, 'text-anchor': 'middle', class: 'chart-tick' }, Number.isInteger(v) ? v : v.toFixed(1)));
    }
    players.forEach((p, row) => {
      const yTop = pad.top + row * rowH + (rowH - barH) / 2;
      const g = h('svg:g', { class: 'chart-row' });
      // Player name with a color dot, inside the SVG so it stays aligned with the bar at any width.
      g.append(h('svg:circle', { cx: 8, cy: yTop + barH / 2, r: 4.5, fill: colorOf(state, p.id), stroke: 'rgba(0,0,0,0.5)', 'stroke-width': 1 }));
      const shown = p.name.length > 9 ? `${p.name.slice(0, 8)}…` : p.name;
      g.append(h('svg:text', { x: 17, y: yTop + barH / 2 + 4, class: 'chart-name' }, shown, h('svg:title', {}, p.name)));
      let cursor = 0;
      let drawn = 0;
      const segs = PRODUCTION_ORDER.filter((r) => p.produced[r] > 0);
      segs.forEach((r, i) => {
        const v = p.produced[r];
        const x0 = x(cursor) + (drawn > 0 ? gap : 0);
        const x1 = x(cursor + v);
        const last = i === segs.length - 1;
        const w = Math.max(0, x1 - x0);
        const rr = last ? Math.min(4, w / 2) : 0;
        const d = last
          ? `M ${x0} ${yTop} H ${x1 - rr} Q ${x1} ${yTop} ${x1} ${yTop + rr} V ${yTop + barH - rr} Q ${x1} ${yTop + barH} ${x1 - rr} ${yTop + barH} H ${x0} Z`
          : `M ${x0} ${yTop} H ${x1} V ${yTop + barH} H ${x0} Z`;
        const dim = selected && !(selected.pid === p.id && selected.res === r);
        const seg = h('svg:g', { class: 'chart-col', onclick: () => { selected = selected && selected.pid === p.id && selected.res === r ? null : { pid: p.id, res: r }; draw(); } });
        seg.append(h('svg:path', { d, fill: PRODUCTION_COLORS[r], opacity: dim ? 0.45 : 1 }));
        seg.append(h('svg:title', {}, `${p.name} · ${RESOURCE_LABEL[r]}: ${v}`));
        g.append(seg);
        cursor += v;
        drawn += 1;
      });
      // Total at the bar end (text token, never the series color).
      g.append(h('svg:text', { x: x(p.total) + 6, y: yTop + barH / 2 + 4, class: 'chart-label' }, p.total));
      svg.append(g);
    });
    if (selected) {
      const p = players.find((q) => q.id === selected.pid);
      const row = players.indexOf(p);
      const label = `${p.name} · ${RESOURCE_ICON[selected.res]} ${RESOURCE_LABEL[selected.res]}: ${p.produced[selected.res]}`;
      const w = label.length * 5.8 + 14;
      const before = PRODUCTION_ORDER.slice(0, PRODUCTION_ORDER.indexOf(selected.res)).reduce((a, r) => a + p.produced[r], 0);
      const cx = x(before + p.produced[selected.res] / 2);
      const bx = Math.min(Math.max(cx - w / 2, 2), W - 2 - w);
      const yTop = pad.top + row * rowH + (rowH - barH) / 2;
      const by = yTop - 24;
      svg.append(h('svg:rect', { x: bx, y: by, width: w, height: 20, rx: 5, fill: '#1e3650', stroke: 'rgba(255,255,255,0.2)' }));
      svg.append(h('svg:text', { x: bx + w / 2, y: by + 14, 'text-anchor': 'middle', class: 'chart-tooltip' }, label));
    }
  };
  draw();

  const chartRow = svg;
  const legend = h('div', { class: 'chart-legend' }, PRODUCTION_ORDER.map((r) => h('span', {}, h('span', { class: 'swatch', style: { background: PRODUCTION_COLORS[r] } }), `${RESOURCE_ICON[r]} ${RESOURCE_LABEL[r]}`)));
  const table = h('table', { class: 'cost-table dice-table', hidden: true },
    h('thead', {}, h('tr', {}, h('th', {}, 'Player'), RESOURCES.map((r) => h('th', { title: RESOURCE_LABEL[r] }, RESOURCE_ICON[r])), h('th', {}, 'Total'), h('th', { title: 'Production blocked by the robber' }, '🚫'))),
    h('tbody', {}, players.map((p) => h('tr', {}, h('td', {}, p.name), RESOURCES.map((r) => h('td', {}, p.produced[r])), h('td', { class: 'strong' }, p.total), h('td', {}, p.robbed)))),
  );
  const robbedLine = players.filter((p) => p.robbed > 0).map((p) => `${p.name} ${p.robbed}`);
  const toggle = h('button', { class: 'btn small', onclick: () => { table.hidden = !table.hidden; toggle.textContent = table.hidden ? 'Show table' : 'Hide table'; } }, 'Show table');
  root.append(
    chartRow,
    legend,
    h('p', { class: 'muted small' }, `Cards received from dice rolls (starting resources, trades and cards excluded). Tap a segment for its number.${robbedLine.length ? ` Blocked by the robber: ${robbedLine.join(', ')}.` : ''}`),
    h('div', { class: 'dice-actions' }, toggle),
    table,
  );
  return root;
}

/** Both statistics sections, for the end-of-game view. */
export function renderGameStats(state) {
  return h('div', { class: 'game-stats' },
    h('h3', { class: 'stats-heading' }, '🎲 Dice'),
    renderDiceStats(state),
    h('h3', { class: 'stats-heading' }, '🌾 Resource production'),
    renderProductionStats(state),
  );
}
