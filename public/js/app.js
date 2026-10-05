import { predictGame, predictionSettings, expectedValue, impliedProbability, formatDecimalOdds, matchOdds } from './model.js';
import { expectedGoals, poissonMatrix, matchupProbabilities, totalGoalsDistribution, probabilityOverLine, classifyRisk } from './quants.js';
import { createResearchWorkspace } from './research.js';
import { createAuditWorkspace } from './audit.js';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const percent = (value, digits = 0) => Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
const signed = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}%` : '--';
const formatDate = (value, options = {}) => Number.isNaN(new Date(value).getTime()) ? '--' : new Intl.DateTimeFormat('en-US', options).format(new Date(value));
const time = (value) => formatDate(value, { hour: 'numeric', minute: '2-digit' });
const shortDate = (value) => formatDate(value, { month: 'short', day: 'numeric' });
const logo = (team, extraClass = '') => /^https:\/\/a\.espncdn\.com\//.test(team.logo || '') ? `<img class="team-logo ${extraClass}" src="${escapeHtml(team.logo)}" alt="${escapeHtml(team.shortName || team.name)} logo" loading="lazy" width="48" height="48">` : `<span class="team-logo ${extraClass}">${escapeHtml(team.abbreviation || '--')}</span>`;
const empty = (heading, message, symbol = 'chart-no-axes-combined') => `<div class="empty-state">${icon(symbol)}<h3>${escapeHtml(heading)}</h3><p>${escapeHtml(message)}</p></div>`;
const storage = { get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} } };
const savedItems = storage.get('sportsstat-saved', []);
const state = {
  sport: 'nfl', view: 'dashboard', games: [], predictions: new Map(), histories: new Map(), summaries: new Map(), lineHistories: new Map(),
  injuryTeams: [], injuriesAt: null, injuriesError: '',
  odds: [], oddsConfigured: false, oddsAt: null, oddsError: '', status: null, loadedAt: null, selected: null, loading: false, analyzing: false,
  error: '', partial: false, revision: 0, controller: null, search: '', filter: 'all', saved: new Set(Array.isArray(savedItems) ? savedItems : []),
  window: 10, calibration: new Map(),
};
const historyCache = new Map();
let toastTimer;
const research = createResearchWorkspace({ state, api, render, openDialog, icons, toast, onWindowChange: recomputePredictions });
const audit = createAuditWorkspace({ state, api, render, icons, toast, openDialog });

function biasFactor() { return state.calibration.get(state.sport)?.biasFactor || 0; }

function decayFor(gameId) {
  return predictionSettings(gameId, state.calibration.get(state.sport)).decay;
}

function sosWeightFor(gameId) {
  return predictionSettings(gameId, state.calibration.get(state.sport)).sosWeight;
}

function applyPrediction(game, prediction) {
  state.predictions.set(game.id, prediction);
}

function recomputePredictions() {
  for (const game of state.games) {
    const home = state.histories.get(game.home.id);
    const away = state.histories.get(game.away.id);
    if (home && away) applyPrediction(game, predictGame(game, home, away, state.window, biasFactor(), decayFor(game.id), sosWeightFor(game.id)));
  }
}


async function loadCalibration(revision = state.revision) {
  try {
    const stats = await api(`predictions/stats?sport=${state.sport}`);
    if (revision === state.revision) state.calibration.set(state.sport, stats);
  } catch { /* calibration is an enhancement; predictions still work without it */ }
}

function icons() { window.lucide?.createIcons(); }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500); }
function selectionGame() { return state.games.find((game) => game.id === state.selected) || state.games.find((game) => game.state === 'in') || state.games[0]; }
function savedKey(game) { return `${state.sport}:${game.id}`; }
function bestPrice(game, prediction) {
  return matchOdds(game, state.odds).filter((price) => price.side === prediction?.selection).sort((first, second) => second.price - first.price)[0];
}
function signals() {
  return state.games.filter((game) => !game.completed).map((game) => {
    const prediction = state.predictions.get(game.id);
    const price = bestPrice(game, prediction);
    const edge = Number.isFinite(prediction?.probability) && Number.isFinite(price?.price) ? (prediction.probability - impliedProbability(price.price)) * 100 : null;
    const risk = Number.isFinite(prediction?.probability) && Number.isFinite(price?.price) ? classifyRisk(prediction.probability, price.price) : null;
    return { game, prediction, price, ev: expectedValue(prediction?.probability, price?.price), edge, risk };
  }).sort((first, second) => (second.prediction?.probability || 0) - (first.prediction?.probability || 0));
}
function gameBadge(game) {
  return game.state === 'in' ? '<span class="live-badge"><span class="live-dot"></span> LIVE</span>' : `<span class="live-badge pre-badge">${game.completed ? 'FINAL' : escapeHtml(time(game.date))}</span>`;
}
function sectionTitle(title, symbol, extra = '', action = '') {
  return `<div class="section-heading"><div class="section-title">${symbol ? icon(symbol) : ''}<h2>${title}</h2>${extra}</div>${action}</div>`;
}
function renderMetrics() {
  const ready = signals().filter((signal) => signal.prediction?.probability != null);
  const average = ready.length ? ready.reduce((sum, signal) => sum + signal.prediction.probability, 0) / ready.length : null;
  const liveCount = state.games.filter((game) => game.state === 'in').length;
  const connected = Number(state.status?.espn.state === 'connected') + Number(state.status?.odds.state === 'connected');
  const metrics = [
    ['Games on the radar', 'radar', String(state.games.length).padStart(2, '0'), '', `<span class="positive">${liveCount ? `${liveCount} live now` : 'Schedule synced'}</span><span>across ${state.sport.toUpperCase()}</span>`, ''],
    ['Moneyline model signals', 'scan-line', String(ready.length).padStart(2, '0'), '', `<span class="positive">${ready.filter((signal) => signal.ev > 0).length} positive EV</span><span>${state.analyzing ? 'Analyzing history...' : 'moneyline market'}</span>`, ''],
    ['Avg. model probability', 'chart-no-axes-combined', percent(average, 1), '', '<span>Uncalibrated baseline estimate</span>', ''],
    ['Data feeds connected', 'cable', String(connected).padStart(2, '0'), '/ 02', `<span class="live-dot"></span><span>${state.oddsConfigured ? 'ESPN + The Odds API' : 'ESPN · Odds key required'}</span>`, ''],
  ];
  return `<section class="metrics" aria-label="Workspace metrics">${metrics.map(([label, symbol, value, suffix, note, chart]) => `<article class="metric"><div class="metric-top"><span>${label}</span>${icon(symbol)}</div><div class="metric-value">${value}${suffix ? `<small>${suffix}</small>` : ''}</div><div class="metric-bottom">${note}</div>${chart}</article>`).join('')}</section>`;
}

function renderSpotlight(game, tracker = false) {
  if (!game) return empty('No scheduled games', 'Switch leagues to see other upcoming and live games.');
  return `<article class="match-spotlight"><div class="spotlight-header"><div class="spotlight-meta"><span class="spotlight-league">${state.sport.toUpperCase()}</span><span>/</span><span>${escapeHtml(shortDate(game.date))}</span><span>ESPN SCOREBOARD</span></div>${gameBadge(game)}</div><div class="spotlight-teams"><div class="spotlight-team">${logo(game.away)}<h3>${escapeHtml(game.away.name)}</h3><small>${escapeHtml(game.away.record)} overall</small></div><div class="score-block"><div class="score-line"><span>${game.state === 'pre' ? '' : game.away.score}</span><span class="score-separator">${game.state === 'pre' ? 'VS' : ':'}</span><span>${game.state === 'pre' ? '' : game.home.score}</span></div><small>${escapeHtml(game.state === 'pre' ? time(game.date) : game.detail)}</small></div><div class="spotlight-team">${logo(game.home)}<h3>${escapeHtml(game.home.name)}</h3><small>${escapeHtml(game.home.record)} overall</small></div></div><div class="spotlight-footer"><span>${icon('map-pin')}${escapeHtml(game.venue)}</span>${tracker ? '<span>ESPN · 30s refresh</span>' : `<button class="button button-primary" data-track="${escapeHtml(game.id)}">${game.state === 'in' ? 'Track match' : 'Match details'}${icon('arrow-up-right')}</button>`}</div></article>`;
}

function renderInsight() {
  const signal = signals().find((item) => item.prediction?.probability != null);
  const team = signal && signal.game[signal.prediction.selection];
  return `<article class="insight-panel"><div class="insight-kicker">${icon('sparkles')} THE MODEL SPOTLIGHT</div><h3>${team ? `${escapeHtml(team.shortName)} moneyline` : state.analyzing ? 'Finding the patterns' : 'Let the data decide'}</h3><p>${signal ? `${escapeHtml(signal.game.away.abbreviation)} @ ${escapeHtml(signal.game.home.abbreviation)} <span class="no-value">/</span> ${signal.prediction.sample}-game samples per team` : 'Signals appear when both teams have enough completed games.'}</p><div class="insight-stats"><div class="insight-stat"><span>Model probability</span><strong>${percent(signal?.prediction.probability, 1)}</strong></div><div class="insight-stat"><span>Expected value</span><strong>${signed(signal?.ev)}</strong></div></div><div class="insight-bottom"><span>Recent-form baseline</span><button ${signal ? `data-detail="${escapeHtml(signal.game.id)}"` : 'data-methodology'}>View analysis${icon('arrow-up-right')}</button></div></article>`;
}

function renderSignals(all = false) {
  let rows = signals();
  if (all) rows = rows.filter((item) => (!state.search || `${item.game.home.name} ${item.game.away.name}`.toLowerCase().includes(state.search.toLowerCase()))
    && (state.filter === 'all' || state.filter === 'positive' && item.ev > 0 || state.filter === 'strong' && item.prediction?.probability >= 0.65 || state.filter === 'mispriced' && item.risk?.mispriced || state.filter === 'saved' && state.saved.has(savedKey(item.game))));
  else rows = rows.slice(0, 5);
  if (!rows.length) return empty('No signals in this view', state.analyzing ? 'Historical results are still being analyzed.' : 'Choose another league or adjust your filters.');
  return `<div class="table-container"><table class="signal-table"><thead><tr><th>Matchup</th><th>Model pick</th><th>Probability</th>${all ? '<th>Best odds</th><th>Edge</th><th>Risk</th>' : ''}<th>EV</th><th><span class="sr-only">Save signal</span></th></tr></thead><tbody>${rows.map(({ game, prediction, price, ev, edge, risk }) => {
    const team = prediction?.selection ? game[prediction.selection] : null;
    return `<tr><td><button class="match-cell" data-detail="${escapeHtml(game.id)}">${logo(game.home)}<span><strong>${escapeHtml(game.away.abbreviation)} <span class="no-value">@</span> ${escapeHtml(game.home.abbreviation)}</strong><small>${game.state === 'in' ? `<span style="color:var(--green)">LIVE</span> · ${escapeHtml(game.detail)}` : `${escapeHtml(shortDate(game.date))} · ${escapeHtml(time(game.date))}`}</small></span></button></td>
      <td><button class="selection-name" data-detail="${escapeHtml(game.id)}">${team ? escapeHtml(team.shortName) : '--'}<small>${team ? 'Moneyline' : prediction ? 'Insufficient history' : state.analyzing ? 'Analyzing...' : 'History unavailable'}</small></button></td>
      <td>${team ? `<button class="probability-value" data-detail="${escapeHtml(game.id)}">${percent(prediction.probability, 1)}</button><div class="probability-track"><div class="probability-fill" style="width:${prediction.probability * 100}%"></div></div>` : '<span class="no-value">--</span>'}</td>
      ${all ? `<td><span class="selection-name">${price ? formatDecimalOdds(price.price) : '--'}<small>${price ? escapeHtml(price.book) : state.oddsConfigured ? 'No matched price' : 'Odds key required'}</small></span></td><td>${edge != null ? `<span class="ev-value ${edge < 0 ? 'negative' : ''}" title="Model probability minus the price's implied probability">${signed(edge)}pp</span>` : '<span class="no-value" title="A matching sportsbook price is required">--</span>'}</td><td>${risk ? `<span class="risk-tag risk-${risk.tier}" title="${risk.mispriced ? `Model rates this ${risk.tier}-risk, but the market's odds imply ${risk.byOdds}-risk` : `Model and market agree: ${risk.tier}-risk`}">${risk.tier}${risk.mispriced ? ' ⚠' : ''}</span>` : '<span class="no-value">--</span>'}</td>` : ''}
      <td>${ev != null ? `<span class="ev-value ${ev < 0 ? 'negative' : ''}">${signed(ev)}</span>` : '<span class="no-value" title="A matching sportsbook price is required">--</span>'}</td>
      <td><div class="signal-actions"><button class="icon-button watch-button ${state.saved.has(savedKey(game)) ? 'saved' : ''}" data-save="${escapeHtml(game.id)}" title="${state.saved.has(savedKey(game)) ? 'Unsave' : 'Save'} signal" aria-label="${state.saved.has(savedKey(game)) ? 'Unsave' : 'Save'} ${escapeHtml(game.home.shortName)} signal" aria-pressed="${state.saved.has(savedKey(game))}">${icon('bookmark')}</button><button class="${all ? 'button button-secondary' : 'icon-button'}" data-bet-game="${escapeHtml(game.id)}" title="Track Bet" aria-label="Track ${escapeHtml(game.home.shortName)} bet" ${!team ? 'disabled' : ''}>${icon('plus')}${all ? 'Track Bet' : ''}</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderPulse() {
  const games = state.games.filter((game) => game.state === 'in').slice(0, 3);
  if (!games.length) return empty('Waiting for tip-off', 'Live probabilities appear when the provider publishes them.', 'radio');
  return `<div class="pulse-list">${games.map((game) => {
    const points = state.summaries.get(game.id)?.probabilities || [];
    const home = points.at(-1)?.home;
    return `<div class="pulse-item"><div class="pulse-top"><span><span class="live-dot"></span> ${escapeHtml(game.detail)}</span><span>${state.sport.toUpperCase()}</span></div><button class="pulse-title" style="width:100%" data-track="${escapeHtml(game.id)}"><span>${escapeHtml(game.away.abbreviation)} <span class="no-value">vs</span> ${escapeHtml(game.home.abbreviation)}</span><strong>${game.away.score} : ${game.home.score}</strong></button><div class="pulse-progress"><span style="width:${Number.isFinite(home) ? (1 - home) * 100 : 50}%;opacity:${Number.isFinite(home) ? 1 : 0.15}"></span><span style="opacity:${Number.isFinite(home) ? 1 : 0.15}"></span></div><div class="pulse-caption"><span>${escapeHtml(game.away.abbreviation)} ${Number.isFinite(home) ? percent(1 - home) : '--'}</span><span>${escapeHtml(game.home.abbreviation)} ${percent(home)}</span></div></div>`;
  }).join('')}<button class="pulse-link" data-nav="tracker">Open live tracker${icon('arrow-right')}</button></div>`;
}

function renderUpcoming() {
  const upcoming = state.games.filter((game) => game.state === 'pre').slice(0, 3);
  if (!upcoming.length) return '';
  return `<section class="upcoming-section">${sectionTitle('Next on the schedule', '', '', '<button class="button button-text" data-nav="tracker">Full schedule ' + icon('arrow-up-right') + '</button>')}<div class="upcoming-grid">${upcoming.map((game) => `<button class="upcoming-game" data-track="${escapeHtml(game.id)}"><div class="upcoming-top"><span>${state.sport.toUpperCase()} <span class="no-value">/</span> ${escapeHtml(shortDate(game.date))}</span><span>${escapeHtml(time(game.date))}</span></div><div class="upcoming-match"><span class="upcoming-team">${logo(game.away)}${escapeHtml(game.away.abbreviation)}</span><span class="versus">VS</span><span class="upcoming-team">${escapeHtml(game.home.abbreviation)}${logo(game.home)}</span></div><div class="upcoming-bottom"><span>${escapeHtml(game.away.record)} <span class="no-value">away team</span></span><span><span class="no-value">home team</span> ${escapeHtml(game.home.record)}</span></div></button>`).join('')}</div></section>`;
}

function renderDashboard() {
  return `${renderMetrics()}<section>${sectionTitle('In the spotlight', '', '<span class="small-tag">MATCHDAY</span>', `<button class="button button-text" data-nav="tracker">All matches ${icon('arrow-up-right')}</button>`)}<div class="feature-grid">${renderSpotlight(selectionGame())}${renderInsight()}</div></section><div class="analysis-grid"><section class="signals-section">${sectionTitle('Prediction signals', 'scan-line', '', `<button class="button button-text" data-nav="engine">View all ${icon('arrow-up-right')}</button>`)}${renderSignals()}<div class="table-footnote"><span>${icon('info')}Recent-form estimates. Historical results do not guarantee outcomes.</span><span>${state.analyzing ? 'Analyzing...' : `${signals().length} matchups`}</span></div></section><section class="live-pulse">${sectionTitle('Live pulse', 'radio', '<span class="small-tag">WIN PROBABILITY</span>')}${renderPulse()}</section></div>${renderUpcoming()}`;
}

function renderEngine() {
  return research.renderEngine(renderMetrics(), renderSignals(true));
}

function renderChart(game, summary) {
  const points = summary?.probabilities || [];
  if (points.length < 2) return empty('Win probability not yet available', game.state === 'pre' ? 'The live chart opens when the game starts and ESPN supplies probability data.' : 'This feed does not currently include a probability series.', 'activity');
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${(index / (points.length - 1) * 600).toFixed(1)},${(140 - Math.max(0, Math.min(1, point.home)) * 120).toFixed(1)}`).join(' ');
  return `<div class="chart-area"><div class="chart-title"><span>${escapeHtml(game.home.shortName)} win probability</span><strong>${percent(points.at(-1).home, 1)}</strong></div><svg class="probability-chart" viewBox="0 0 600 160" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(game.home.shortName)} live win probability across ${points.length} plays"><path d="M0 20H600M0 80H600M0 140H600" stroke="#293135" stroke-dasharray="4 5" fill="none"/><path d="${path} L600 160 L0 160 Z" fill="#c5f277" opacity=".07"/><path d="${path}" stroke="#c5f277" stroke-width="2" fill="none" vector-effect="non-scaling-stroke"/></svg><div class="chart-axes"><span>Earlier plays</span><span>ESPN probability · Latest play</span></div></div>`;
}

function renderInjuries(game) {
  if (state.injuriesError) return `<section class="boxscore">${sectionTitle('Injury report', 'heart-pulse')}<p class="table-footnote">ESPN injury report unavailable: ${escapeHtml(state.injuriesError)}</p></section>`;
  const reports = [game.away, game.home].map((team) => ({
    team,
    injuries: (state.injuryTeams.find((entry) => entry.teamId === String(team.id))?.injuries || [])
      .slice().sort((first, second) => new Date(second.date || 0) - new Date(first.date || 0)),
  }));
  const reportContent = reports.map(({ team, injuries }) => `<div><h3>${escapeHtml(team.name)}</h3>${injuries.length
    ? injuries.slice(0, 8).map((injury) => `<div class="team-stat-row"><span>${escapeHtml(injury.athlete)}${injury.date || injury.comment ? `<small>${injury.date ? `Updated ${escapeHtml(shortDate(injury.date))}` : ''}${injury.date && injury.comment ? ' · ' : ''}${injury.comment ? escapeHtml(injury.comment) : ''}</small>` : ''}</span><strong>${escapeHtml(injury.status)}</strong></div>`).join('')
    : '<div class="team-stat-row"><span>No injuries listed by ESPN</span></div>'}`).join('');
  return `<section class="boxscore">${sectionTitle('Injury report', 'heart-pulse', '<span class="small-tag">ESPN</span>')}<div class="team-stats">${reportContent}</div><p class="table-footnote">Status and notes are provider-reported context, not model inputs.${state.injuriesAt ? ` Updated ${escapeHtml(time(state.injuriesAt))}.` : ''}</p></section>`;
}

function renderPoisson(game) {
  if (!['epl', 'nhl'].includes(game.sport)) return '';
  const homeEvents = state.histories.get(game.home.id);
  const awayEvents = state.histories.get(game.away.id);
  const heading = sectionTitle('Poisson goal model', 'flask-conical', '<span class="small-tag">EXPERIMENTAL</span>');
  if (!homeEvents || !awayEvents) return `<section class="boxscore">${heading}<p class="table-footnote">Historical results are still loading for this matchup.</p></section>`;
  const goals = expectedGoals(homeEvents, awayEvents, game.home.id, game.away.id, game.date, state.window);
  if (!goals) return `<section class="boxscore">${heading}<p class="table-footnote">Not enough recent completed games for both teams to build a goal-expectancy model (minimum 5 each).</p></section>`;
  const maxGoals = game.sport === 'nhl' ? 9 : 6;
  const matrix = poissonMatrix(goals.homeGoals, goals.awayGoals, maxGoals);
  const outcomes = matchupProbabilities(matrix);
  const totals = totalGoalsDistribution(matrix);
  const line = game.sport === 'epl' ? 2.5 : 5.5;
  const over = probabilityOverLine(totals, line);
  const rows = [[`${escapeHtml(game.home.shortName)} win`, outcomes.home], ...(game.sport === 'epl' ? [['Draw', outcomes.draw]] : []),
    [`${escapeHtml(game.away.shortName)} win`, outcomes.away], ...(game.sport === 'epl' ? [['Both teams to score', outcomes.btts]] : []),
    [`Over ${line} total goals (illustrative line)`, over]];
  return `<section class="boxscore">${heading}<div class="team-stats"><div><h3>Expected goals</h3><div class="team-stat-row"><span>${escapeHtml(game.home.shortName)}</span><strong>${goals.homeGoals.toFixed(2)}</strong></div><div class="team-stat-row"><span>${escapeHtml(game.away.shortName)}</span><strong>${goals.awayGoals.toFixed(2)}</strong></div></div><div><h3>Modeled outcome probabilities</h3>${rows.map(([label, value]) => `<div class="team-stat-row"><span>${label}</span><strong>${percent(value, 1)}</strong></div>`).join('')}</div></div><p class="table-footnote">Two-factor Poisson model: expected goals average each team's own scoring rate with the opponent's conceding rate over the last ${goals.sample.home}/${goals.sample.away} home/away completed games. No league-wide attack/defense normalization, schedule strength or injury adjustment is applied, and the goal line shown is a fixed illustrative reference, not a matched sportsbook price.</p></section>`;
}

function renderLineMovement(game) {
  if (!state.oddsConfigured) return '';
  const history = state.lineHistories.get(game.id);
  const heading = sectionTitle('Line movement', 'trending-up', '<span class="small-tag">THE ODDS API</span>');
  if (!history) return `<section class="boxscore">${heading}<p class="table-footnote">Line history is loading for this matchup.</p></section>`;
  if (history.message || !history.snapshots?.length) return `<section class="boxscore">${heading}<p class="table-footnote">${escapeHtml(history.message || 'No sportsbook price history has been captured yet for this matchup. Snapshots are recorded roughly every 30 minutes once a matched event is found.')}</p></section>`;
  const opening = history.snapshots[0];
  const current = history.snapshots.at(-1);
  const move = (open, now) => Number.isFinite(open) && Number.isFinite(now) && open !== now ? formatDecimalOdds(now) + (now > open ? ' (drifting)' : ' (steaming)') : Number.isFinite(now) ? formatDecimalOdds(now) : '--';
  const rows = [[game.home.shortName, opening.home, current.home], [game.away.shortName, opening.away, current.away]];
  const books = Object.keys(current.books || {});
  return `<section class="boxscore">${heading}<div class="team-stats"><div><h3>Best price: open vs. current</h3>${rows.map(([label, open, now]) => `<div class="team-stat-row"><span>${escapeHtml(label)}</span><strong>${Number.isFinite(open) ? formatDecimalOdds(open) : '--'} <span class="no-value">→</span> ${move(open, now)}</strong></div>`).join('')}</div>${books.length ? `<div><h3>Per-book current price</h3>${books.map((book) => `<div class="team-stat-row"><span>${escapeHtml(book)}</span><strong>${Number.isFinite(current.books[book].home) ? formatDecimalOdds(current.books[book].home) : '--'} / ${Number.isFinite(current.books[book].away) ? formatDecimalOdds(current.books[book].away) : '--'}</strong></div>`).join('')}</div>` : ''}</div><p class="table-footnote">${history.snapshots.length} snapshot${history.snapshots.length === 1 ? '' : 's'} captured since ${escapeHtml(time(opening.time))}. "Steaming" means the price shortened (implied probability rose) since the first captured snapshot; "drifting" means it lengthened. A single snapshot only reflects the opening price captured so far.</p></section>`;
}

function renderDatasheetBody(summary) {
  if (!summary) return '';
  const stats = summary.statistics || [];
  const players = summary.players || [];
  if (!stats.length && !players.length) return empty('Datasheet pending', 'Team and player statistics will appear when ESPN publishes the box score.', 'clipboard-list');
  return `<section class="boxscore">${sectionTitle('Game datasheet', 'clipboard-list')}<div class="team-stats">${stats.map((entry) => `<div><h3>${escapeHtml(entry.team)}</h3>${entry.statistics.slice(0, 8).map((stat) => `<div class="team-stat-row"><span>${escapeHtml(stat.label || stat.name)}</span><strong>${escapeHtml(stat.displayValue)}</strong></div>`).join('')}</div>`).join('')}</div>${players.map((entry) => entry.groups.slice(0, 3).map((group) => `<div class="boxscore"><h3>${escapeHtml(entry.team)} · ${escapeHtml(group.name || 'Players')}</h3><div class="table-container"><table class="signal-table"><thead><tr><th>Player</th>${group.labels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${group.athletes.map((athlete) => `<tr><td>${escapeHtml(athlete.name)}</td>${athlete.stats.map((stat) => `<td>${escapeHtml(stat)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`).join('')).join('')}</section>`;
}

function renderDatasheet(summary) {
  return `${renderInjuries(selectionGame())}${renderLineMovement(selectionGame())}${renderPoisson(selectionGame())}${renderDatasheetBody(summary)}`;
}

function renderTracker() {
  const game = selectionGame();
  if (!game) return empty('The schedule is clear', 'Choose another league to see its upcoming and live games.', 'calendar-days');
  const summary = state.summaries.get(game.id);
  const points = summary?.probabilities || [];
  const shift = points.length > 1 ? points.at(-1).home - points.at(-2).home : null;
  const commentary = game.state === 'pre' ? `${game.away.name} visit ${game.home.name} at ${game.venue}. The game is scheduled for ${time(game.date)} on ${shortDate(game.date)}.` : `${game.home.name} ${game.home.score === game.away.score ? 'are tied with' : game.home.score > game.away.score ? 'lead' : 'trail'} ${game.away.name}, ${game.home.score}-${game.away.score}. ${shift != null ? `Home win probability moved ${shift >= 0 ? 'up' : 'down'} ${Math.abs(shift * 100).toFixed(1)} percentage points on the latest play.` : 'A live probability series is not currently available.'}`;
  return `<div class="tracker-grid"><section><div class="section-heading"><div class="section-title"><h2>Match center</h2><span class="small-tag">${state.games.length} GAMES</span></div></div><div class="tracker-game-list">${state.games.map((item) => `<button class="tracker-game ${item.id === game.id ? 'selected' : ''}" data-track="${escapeHtml(item.id)}" aria-pressed="${item.id === game.id}"><div class="pulse-top">${gameBadge(item)}<span>${escapeHtml(shortDate(item.date))}</span></div>${[item.away, item.home].map((team) => `<div class="tracker-score-row"><span>${logo(team)}${escapeHtml(team.abbreviation)}</span><strong>${item.state === 'pre' ? '--' : team.score}</strong></div>`).join('')}</button>`).join('')}</div></section><section class="tracker-main">${renderSpotlight(game, true)}${sectionTitle('The game, in real time', 'activity')}${renderChart(game, summary)}<section style="margin-top:25px">${sectionTitle('Match intelligence', 'sparkles', '<span class="small-tag">AUTOMATED NOTES</span>')}<div class="commentary-item"><time>NOW</time><p>${escapeHtml(commentary)}</p></div><div class="commentary-list">${summary?.plays?.length ? summary.plays.map((play) => `<div class="commentary-item"><time>${escapeHtml(play.clock || 'Play')}</time><p>${escapeHtml(play.text)}</p></div>`).join('') : `<div class="commentary-item"><time>${icon('radio')}</time><p>${summary?.error ? escapeHtml(summary.error) : game.state === 'pre' ? 'Play-by-play coverage has not started.' : 'Awaiting play-by-play updates from ESPN.'}</p></div>`}</div></section>${renderDatasheet(summary)}</section></div>`;
}

function renderModelAccuracy() {
  const stats = state.calibration.get(state.sport);
  const heading = sectionTitle('Model accuracy', 'target', '<span class="small-tag">PREDICTION LEDGER</span>');
  if (!stats || !stats.sample) return `<section class="status-table">${heading}<p class="table-footnote">No completed, reconciled predictions yet for ${state.sport.toUpperCase()}. Every pre-game probability is logged before kickoff and automatically checked against the final ESPN score once the game ends.</p></section>`;
  const window10 = stats.windows[10];
  const window20 = stats.windows[20];
  const rows = [
    ['Reconciled predictions', stats.sample],
    ['Pending reconciliation', stats.pending],
    ['Brier score (0 = perfect, 1 = worst)', stats.brier.toFixed(3)],
    ['Favorite hit rate', Number.isFinite(stats.hitRate) ? percent(stats.hitRate, 1) : '--'],
    ['Applied calibration bias', stats.biasFactor ? signed(stats.biasFactor * 100) : 'None yet (needs 20+ reconciled samples)'],
    ['Best window (10 vs. 20 games)', stats.bestWindow ? `${stats.bestWindow} games · 10-game: ${window10.brier?.toFixed(3) ?? '--'} Brier (n=${window10.sample}) · 20-game: ${window20.brier?.toFixed(3) ?? '--'} Brier (n=${window20.sample})` : 'Not enough samples yet in both windows'],
    ['Recency decay self-tuning', Number.isFinite(stats.bestDecay) ? `Applying decay ${stats.bestDecay} · ${Object.entries(stats.decays).map(([value, bucket]) => `${value}: ${bucket.brier?.toFixed(3) ?? '--'} Brier (n=${bucket.sample})`).join(' · ')}` : `Exploring candidate decays (${DECAY_CANDIDATES.join(' vs. ')}) · not enough reconciled samples per value yet`],
    ['Strength-of-schedule self-tuning', Number.isFinite(stats.bestSosWeight) ? `Applying SOS weight ${stats.bestSosWeight} · ${Object.entries(stats.sosWeights).map(([value, bucket]) => `${value}: ${bucket.brier?.toFixed(3) ?? '--'} Brier (n=${bucket.sample})`).join(' · ')}` : `Exploring candidate SOS weights (${SOS_CANDIDATES.join(' vs. ')}) · not enough reconciled samples per value yet`],
  ];
  return `<section class="status-table">${heading}<div class="table-container"><table class="signal-table"><tbody>${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(String(value))}</td></tr>`).join('')}</tbody></table></div><p class="table-footnote">Home-team win probability is nudged by the calibration bias above (a running average of prediction error) before being shown anywhere in the app.</p></section>`;
}

function renderFeeds() {
  const espn = state.status?.espn || { state: 'idle', message: 'Awaiting response' };
  const odds = state.status?.odds || { state: 'unconfigured', message: 'API key required' };
  return `<div class="feed-grid"><article class="feed-card"><div class="feed-header"><span class="feed-brand" style="color:#f2686d">ESPN</span><span class="feed-state ${espn.state !== 'connected' ? 'error' : ''}"><span class="live-dot"></span>${escapeHtml(espn.state)}</span></div><h3>Scores, schedules & game intelligence</h3><p>Public ESPN scoreboards, current and previous-season results, team box scores, player datasheets and live play-by-play.</p><div class="feed-detail"><span>Last successful request</span><strong>${espn.lastSuccess ? time(espn.lastSuccess) : '--'}</strong></div><div class="feed-detail"><span>Scoreboard refresh</span><strong>30 seconds</strong></div><div class="feed-detail"><span>Status</span><strong>${escapeHtml(espn.message)}</strong></div></article><article class="feed-card"><div class="feed-header"><span class="feed-brand" style="color:var(--cyan)">the odds api<span style="color:var(--lime)">.</span></span><span class="feed-state ${!state.oddsConfigured ? 'error' : ''}">${icon(state.oddsConfigured ? 'check' : 'key-round')}${escapeHtml(odds.state)}</span></div><h3>Sportsbook moneyline markets</h3><p>${state.oddsError ? escapeHtml(state.oddsError) : 'US sportsbook prices matched by home team, away team and scheduled start time. Prices are cached for 30 minutes.'}</p><div class="bookmarks-row"><span class="book-label">DraftKings</span><span class="book-label">FanDuel</span><span class="book-label">BetMGM</span></div><div class="feed-detail"><span>Remaining API credits</span><strong>${escapeHtml(odds.remaining ?? '--')}</strong></div><div class="feed-detail"><span>Last odds update</span><strong>${state.oddsAt ? time(state.oddsAt) : 'Not connected'}</strong></div>${!state.oddsConfigured ? '<button class="button button-secondary" style="margin-top:18px" data-setup>' + icon('key-round') + 'Connection setup</button>' : ''}</article></div><section class="status-table"><h2>Data pipeline</h2><div class="table-container"><table class="signal-table"><thead><tr><th>Pipeline</th><th>Source</th><th>Refresh / cache</th><th>Coverage</th></tr></thead><tbody><tr><td>Live scoreboards</td><td>ESPN</td><td>30s / 20s</td><td>${state.games.length} events</td></tr><tr><td>Historical results</td><td>ESPN team schedules</td><td>15 minutes</td><td>${state.predictions.size} matchups analyzed${state.partial ? ' · Partial history' : ''}</td></tr><tr><td>Win probability</td><td>ESPN game summary</td><td>30s / 20s</td><td>Provider-dependent</td></tr><tr><td>Sportsbook odds</td><td>The Odds API</td><td>30 minutes</td><td>${state.odds.length} available events</td></tr><tr><td>Statistical engine</td><td>Recent-form baseline v1.0</td><td>On data refresh</td><td>Two-way moneyline</td></tr></tbody></table></div></section>${renderModelAccuracy()}`;
}

function renderChrome() {
  const titles = { dashboard: ['Dashboard', 'A clearer view of the game', 'Live action. Statistical signals. An informed edge.'], engine: ['AI Prediction Engine', 'Find the pattern. Know the odds', 'Recurring results, transparent probabilities, and market context.'], tracker: ['Live Match Tracker', 'Every play changes the picture', 'Follow the score, the momentum, and the numbers behind it.'], bets: ['Bet Tracker', 'Your bets. The complete picture', 'Active slips, personal performance, and an auditable history.'], feeds: ['API Feeds Status', 'Good decisions start with good data', 'A clear view of every connection in your analytics workspace.'], audit: ['Quant Audit & Amelioration Lab', 'Backtest it before you trust it', 'Ledger-driven ROI, calibration and stratified performance auditing.'] };
  const [label, title, subtitle] = titles[state.view];
  $('#breadcrumb-view').textContent = label;
  $('#page-title').innerHTML = `${title}<span>.</span>`;
  $('#page-subtitle').textContent = subtitle;
  document.title = `${label} | SportsStat AI Predictor`;
  document.querySelectorAll('.nav-item').forEach((button) => { button.classList.toggle('active', button.dataset.nav === state.view); if (button.dataset.nav === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  document.querySelectorAll('[data-sport]').forEach((button) => { button.classList.toggle(button.classList.contains('league-item') ? 'selected' : 'active', button.dataset.sport === state.sport); button.setAttribute('aria-pressed', String(button.dataset.sport === state.sport)); });
  const connected = state.status?.espn.state === 'connected';
  $('#connection-pill').innerHTML = `<span class="live-dot" style="background:${state.error ? 'var(--amber)' : 'var(--green)'}"></span>${state.error ? 'Feed interrupted' : connected ? 'ESPN connected' : 'Connecting'}`;
  $('#sidebar-feed-label').textContent = state.error ? 'Feed needs attention' : connected ? 'Live feed connected' : 'Connecting to feeds';
  $('#refresh-button').classList.toggle('spinning', state.loading);
  $('#refresh-button').disabled = state.loading;
  $('#export-button').disabled = state.view === 'audit' ? true : (state.view === 'bets' || research.advancedActive() ? !research.canExport() : !signals().some((item) => item.prediction?.probability != null));
  const notice = $('#notice');
  notice.hidden = !state.error && !state.partial;
  notice.innerHTML = state.error ? `${icon('triangle-alert')}${escapeHtml(state.error)}${state.loadedAt ? ` Last successful scoreboard: ${escapeHtml(time(state.loadedAt))}.` : ''}` : `${icon('info')}Some team history is unavailable. Signals use only the completed results received.`;
}

function render() {
  const focused = document.activeElement;
  const searchFocused = focused?.id === 'signal-search';
  const position = searchFocused ? focused.selectionStart : null;
  renderChrome();
  const content = $('#view-content');
  content.setAttribute('aria-busy', String(state.loading && !state.games.length));
  if (state.view === 'bets') content.innerHTML = research.renderBets();
  else if (state.view === 'audit') content.innerHTML = audit.renderAudit();
  else if (state.loading && !state.games.length) content.innerHTML = '<div class="loading-state"><span class="loading-spinner"></span><h2>Connecting to the game</h2><p>Retrieving the latest ESPN schedule.</p></div>';
  else if (state.error && !state.games.length && state.view !== 'feeds') content.innerHTML = `${empty('The live feed is taking a break', state.error, 'wifi-off')}<div style="display:flex;justify-content:center;gap:12px;margin-top:20px"><button class="button button-primary" data-retry>${icon('refresh-cw')}Try again</button></div>`;
  else content.innerHTML = ({ dashboard: renderDashboard, engine: renderEngine, tracker: renderTracker, feeds: renderFeeds }[state.view])();
  icons();
  if (searchFocused && $('#signal-search')) { $('#signal-search').focus(); if (position != null) $('#signal-search').setSelectionRange(position, position); }
}

async function api(path, signal = state.controller?.signal, timeout = 45000) {
  const response = await fetch(`/api/${path}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadSummary(game, revision = state.revision) {
  if (!game) return;
  try {
    const summary = await api(`summary?sport=${state.sport}&event=${encodeURIComponent(game.id)}`);
    if (revision !== state.revision) return;
    state.summaries.set(game.id, summary);
  } catch (error) {
    if (revision !== state.revision) return;
    state.summaries.set(game.id, { error: `Game details unavailable: ${error.message}`, probabilities: [], plays: [], statistics: [], players: [] });
  }
  if (revision === state.revision && ['dashboard', 'tracker'].includes(state.view)) render();
}

async function loadLineHistory(game, revision = state.revision) {
  if (!game || !state.oddsConfigured) return;
  try {
    const history = await api(`odds/history?sport=${state.sport}&event=${encodeURIComponent(game.id)}`);
    if (revision !== state.revision) return;
    state.lineHistories.set(game.id, history);
  } catch (error) {
    if (revision !== state.revision) return;
    state.lineHistories.set(game.id, { message: `Line history unavailable: ${error.message}`, snapshots: [] });
  }
  if (revision === state.revision && state.view === 'tracker') render();
}

async function loadHistory(team, season, revision) {
  const key = `${state.sport}:${team}:${season}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.time < 900000) return hit.data;
  const data = await api(`history?sport=${state.sport}&team=${encodeURIComponent(team)}&season=${season}`);
  if (revision === state.revision) historyCache.set(key, { time: Date.now(), data });
  return data;
}

async function analyzeGames(season, revision) {
  const games = state.games.filter((game) => !game.completed);
  let next = 0;
  async function worker() {
    while (next < games.length && revision === state.revision) {
      const game = games[next++];
      try {
        const [home, away] = await Promise.all([loadHistory(game.home.id, season, revision), loadHistory(game.away.id, season, revision)]);
        if (revision !== state.revision) return;
        state.partial ||= home.partial || away.partial;
        state.histories.set(game.home.id, home.events);
        state.histories.set(game.away.id, away.events);
        applyPrediction(game, predictGame(game, home.events, away.events, state.window, biasFactor(), decayFor(game.id), sosWeightFor(game.id)));
      } catch {
        if (revision === state.revision) state.partial = true;
      }
      if (revision === state.revision) render();
    }
  }
  await Promise.all([worker(), worker(), worker()]);
}

async function loadData(reset = false) {
  state.controller?.abort();
  state.controller = new AbortController();
  const revision = ++state.revision;
  state.loading = true;
  state.error = '';
  state.partial = false;
  if (reset) { state.games = []; state.predictions.clear(); state.histories.clear(); state.summaries.clear(); state.lineHistories.clear(); state.injuryTeams = []; state.injuriesAt = null; state.injuriesError = ''; state.odds = []; state.oddsAt = null; state.selected = null; state.loadedAt = null; state.status = null; state.oddsConfigured = false; research.reset(); }
  state.analyzing = true;
  render();
  const oddsPromise = api(`odds?sport=${state.sport}`).then((result) => {
    if (revision !== state.revision) return;
    state.odds = result.events;
    state.oddsAt = result.fetchedAt;
    state.oddsConfigured = result.configured;
    state.oddsError = '';
  }).catch((error) => { if (revision === state.revision) { state.odds = []; state.oddsAt = null; state.oddsError = error.message; } });
  const injuriesPromise = api(`injuries?sport=${state.sport}`).then((result) => {
    if (revision !== state.revision) return;
    state.injuryTeams = result.teams;
    state.injuriesAt = result.fetchedAt;
    state.injuriesError = '';
    if (state.view === 'tracker') render();
  }).catch((error) => {
    if (revision !== state.revision) return;
    state.injuryTeams = [];
    state.injuriesAt = null;
    state.injuriesError = error.message;
    if (state.view === 'tracker') render();
  });
  const calibrationPromise = loadCalibration(revision);
  try {
    const scoreboard = await api(`scoreboard?sport=${state.sport}`);
    if (revision !== state.revision) return;
    state.games = scoreboard.games;
    state.loadedAt = scoreboard.fetchedAt;
    state.predictions = new Map([...state.predictions].filter(([id]) => state.games.some((game) => game.id === id && !game.completed)));
    render();
    const active = state.games.filter((game) => game.state === 'in').slice(0, 3);
    const selected = selectionGame();
    if (selected && !active.some((game) => game.id === selected.id)) active.unshift(selected);
    const summaries = Promise.all(active.map((game) => loadSummary(game, revision)));
    await calibrationPromise;
    await analyzeGames(scoreboard.season, revision);
    await summaries;
  } catch (error) {
    if (revision !== state.revision) return;
    state.error = error.message;
  }
  await Promise.all([oddsPromise, injuriesPromise]);
  if (revision !== state.revision) return;
  if (state.view === 'tracker') void loadLineHistory(selectionGame(), revision);
  try { const status = await api('status'); if (revision === state.revision) state.status = status; } catch {}
  if (revision !== state.revision) return;
  state.loading = false;
  state.analyzing = false;
  render();
  research.refresh(true);
}

function navigate(view) {
  state.view = view;
  closeMenu();
  render();
  if (view === 'tracker' && !state.summaries.has(selectionGame()?.id)) void loadSummary(selectionGame());
  if (view === 'tracker' && !state.lineHistories.has(selectionGame()?.id)) void loadLineHistory(selectionGame());
  research.refresh();
  audit.refresh();
}
function closeMenu() { $('#sidebar').classList.remove('open'); $('#sidebar-overlay').hidden = true; $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
function openDialog(title, content) { $('#dialog-title').textContent = title; $('#dialog-content').innerHTML = content; if (!$('#detail-dialog').open) $('#detail-dialog').showModal(); icons(); }
function methodology() {
  openDialog('The model behind the signal', `<div class="dialog-copy">
    <p><strong>Transparent statistical baselines</strong>, not a trained AI system or a validated betting strategy. Automated match notes use scores and probability changes, not an LLM.</p>
    <h3>1. Historical sample & sources</h3><p>The requested window is 10 or 20 completed games before both the matchup and the current time. Duplicate events and unavailable statistics are excluded. Each observation has equal weight within its sample. Source inspection preserves event IDs, exact endpoints, fetch times, raw values, weights and the actual sample size.</p>
    <h3>2. Two-way moneyline</h3><p>At least five games per team are required. Ties count as half wins. A Beta(2, 2) prior gives <code>strength = (wins + 2) / (games + 4)</code>; normalized team odds ratios give the matchup estimate. EPL three-way moneylines are not modeled.</p>
    <h3>3. Props, spreads & totals</h3><p>Historical statistics are graded against the exact current selection and line. Missing player stats are not zeros. At least five decisive observations are required. <code>conditional win = (wins + 2) / (wins + losses + 4)</code>. The observed push fraction reduces unconditional win probability. <code>EV% = (win probability * decimal odds + push probability - 1) * 100</code>. Prices are compared only for the same player or team, direction and line.</p>
    <h3>4. Personal performance</h3><p>The local ledger is separate from model repetition rates. Win rate excludes pushes, voids and active slips. ROI uses realized net profit over settled non-void stakes. Active stakes reserve available bankroll. Final ESPN results are suggestions; sportsbook settlement requires your confirmation.</p>
    <h3>5. Limits & responsible use</h3><p class="warning">Historical frequency is not predictive accuracy. The Match Tracker displays ESPN injury reports as context, but these uncalibrated estimates do not yet incorporate injuries, lineups, opponent strength, home advantage or live score changes. ESPN live probabilities are separate. Book-specific overtime, void rules, taxes and fees are not modeled. Positive estimated EV is not proof of an advantage. No backtested performance or guarantees are claimed. 18+ only. Never wager money you cannot afford to lose.</p><p>ESPN endpoints are unofficial. Coverage and latency vary. This app records bets; it does not place wagers or transfer money.</p>
  </div>`);
}

function exportSignals() {
  if (research.exportView()) return;
  const records = signals().filter((item) => item.prediction?.probability != null);
  if (!records.length) return toast('There are no model signals to export yet.');
  const rows = [['League', 'Matchup', 'Start time', 'Selection', 'Model probability', 'Min sample size', 'Sportsbook', 'Decimal odds', 'Implied probability', 'EV percent', 'Odds fetched at'], ...records.map(({ game, prediction, price, ev }) => [state.sport, `${game.away.name} at ${game.home.name}`, game.date, game[prediction.selection].name, prediction.probability, prediction.sample, price?.book || '', price?.price || '', price ? impliedProbability(price.price) : '', ev ?? '', state.oddsAt || ''])];
  const csv = rows.map((row) => row.map((value) => { const text = String(value); return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`; }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = `sportsstat-${state.sport}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${records.length} signals.`);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.nav) navigate(button.dataset.nav);
  if (button.dataset.sport && button.dataset.sport !== state.sport) { state.sport = button.dataset.sport; closeMenu(); void loadData(true); }
  if (button.dataset.track) { state.selected = button.dataset.track; navigate('tracker'); }
  if (button.dataset.dialogTrack) { $('#detail-dialog').close(); state.selected = button.dataset.dialogTrack; navigate('tracker'); }
  if (button.dataset.detail) research.inspectMoneyline(button.dataset.detail);
  if (button.dataset.save) {
    const key = `${state.sport}:${button.dataset.save}`;
    if (state.saved.has(key)) state.saved.delete(key); else state.saved.add(key);
    storage.set('sportsstat-saved', [...state.saved]);
    render();
  }
  if (button.hasAttribute('data-methodology')) methodology();
  if (button.hasAttribute('data-retry')) void loadData();
  if (button.hasAttribute('data-setup')) openDialog('Connect sportsbook odds', '<div class="dialog-copy"><h3>Server-side configuration</h3><p>Create a <code>.env</code> file in the project root using <code>.env.example</code>. Set <code>ODDS_API_KEY</code> to your key from The Odds API, then restart the Node server.</p><p>Your key stays on the server. DraftKings, FanDuel and BetMGM prices depend on the selected league, market, region and subscription. Props, spreads and totals use per-event market requests.</p><p class="warning">Additional market requests consume provider quota. Odds are cached for 30 minutes by default (override with <code>ODDS_POLL_INTERVAL_MS</code>) to conserve a free-tier monthly credit budget. Missing or unoffered markets remain unavailable, never simulated. Verify current prices and settlement rules with the sportsbook.</p></div>');
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'signal-search') { state.search = event.target.value; $('#engine-table').innerHTML = research.advancedActive() ? research.renderMarketTable() : renderSignals(true); icons(); }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'signal-filter') { state.filter = event.target.value; $('#engine-table').innerHTML = research.advancedActive() ? research.renderMarketTable() : renderSignals(true); icons(); }
  if (event.target.id === 'auto-refresh') toast(event.target.checked ? 'Auto-refresh enabled: every 30 seconds.' : 'Auto-refresh paused.');
});
$('#refresh-button').addEventListener('click', () => void loadData());
$('#export-button').addEventListener('click', exportSignals);
$('#methodology-button').addEventListener('click', methodology);
$('#dialog-close').addEventListener('click', () => $('#detail-dialog').close());
$('#detail-dialog').addEventListener('click', (event) => { if (event.target === $('#detail-dialog')) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close(); } });
$('#menu-toggle').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#sidebar-overlay').hidden = !open; $('#menu-toggle').setAttribute('aria-expanded', String(open)); });
$('#sidebar-overlay').addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
$('#today-label').textContent = formatDate(new Date(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
window.addEventListener('load', icons);
setInterval(() => { if ($('#auto-refresh').checked && !document.hidden && !state.loading && !$('#detail-dialog').open && state.view !== 'bets' && state.view !== 'audit') void loadData(); }, 30000);
void loadData();