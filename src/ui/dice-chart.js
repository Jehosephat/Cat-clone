// Dice distribution at the end of a game: a column chart of the totals rolled (2..12)
// against the expected count for that many rolls, plus a table view of the same numbers.
import { h } from './dom.js';
import { colorOf } from './board-svg.js';

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
