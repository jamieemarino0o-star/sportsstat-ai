import { MARKETS, SPORT_MARKETS, quoteKey } from './markets.js';
import { americanOdds, expectedValue, impliedProbability, matchOdds } from './model.js';
import { betMetrics, createSlip, settleSlip, suggestedResult } from './bets.js';
import { shinProbabilities, noVigProbabilities, kellyStake, monteCarloMatchup, classifyRisk } from './quants.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const percent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '--';
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const timestamp = (value) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not supplied';
const signedEV = (value) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)}%` : '--';
const categories = { moneyline: 'Moneyline', players: 'Player props', spreads: 'Spreads', totals: 'Totals', btts: 'BTTS' };
const sourceLink = (source) => source?.url && /^https:\/\/(site\.api\.espn\.com|api\.the-odds-api\.com)\//.test(source.url)
  ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.provider)} ${icon('external-link')}</a>` : escapeHtml(source?.provider || 'Source not supplied');

function readAccounts() {
  let data;
  try { data = JSON.parse(localStorage.getItem('sportsstat-ledger-v2')); } catch {}
  return {
    openingCents: Number.isSafeInteger(data?.openingCents) && data.openingCents >= 0 ? data.openingCents : 0,
    slips: Array.isArray(data?.slips) ? data.slips.filter((slip) => typeof slip.id === 'string'
      && Number.isSafeInteger(slip.stakeCents) && slip.stakeCents > 0 && Number.isFinite(slip.odds) && slip.odds > 1
      && ['active', 'won', 'lost', 'push', 'void'].includes(slip.status) && slip.game?.id && MARKETS[slip.quote?.market]) : [],
  };
}

// Fractional Kelly protects the bankroll from the model's own estimation error: full Kelly is
// mathematically optimal only if the win probability is exactly right, which a historical-frequency
// estimate never guarantees. Quarter-Kelly (25%) is the conservative default; Half-Kelly (50%) is
// offered for users confident enough in the edge to size more aggressively.
const KELLY_FRACTIONS = [{ value: 0.25, label: 'Quarter Kelly (25%)' }, { value: 0.5, label: 'Half Kelly (50%)' }];
function readKellyFraction() {
  const stored = Number(localStorage.getItem('sportsstat-kelly-fraction'));
  return KELLY_FRACTIONS.some((option) => option.value === stored) ? stored : 0.25;
}

export function createResearchWorkspace({ state, api, render, openDialog, icons, toast, onWindowChange }) {
  const ui = { category: 'moneyline', market: '', eventId: '', result: null, loading: false, error: '', request: 0,
    controller: null, account: readAccounts(), betTab: 'active', betLeague: 'all', checking: false, results: new Map(), syncAt: null, syncErrors: 0,
    lineHistories: new Map(), kellyFraction: readKellyFraction() };
  let inspected;
  let tracking;
  const account = () => ui.account;
  const availableGame = () => state.games.find((game) => game.id === ui.eventId && !game.completed) || state.games.find((game) => !game.completed);
  const availableCategories = () => [...new Set(SPORT_MARKETS[state.sport].map((key) => MARKETS[key].category))];
  const availableMarkets = () => SPORT_MARKETS[state.sport].filter((key) => MARKETS[key].category === ui.category);
  const marketLabel = (key) => key === 'spreads' && state.sport === 'nhl' ? 'Puck line' : key === 'totals' && ['nhl', 'epl'].includes(state.sport) ? 'Goal total' : MARKETS[key]?.label || key;
  const quoteLabel = (quote) => `${quote.subject ? `${quote.subject} ` : ''}${['Over', 'Under', 'Yes', 'No'].includes(quote.direction) ? quote.direction : ''}${quote.line == null ? '' : ` ${['spread', 'half'].includes(MARKETS[quote.market]?.kind) && quote.line > 0 ? '+' : ''}${quote.line}`}`.trim();

  function updateAccount(transform) {
    const updated = transform(ui.account);
    if (betMetrics(updated.slips, updated.openingCents).availableCents < 0) throw new Error('This change would exceed the available bankroll.');
    try { localStorage.setItem('sportsstat-ledger-v2', JSON.stringify(updated)); } catch { throw new Error('Browser storage is unavailable or full. This change was not saved.'); }
    ui.account = updated;
  }

  async function loadLineHistory(gameId) {
    if (!state.oddsConfigured || ui.lineHistories.has(gameId)) return ui.lineHistories.get(gameId);
    const promise = api(`odds/history?sport=${state.sport}&event=${encodeURIComponent(gameId)}`).catch((error) => ({ message: error.message, snapshots: [] }));
    ui.lineHistories.set(gameId, promise);
    const result = await promise;
    ui.lineHistories.set(gameId, result);
    return result;
  }

  function lineMovement(signal) {
    if (signal.quote?.market !== 'h2h' || !signal.quote?.side) return null;
    const history = ui.lineHistories.get(signal.game.id);
    if (!history || history instanceof Promise || !history.snapshots?.length) return null;
    const opening = history.snapshots[0][signal.quote.side];
    const current = history.snapshots.at(-1)[signal.quote.side];
    if (!Number.isFinite(opening) || !Number.isFinite(current)) return null;
    return { opening, current, steaming: current > opening, count: history.snapshots.length };
  }

  function moneylineSignal(id) {
    const game = state.games.find((item) => item.id === id);
    const analysis = state.predictions.get(id);
    if (!game) return null;
    const quote = matchOdds(game, state.odds).filter((item) => item.side === analysis?.selection).sort((first, second) => second.price - first.price)[0];
    const selection = analysis?.selection;
    return { game, label: selection ? `${game[selection].name} moneyline` : 'Model unavailable', analysis: analysis || {},
      quote: { ...quote, market: 'h2h', direction: selection ? game[selection].name : '', subject: selection ? game[selection].name : '', side: selection, line: null,
        source: { provider: 'The Odds API', url: 'https://api.the-odds-api.com/v4/sports/', fetchedAt: state.oddsAt } },
      comparisons: matchOdds(game, state.odds).filter((item) => item.side === selection),
      sides: {
        home: matchOdds(game, state.odds).filter((item) => item.side === 'home').sort((first, second) => second.price - first.price)[0],
        away: matchOdds(game, state.odds).filter((item) => item.side === 'away').sort((first, second) => second.price - first.price)[0],
      },
    };
  }

  function quantEdge(signal) {
    const analysis = signal.analysis || {};
    const price = signal.quote?.price;
    const kelly = Number.isFinite(analysis.probability) && Number.isFinite(price) ? kellyStake(analysis.probability, price, ui.kellyFraction) : null;
    let noVig = null;
    if (signal.sides?.home?.price && signal.sides?.away?.price) {
      // Shin's method has no solution for a no-margin (or arbitrage) market; fall back to the
      // multiplicative split there rather than showing no fair odds at all.
      const prices = [signal.sides.home.price, signal.sides.away.price];
      const devig = shinProbabilities(prices) || noVigProbabilities(prices);
      if (devig) noVig = { home: devig.probabilities[0], away: devig.probabilities[1], overround: devig.overround, z: devig.z ?? null, method: devig.z == null ? 'multiplicative' : 'shin' };
    }
    const monteCarlo = signal.quote?.market === 'h2h' ? monteCarloMatchup(analysis.home, analysis.away) : null;
    const risk = Number.isFinite(analysis.probability) && Number.isFinite(price) ? classifyRisk(analysis.probability, price) : null;
    return { kelly, noVig, monteCarlo, risk };
  }

  function marketSignal(index) {
    const signal = ui.result?.signals?.[index];
    if (!signal) return null;
    return { ...signal, game: ui.result.game, label: quoteLabel(signal.quote), comparisons: (ui.result.quotes || []).filter((quote) => quoteKey(quote) === quoteKey(signal.quote)) };
  }

  function provenanceMarkup(signal) {
    const provenance = signal.analysis?.provenance;
    if (!provenance) return '<div class="empty-state"><h3>Historical data not available</h3><p>No model weights or observations have been computed for this signal.</p></div>';
    const samples = provenance.sources || [];
    const sources = [...samples.map((entry) => entry.source), signal.quote?.source].filter(Boolean)
      .filter((entry, index, all) => all.findIndex((source) => source.url === entry.url && source.provider === entry.provider && source.fetchedAt === entry.fetchedAt) === index);
    return `<div class="provenance-meta"><div><small>Model version</small><strong>${escapeHtml(provenance.version)}</strong></div><div><small>Requested window</small><strong>Last ${provenance.window} games</strong></div><div><small>Actual observations</small><strong>${samples.length}${signal.quote.market === 'h2h' ? ` (${signal.analysis.home.sample} home / ${signal.analysis.away.sample} away)` : ''}</strong></div><div><small>Data cutoff</small><strong>${escapeHtml(timestamp(provenance.cutoff))}</strong></div></div><section class="inspection-section"><h3>Statistical weights</h3><p>${escapeHtml(provenance.weighting)}</p><p>Prior: <strong>${provenance.prior.wins} wins + ${provenance.prior.losses} losses</strong>. Minimum: ${provenance.minimum} ${signal.quote.market === 'h2h' ? 'games per team' : 'decisive results'}. Injuries and live game state: <strong>0%</strong>.${signal.quote.market === 'h2h' ? ` Strength-of-schedule: ${signal.analysis.home.sos?.averageOpponentWinPct != null || signal.analysis.away.sos?.averageOpponentWinPct != null ? 'applied' : 'not enough opponent-record data to apply'}.` : ''}</p>${signal.quote.market === 'h2h' ? `<p>Home smoothed strength: ${percent(signal.analysis.home.probability)}${signal.analysis.home.sos?.averageOpponentWinPct != null ? ` (raw ${percent(signal.analysis.home.rawProbability)}, SOS ${signedEV(signal.analysis.home.sos.adjustment * 100)}pp vs. avg. opponent win% ${percent(signal.analysis.home.sos.averageOpponentWinPct)})` : ''}. Away smoothed strength: ${percent(signal.analysis.away.probability)}${signal.analysis.away.sos?.averageOpponentWinPct != null ? ` (raw ${percent(signal.analysis.away.rawProbability)}, SOS ${signedEV(signal.analysis.away.sos.adjustment * 100)}pp vs. avg. opponent win% ${percent(signal.analysis.away.sos.averageOpponentWinPct)})` : ''}. These are converted to odds ratios and normalized, not averaged. Strength-of-schedule uses each opponent's current season record as a free proxy — it is not a point-in-time record as of that historical game.</p>` : `<p>Win probability = ((wins + 2) / (wins + losses + 4)) × (1 − push frequency). Push frequency: ${percent(signal.analysis.pushProbability)}. EV includes the returned stake for pushes.</p>`}</section><section class="inspection-section"><h3>Source inspection</h3><div class="source-list">${sources.map((source) => `<div><strong>${sourceLink(source)}</strong><small>Observed / fetched: ${escapeHtml(timestamp(source.fetchedAt))}</small>${source.url ? `<code>${escapeHtml(source.url)}</code>` : '<small>Local synthetic fixture. Not a real historical result.</small>'}</div>`).join('') || '<p>No source references were returned.</p>'}</div></section><section class="inspection-section"><h3>Exact historical sample</h3><div class="table-container provenance-table"><table class="signal-table"><thead><tr><th>Date / event</th><th>Observed value</th><th>Result</th><th>Weight</th><th>Source</th></tr></thead><tbody>${samples.map((entry) => `<tr><td>${escapeHtml(new Date(entry.date).toLocaleDateString())}<small class="cell-note">${escapeHtml(entry.matchup)}${entry.cohort ? ` · ${escapeHtml(entry.cohort)}` : ''}</small><small class="cell-note">ID ${escapeHtml(entry.eventId)}</small></td><td>${entry.value != null ? escapeHtml(entry.value) : `${entry.awayScore} : ${entry.homeScore}`}<small class="cell-note">${escapeHtml(entry.field || 'Away : home score')}${entry.raw ? ` · raw ${escapeHtml(entry.raw)}` : ''}</small></td><td>${escapeHtml(typeof entry.outcome === 'number' ? entry.outcome === 1 ? 'W' : entry.outcome === 0.5 ? 'T' : 'L' : entry.outcome)}</td><td>${percent(entry.weight)}</td><td>${sourceLink(entry.source)}</td></tr>`).join('')}</tbody></table></div><details class="raw-observations"><summary>Normalized source records</summary><pre>${escapeHtml(JSON.stringify(samples, null, 2))}</pre></details></section>`;
  }

  function inspect(signal, tab = 'overview') {
    if (!signal) return;
    inspected = structuredClone(signal);
    if (signal.quote.market === 'h2h' && signal.quote.side && state.oddsConfigured && !ui.lineHistories.has(signal.game.id)) {
      loadLineHistory(signal.game.id).then(() => { if (inspected?.game.id === signal.game.id) inspect(inspected, tab); });
    }
    const analysis = signal.analysis;
    const ev = signal.quote.market === 'h2h' ? expectedValue(analysis.probability, signal.quote.price) : analysis.ev;
    const edgePoints = Number.isFinite(analysis.probability) && Number.isFinite(signal.quote.price) ? (analysis.probability - impliedProbability(signal.quote.price)) * 100 : null;
    const edge = quantEdge(signal);
    const movement = lineMovement(signal);
    const quantMarkup = `<section class="inspection-section"><h3>Quantitative edge</h3>${edge.noVig ? `<p>${edge.noVig.method === 'shin' ? "Shin's-method" : 'Multiplicative (no-margin market, Shin not applicable)'} fair probability: home <strong>${percent(edge.noVig.home)}</strong> / away <strong>${percent(edge.noVig.away)}</strong> (fair odds ${(1 / edge.noVig.home).toFixed(2)} / ${(1 / edge.noVig.away).toFixed(2)}).${edge.noVig.z != null ? ` Estimated informed-money proportion (z): ${percent(edge.noVig.z)}.` : ''} Matched-book overround removed: ${percent(edge.noVig.overround)}. Shin's method assumes some of the market's margin protects against sharp bettors, so it shades the favorite's fair probability slightly higher than a flat proportional (multiplicative) de-vig would.</p>` : '<p>Shin\'s-method fair odds need a matched price on both sides of this market.</p>'}${edge.kelly ? `<p>${ui.kellyFraction === 0.5 ? 'Half' : 'Quarter'}-Kelly stake: <strong>${percent(edge.kelly.recommended)}</strong> of bankroll (full Kelly ${percent(edge.kelly.fullKelly)}, model edge ${signedEV(edge.kelly.edge * 100)}) ≈ ${money(Math.round(edge.kelly.recommended * betMetrics(account().slips, account().openingCents).availableCents))} of your available bankroll.</p>` : '<p>Kelly sizing needs a positive model probability and a matched price.</p>'}${edge.risk ? `<p>Risk tier: <strong>${edge.risk.tier}</strong> (by model probability) ${edge.risk.mispriced ? `— <strong class="inspection-warning-inline">flagged as potentially mispriced</strong>: the market's odds imply a <strong>${edge.risk.byOdds}</strong>-risk bet, but the model rates it <strong>${edge.risk.tier}</strong>-risk.` : `and the market's odds also imply a ${edge.risk.byOdds}-risk bet — model and market agree on risk profile.`}</p>` : ''}${edge.monteCarlo ? `<p>Monte Carlo preview (${edge.monteCarlo.iterations.toLocaleString()} draws of the model's own posterior): home win-probability range <strong>${percent(edge.monteCarlo.p10)} – ${percent(edge.monteCarlo.p90)}</strong> (median ${percent(edge.monteCarlo.median)}). This visualizes the sample-size uncertainty already implied above; it is not new information.</p>` : ''}${movement ? `<p>Line movement: opened at <strong>${americanOdds(movement.opening)}</strong>, now <strong>${americanOdds(movement.current)}</strong> (${movement.steaming ? 'steaming toward this side' : movement.current === movement.opening ? 'unchanged' : 'drifting away from this side'}) across ${movement.count} snapshot${movement.count === 1 ? '' : 's'} of the best matched price.</p>` : signal.quote.market === 'h2h' && signal.quote.side && state.oddsConfigured ? '<p>Line movement: capturing snapshots. Check back in a few minutes for an opening-vs-current comparison.</p>' : ''}<p class="inspection-warning">Supplementary calculations layered on the historical-frequency model above. They ignore injuries and live game state.</p></section>`;
    const overview = `<div class="detail-stats"><div><small>Model probability</small><strong>${percent(analysis.probability)}</strong></div><div><small>Historical sample</small><strong>${analysis.sample ?? 0}<small>games${signal.quote.market === 'h2h' ? ' / team' : ''}</small></strong></div><div><small>Estimated EV</small><strong>${signedEV(ev)}</strong></div><div><small>Probability edge</small><strong>${edgePoints == null ? '—' : signedEV(edgePoints)}<small>pp vs. implied</small></strong></div></div><section class="inspection-section"><h3>Historical repetition</h3><p>${signal.quote.market === 'h2h' ? `Home: ${analysis.home?.wins ?? 0} wins in ${analysis.home?.sample ?? 0} games. Away: ${analysis.away?.wins ?? 0} wins in ${analysis.away?.sample ?? 0} games.` : `${analysis.wins ?? 0} wins · ${analysis.losses ?? 0} losses · ${analysis.pushes ?? 0} pushes against the current line.`}</p><p>${analysis.probability == null ? 'No estimate: the minimum valid sample is not available.' : 'Uncalibrated historical-frequency estimate. Not measured predictive accuracy.'}</p></section><section class="inspection-section"><h3>Exact-line sportsbook comparison</h3>${signal.comparisons?.length ? `<div class="table-container"><table class="signal-table"><thead><tr><th>Book</th><th>Decimal / American</th><th>Implied</th><th>Price timestamp</th></tr></thead><tbody>${signal.comparisons.map((price) => `<tr><td>${escapeHtml(price.book)}</td><td>${price.price.toFixed(2)} / ${americanOdds(price.price)}</td><td>${percent(impliedProbability(price.price))}</td><td>${escapeHtml(timestamp(price.updated))}</td></tr>`).join('')}</tbody></table></div>` : '<p>No matched odds. A price can be entered manually when logging a bet.</p>'}</section>${quantMarkup}<p class="inspection-warning">${signal.game.state === 'in' ? 'This is a pregame historical baseline; it does not incorporate the live score. ' : ''}Verify line, overtime and player-participation rules with your sportsbook.</p>`;
    openDialog('Data Provenance & Source Inspection', `<div class="inspection-subtitle"><span class="small-tag">${signal.game.sport.toUpperCase()}</span><h3>${escapeHtml(signal.label)}</h3><p>${escapeHtml(signal.game.away.name)} at ${escapeHtml(signal.game.home.name)}</p></div><div class="research-tabs" role="group" aria-label="Signal inspection"><button data-inspection-tab="overview" class="${tab === 'overview' ? 'active' : ''}" aria-pressed="${tab === 'overview'}">${icon('chart-no-axes-combined')}Analysis</button><button data-inspection-tab="sources" class="${tab === 'sources' ? 'active' : ''}" aria-pressed="${tab === 'sources'}">${icon('database')}Sources & weights</button></div>${tab === 'sources' ? provenanceMarkup(signal) : overview}<div class="dialog-actions"><button class="button button-secondary" data-export-provenance>${icon('download')}Export provenance</button><button class="button button-primary" data-track-current ${signal.quote.market === 'h2h' && !signal.quote.side ? 'disabled' : ''}>${icon('plus')}Track Bet</button></div>`);
  }

  function showBetForm(signal) {
    if (!signal) return;
    tracking = structuredClone(signal);
    if (signal.quote.market === 'h2h' && signal.quote.side && state.oddsConfigured && !ui.lineHistories.has(signal.game.id)) void loadLineHistory(signal.game.id);
    const metrics = betMetrics(account().slips, account().openingCents);
    const movement = lineMovement(signal);
    const movementNote = movement ? `<div class="notice">Line movement: opened at <strong>${americanOdds(movement.opening)}</strong>, now <strong>${americanOdds(movement.current)}</strong> (${movement.steaming ? 'steaming toward this side' : movement.current === movement.opening ? 'unchanged' : 'drifting away from this side'}).</div>` : '';
    openDialog('Track Bet', `<div class="inspection-subtitle"><span class="small-tag">LEDGER · ${signal.game.sport.toUpperCase()}</span><h3>${escapeHtml(signal.label)}</h3><p>${escapeHtml(signal.game.away.name)} at ${escapeHtml(signal.game.home.name)}</p></div>${movementNote}<form id="track-bet-form" class="research-form">${account().openingCents === 0 && !account().slips.length ? '<label>Opening bankroll (USD)<input name="opening" type="number" min="0.01" max="1000000" step="0.01" value="1000" required></label>' : `<div class="form-balance"><span>Available bankroll</span><strong>${money(metrics.availableCents)}</strong></div>`}<div class="form-grid"><label>Stake (USD)<input name="stake" type="number" min="0.01" max="1000000" step="0.01" value="10" required autofocus></label><label>Decimal odds<input name="odds" type="number" min="1.001" max="10000" step="0.001" value="${Number.isFinite(signal.quote.price) ? signal.quote.price.toFixed(3) : ''}" placeholder="e.g. 1.910" required></label></div><label>Sportsbook / reference<input name="book" maxlength="100" value="${escapeHtml(signal.quote.book || '')}" placeholder="Optional sportsbook or reference"></label><div class="stake-preview" id="stake-preview"></div><div class="edge-preview" id="edge-preview"></div><div class="research-tabs" role="group" aria-label="Kelly fraction">${KELLY_FRACTIONS.map((option) => `<button type="button" data-kelly-fraction="${option.value}" class="${ui.kellyFraction === option.value ? 'active' : ''}" aria-pressed="${ui.kellyFraction === option.value}">${option.label}</button>`).join('')}</div><p class="inspection-warning">Personal record only. No money is transferred and no wager is placed.</p><p class="form-error" id="bet-form-error" role="alert"></p><button class="button button-primary" type="submit">${icon('plus')}Add to active slips</button></form>`);
    updateStakePreview();
  }

  function updateStakePreview() {
    const form = document.querySelector('#track-bet-form');
    if (!form) return;
    const stake = Number(form.elements.stake.value);
    const odds = Number(form.elements.odds.value);
    document.querySelector('#stake-preview').textContent = stake > 0 && odds > 1 ? `Potential return: ${money(Math.round(stake * odds * 100))} · Net profit: ${money(Math.round(stake * (odds - 1) * 100))}` : 'Enter stake and decimal odds.';
    const edgeEl = document.querySelector('#edge-preview');
    if (!edgeEl) return;
    const probability = tracking?.analysis?.probability;
    if (!Number.isFinite(probability) || !(odds > 1)) { edgeEl.innerHTML = ''; return; }
    const ev = (probability * odds + (tracking.analysis.pushProbability || 0) - 1) * 100;
    const edgePoints = (probability - impliedProbability(odds)) * 100;
    const risk = classifyRisk(probability, odds);
    // High-risk bets (longshots) get an extra conservative cap on top of the user's chosen fraction,
    // since Kelly sizing is most sensitive to probability-estimation error precisely in this range.
    const HIGH_RISK_CAP = 0.2;
    const effectiveFraction = risk.tier === 'high' ? Math.min(ui.kellyFraction, HIGH_RISK_CAP) : ui.kellyFraction;
    const kelly = kellyStake(probability, odds, effectiveFraction);
    const openingInput = form.elements.opening;
    const openingCents = openingInput ? Math.round(Number(openingInput.value) * 100) || 0 : account().openingCents;
    const availableCents = betMetrics(account().slips, openingCents).availableCents;
    const recommendedCents = kelly ? Math.max(0, Math.round(kelly.recommended * availableCents)) : 0;
    const kellyLabel = risk.tier === 'high' && effectiveFraction < ui.kellyFraction ? `Capped Kelly (${percent(effectiveFraction)}, high-risk bet)` : ui.kellyFraction === 0.5 ? 'Half-Kelly' : 'Quarter-Kelly';
    edgeEl.innerHTML = `<p class="${ev >= 0 ? 'profit-positive' : 'profit-negative'}">Model edge: ${signedEV(edgePoints)} pp vs. implied probability · EV ${signedEV(ev)}</p><p>Risk tier: <span class="risk-tag risk-${risk.tier}">${risk.tier}</span>${risk.mispriced ? ` <span class="inspection-warning-inline">market odds imply ${risk.byOdds}-risk</span>` : ''}</p>${kelly ? `<p>${kellyLabel} suggested stake: <strong>${money(recommendedCents)}</strong> (${percent(kelly.recommended)} of available bankroll)${recommendedCents > 0 ? ` <button type="button" class="button button-text" data-use-kelly="${recommendedCents}">Use this stake</button>` : ''}</p>` : ''}${ev < 0 ? '<p class="inspection-warning">Negative expected value at this price. The model does not favor this bet.</p>' : ''}`;
  }

  function showBankroll() {
    openDialog('Opening Bankroll', `<form id="bankroll-form" class="research-form"><label>Opening bankroll (USD)<input name="opening" type="number" min="0" max="1000000" step="0.01" value="${(account().openingCents / 100).toFixed(2)}" required></label><p class="inspection-warning">Available bankroll is opening bankroll plus settled profit, minus active stakes. Existing results are not changed.</p><p id="bet-form-error" class="form-error" role="alert"></p><button class="button button-primary" type="submit">${icon('save')}Save bankroll</button></form>`);
  }

  function showSettlement(id) {
    const slip = account().slips.find((entry) => entry.id === id);
    if (!slip) return;
    const suggestion = ui.results.get(slip.id)?.suggestion;
    openDialog('Settle Bet', `<div class="inspection-subtitle"><h3>${escapeHtml(slip.selection)}</h3><p>${money(slip.stakeCents)} at ${slip.odds.toFixed(3)}</p></div>${suggestion ? `<div class="notice">Provider result suggests ${escapeHtml(suggestion.status.toUpperCase())}, observed value ${suggestion.value}. Confirm your book's settlement.</div>` : ''}<form id="settle-bet-form" data-slip="${escapeHtml(id)}" class="research-form"><label>Result<select name="result">${['won', 'lost', 'push', 'void', 'active'].map((value) => `<option value="${value}" ${value === (suggestion?.status || slip.status) ? 'selected' : ''}>${value === 'active' ? 'Active / reopen' : value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label><label>Settlement note<input name="reason" maxlength="200" placeholder="Optional sportsbook settlement note"></label><p class="inspection-warning">Win rate excludes pushes, voids and active bets. ROI includes settled win/loss/push stakes, and excludes voids.</p><p id="bet-form-error" class="form-error" role="alert"></p><button type="submit" class="button button-primary">${icon('check')}Confirm result</button></form>`);
  }

  function renderBets() {
    const wallet = account();
    const metrics = betMetrics(wallet.slips, wallet.openingCents);
    const slips = wallet.slips.filter((slip) => (ui.betTab === 'all' || (ui.betTab === 'active' ? slip.status === 'active' : slip.status !== 'active')) && (ui.betLeague === 'all' || slip.sport === ui.betLeague)).slice().reverse();
    const metricItems = [['Available bankroll', money(metrics.availableCents), `${money(metrics.exposureCents)} in active slips`, 'wallet'], ['Personal win rate', percent(metrics.winRate), `${metrics.wins} wins / ${metrics.losses} losses`, 'target'], ['Settled ROI', percent(metrics.roi), `${money(metrics.profitCents)} net profit`, 'chart-no-axes-combined'], ['Active slips', String(metrics.active).padStart(2, '0'), `${metrics.settled} settled · all leagues`, 'receipt-text']];
    const groups = [...new Set(wallet.slips.map((slip) => slip.sport))].map((sport) => ({ sport, metrics: betMetrics(wallet.slips.filter((slip) => slip.sport === sport)) }));
    return `<div class="ledger-heading"><span class="small-tag">LEDGER · USD · LOCAL STORAGE</span><div class="ledger-actions"><div class="research-tabs" role="group" aria-label="Kelly fraction">${KELLY_FRACTIONS.map((option) => `<button data-kelly-fraction="${option.value}" class="${ui.kellyFraction === option.value ? 'active' : ''}" aria-pressed="${ui.kellyFraction === option.value}">${option.label}</button>`).join('')}</div><button class="button button-secondary" data-bankroll>${icon('wallet')}Bankroll</button><button class="button button-secondary" data-sync-bets ${ui.checking ? 'disabled' : ''}>${icon('refresh-cw')}${ui.checking ? 'Checking...' : 'Check results'}</button></div></div><section class="metrics">${metricItems.map(([label, value, note, symbol]) => `<article class="metric"><div class="metric-top"><span>${label}</span>${icon(symbol)}</div><div class="metric-value">${value}</div><div class="metric-bottom">${note}</div></article>`).join('')}</section><div class="ledger-filter"><div class="research-tabs" role="group" aria-label="Bet status">${['active', 'history', 'all'].map((value) => `<button data-bet-tab="${value}" class="${ui.betTab === value ? 'active' : ''}" aria-pressed="${ui.betTab === value}">${value === 'active' ? 'Active slips' : value === 'history' ? 'Settled history' : 'All bets'}</button>`).join('')}</div><select id="bet-league-filter" aria-label="Bet league"><option value="all">All leagues</option>${Object.keys(SPORT_MARKETS).map((sport) => `<option value="${sport}" ${ui.betLeague === sport ? 'selected' : ''}>${sport.toUpperCase()}</option>`).join('')}</select></div>${slips.length ? `<div class="table-container"><table class="signal-table bet-table"><thead><tr><th>Selection</th><th>Stake / odds</th><th>Result / live update</th><th>Profit</th><th>Action</th></tr></thead><tbody>${slips.map((slip) => {
      const update = ui.results.get(slip.id);
      const profit = betMetrics([slip]).profitCents;
      return `<tr><td><button class="selection-name bet-selection" data-slip-inspect="${escapeHtml(slip.id)}">${escapeHtml(slip.selection)}<small>${slip.sport.toUpperCase()} · ${escapeHtml(slip.game.away.abbreviation)} @ ${escapeHtml(slip.game.home.abbreviation)} · ${escapeHtml(marketLabel(slip.quote.market))}</small></button></td><td>${money(slip.stakeCents)}<small class="cell-note">${slip.odds.toFixed(3)} · ${escapeHtml(slip.quote.book || 'Manual price')}</small></td><td><span class="settlement-status ${slip.status}">${slip.status.toUpperCase()}</span><small class="cell-note">${update?.error ? escapeHtml(update.error) : update?.suggestion ? `Suggested: ${update.suggestion.status} (${update.suggestion.value})` : update?.game ? `${update.game.away.score} : ${update.game.home.score} · ${escapeHtml(update.game.detail)}` : 'Awaiting result check'}</small></td><td class="${profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : ''}">${slip.status === 'active' ? '--' : money(profit)}</td><td><button class="button button-secondary" data-settle="${escapeHtml(slip.id)}">${icon(slip.status === 'active' ? 'check' : 'pencil')}${slip.status === 'active' ? 'Settle' : 'Edit'}</button></td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty-state">' + icon('receipt-text') + '<h3>No bets in this view</h3><p>Tracked selections will appear here.</p><button class="button button-primary" data-nav="engine" style="margin-top:16px">Prediction engine ' + icon('arrow-right') + '</button></div>'}<div class="table-footnote"><span>${ui.syncAt ? `Last result check: ${escapeHtml(timestamp(ui.syncAt))}` : 'Results refresh every 30 seconds while this tracker is visible.'}${ui.syncErrors ? ` · ${ui.syncErrors} unavailable` : ''}</span><span>Settlement requires confirmation.</span></div>${groups.length ? `<section class="status-table"><h2>Historical performance by league</h2><div class="table-container"><table class="signal-table"><thead><tr><th>League</th><th>Wins / losses</th><th>Win rate</th><th>ROI</th><th>Net profit</th></tr></thead><tbody>${groups.map(({ sport, metrics: group }) => `<tr><td>${sport.toUpperCase()}</td><td>${group.wins} / ${group.losses}</td><td>${percent(group.winRate)}</td><td>${percent(group.roi)}</td><td>${money(group.profitCents)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
  }

  function renderMarketTable() {
    if (ui.loading) return '<div class="loading-state market-loading"><span class="loading-spinner"></span><h2>Inspecting the market</h2><p>Loading sportsbook lines and historical box scores.</p></div>';
    const result = ui.result;
    if (ui.error || !result?.signals?.length) return `<div class="empty-state">${icon('database')}<h3>${ui.error ? 'Market feed unavailable' : 'No published signals'}</h3><p>${escapeHtml(ui.error || result?.message || 'Select a matchup and market.')}</p>${ui.error ? '<button class="button button-secondary" style="margin-top:15px" data-market-refresh>Retry market</button>' : ''}</div>`;
    const rows = result.signals.map((signal, index) => ({ ...signal, index, risk: Number.isFinite(signal.analysis.probability) ? classifyRisk(signal.analysis.probability, signal.quote.price) : null })).filter((signal) => (!state.search || `${signal.quote.subject} ${result.game.home.name} ${result.game.away.name}`.toLowerCase().includes(state.search.toLowerCase()))
      && (state.filter === 'all' || state.filter === 'positive' && signal.analysis.ev > 0 || state.filter === 'strong' && signal.analysis.probability >= 0.65 || state.filter === 'mispriced' && signal.risk?.mispriced || state.filter === 'saved' && state.saved.has(`${state.sport}:${result.game.id}:${quoteKey(signal.quote)}`)));
    if (!rows.length) return '<div class="empty-state"><h3>No matching signals</h3><p>Adjust your search or filters.</p></div>';
    return `${result.partial ? '<div class="notice">Some historical feeds are unavailable. Actual sample sizes are shown below.</div>' : ''}<div class="table-container"><table class="signal-table market-table"><thead><tr><th>Selection / market</th><th>Repetition</th><th>Model probability</th><th>Best exact-line odds</th><th>EV</th><th>Risk</th><th>Actions</th></tr></thead><tbody>${rows.map(({ quote, analysis, index, risk }) => `<tr><td><button class="selection-name market-selection" data-market-detail="${index}">${escapeHtml(quoteLabel(quote))}<small>${escapeHtml(marketLabel(quote.market))}</small></button></td><td>${analysis.wins}W · ${analysis.losses}L · ${analysis.pushes}P<small class="cell-note">${analysis.sample} observed games</small></td><td><span class="probability-value">${percent(analysis.probability)}</span><small class="cell-note">${analysis.probability == null ? 'Insufficient valid history' : 'Uncalibrated estimate'}</small></td><td>${quote.price.toFixed(2)} / ${americanOdds(quote.price)}<small class="cell-note">${escapeHtml(quote.book)}</small></td><td><span class="${analysis.ev >= 0 ? 'profit-positive' : 'profit-negative'}">${signedEV(analysis.ev)}</span></td><td>${risk ? `<span class="risk-tag risk-${risk.tier}" title="${risk.mispriced ? `Model rates this ${risk.tier}-risk, but the market's odds imply ${risk.byOdds}-risk` : `Model and market agree: ${risk.tier}-risk`}">${risk.tier}${risk.mispriced ? ' ⚠' : ''}</span>` : '<span class="no-value">--</span>'}</td><td><div class="signal-actions"><button class="icon-button ${state.saved.has(`${state.sport}:${result.game.id}:${quoteKey(quote)}`) ? 'saved' : ''}" data-market-save="${index}" title="Save signal" aria-label="Save ${escapeHtml(quoteLabel(quote))}">${icon('bookmark')}</button><button class="button button-secondary" data-market-bet="${index}">${icon('plus')}Track Bet</button></div></td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderEngine(metrics, moneylineTable) {
    if (!availableCategories().includes(ui.category)) ui.category = availableCategories()[0];
    const markets = availableMarkets();
    if (!markets.includes(ui.market)) ui.market = markets[0];
    const game = availableGame();
    const performance = betMetrics(account().slips, account().openingCents);
    return `${metrics}<div class="performance-ribbon"><span>${icon('wallet')}Available <strong>${money(performance.availableCents)}</strong></span><span>Personal win rate <strong>${percent(performance.winRate)}</strong></span><span>ROI <strong>${percent(performance.roi)}</strong></span><button data-nav="bets">Bet Tracker ${icon('arrow-up-right')}</button></div><div class="engine-summary"><span><strong>Auditable signals · ${state.sport.toUpperCase()}</strong><br>Actual observations · source endpoints · explicit statistical weights</span><label class="sample-control">Sample window<select id="sample-window" aria-label="Historical sample window"><option value="10" ${state.window === 10 ? 'selected' : ''}>Last 10 games</option><option value="20" ${state.window === 20 ? 'selected' : ''}>Last 20 games</option></select></label></div><div class="research-tabs market-categories" role="group" aria-label="Bet categories">${availableCategories().map((category) => `<button data-category="${category}" class="${ui.category === category ? 'active' : ''}" aria-pressed="${ui.category === category}">${categories[category]}</button>`).join('')}</div>${ui.category === 'moneyline' ? '' : `<div class="market-controls"><label>Matchup<select id="market-event" aria-label="Market matchup">${state.games.filter((entry) => !entry.completed).map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === game?.id ? 'selected' : ''}>${escapeHtml(entry.away.abbreviation)} @ ${escapeHtml(entry.home.abbreviation)} · ${escapeHtml(new Date(entry.date).toLocaleDateString())}</option>`).join('')}</select></label><label>Market<select id="market-key" aria-label="Specific betting market">${markets.map((key) => `<option value="${key}" ${ui.market === key ? 'selected' : ''}>${escapeHtml(marketLabel(key))}</option>`).join('')}</select></label><button class="icon-button" data-market-refresh title="Refresh selected market" aria-label="Refresh selected market" ${ui.loading ? 'disabled' : ''}>${icon('refresh-cw')}</button></div>`}<div class="filter-bar"><label class="search-box">${icon('search')}<input id="signal-search" type="search" aria-label="Search teams" placeholder="Search teams or players..." value="${escapeHtml(state.search)}"></label><select id="signal-filter" aria-label="Filter signals">${[['all', 'All signals'], ['positive', 'Positive EV'], ['strong', 'Probability 65%+'], ['mispriced', 'Mispriced (model vs. market)'], ['saved', 'Saved signals']].map(([value, label]) => `<option value="${value}" ${state.filter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><section id="engine-table">${ui.category === 'moneyline' ? moneylineTable : renderMarketTable()}</section><div class="table-footnote"><span>${icon('info')}${ui.category === 'moneyline' ? 'Two-outcome recent-form baseline.' : 'Historical values tested against the current line, not a backtested betting record.'}</span><span>${ui.result?.fetchedAt ? `Prices: ${escapeHtml(timestamp(ui.result.fetchedAt))}` : 'Provider-dependent coverage'}</span></div>`;
  }

  async function loadMarket(force = false) {
    if (state.view !== 'engine' || ui.category === 'moneyline') return;
    const game = availableGame();
    if (!game) return;
    const key = `${state.sport}:${game.id}:${ui.market}:${state.window}`;
    if (!force && ui.result?.key === key) return;
    ui.controller?.abort();
    ui.controller = new AbortController();
    const request = ++ui.request;
    ui.loading = true;
    ui.error = '';
    ui.result = null;
    render();
    try {
      const result = await api(`markets?sport=${state.sport}&event=${encodeURIComponent(game.id)}&market=${ui.market}&window=${state.window}`, ui.controller.signal, 180000);
      if (request !== ui.request) return;
      ui.result = { ...result, key };
    } catch (error) { if (request === ui.request) ui.error = error.message; }
    if (request === ui.request) { ui.loading = false; if (state.view === 'engine') render(); }
  }

  async function syncBets() {
    if (ui.checking || state.view !== 'bets') return;
    const slips = account().slips.filter((slip) => slip.status === 'active');
    ui.checking = true;
    ui.syncErrors = 0;
    render();
    const events = [...new Map(slips.map((slip) => [`${slip.sport}:${slip.eventId}`, slip])).values()];
    let next = 0;
    async function worker() {
      while (next < events.length) {
        const slip = events[next++];
        try {
          const summary = await api(`summary?sport=${slip.sport}&event=${encodeURIComponent(slip.eventId)}`, null);
          for (const entry of slips.filter((item) => item.sport === slip.sport && item.eventId === slip.eventId)) ui.results.set(entry.id, { game: summary.game, suggestion: suggestedResult(entry, summary) });
        } catch {
          ui.syncErrors += 1;
          for (const entry of slips.filter((item) => item.sport === slip.sport && item.eventId === slip.eventId)) ui.results.set(entry.id, { error: 'Result feed unavailable' });
        }
      }
    }
    await Promise.all([worker(), worker()]);
    ui.checking = false;
    ui.syncAt = new Date().toISOString();
    if (state.view === 'bets') render();
  }

  function download(data, name, type = 'application/json') {
    const blob = new Blob([type === 'application/json' ? JSON.stringify(data, null, 2) : data], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.category) { ui.category = button.dataset.category; ui.market = availableMarkets()[0]; state.search = ''; state.filter = 'all'; render(); void loadMarket(true); }
    if (button.hasAttribute('data-market-refresh')) void loadMarket(true);
    if (button.hasAttribute('data-market-detail')) inspect(marketSignal(Number(button.dataset.marketDetail)));
    if (button.hasAttribute('data-market-bet')) showBetForm(marketSignal(Number(button.dataset.marketBet)));
    if (button.hasAttribute('data-market-save')) {
      const signal = marketSignal(Number(button.dataset.marketSave));
      if (signal) { const key = `${state.sport}:${signal.game.id}:${quoteKey(signal.quote)}`; if (state.saved.has(key)) state.saved.delete(key); else state.saved.add(key); try { localStorage.setItem('sportsstat-saved', JSON.stringify([...state.saved])); } catch { toast('Saved signals could not be persisted.'); } render(); }
    }
    if (button.dataset.betGame) showBetForm(moneylineSignal(button.dataset.betGame));
    if (button.dataset.inspectionTab) inspect(inspected, button.dataset.inspectionTab);
    if (button.hasAttribute('data-track-current')) showBetForm(inspected);
    if (button.hasAttribute('data-export-provenance') && inspected) download(inspected, 'sportsstat-provenance.json');
    if (button.hasAttribute('data-bankroll')) showBankroll();
    if (button.dataset.betTab) { ui.betTab = button.dataset.betTab; render(); }
    if (button.dataset.kellyFraction) {
      ui.kellyFraction = Number(button.dataset.kellyFraction);
      try { localStorage.setItem('sportsstat-kelly-fraction', String(ui.kellyFraction)); } catch { /* persistence is best-effort */ }
      const form = document.querySelector('#track-bet-form');
      if (form) {
        form.querySelectorAll('[data-kelly-fraction]').forEach((toggle) => {
          const active = Number(toggle.dataset.kellyFraction) === ui.kellyFraction;
          toggle.classList.toggle('active', active);
          toggle.setAttribute('aria-pressed', String(active));
        });
        updateStakePreview();
      }
      render();
    }
    if (button.dataset.useKelly) {
      const cents = Number(button.dataset.useKelly);
      const stakeInput = document.querySelector('#track-bet-form input[name="stake"]');
      if (stakeInput && Number.isFinite(cents) && cents > 0) { stakeInput.value = (cents / 100).toFixed(2); updateStakePreview(); }
    }
    if (button.dataset.settle) showSettlement(button.dataset.settle);
    if (button.hasAttribute('data-sync-bets')) void syncBets();
    if (button.dataset.slipInspect) {
      const slip = account().slips.find((entry) => entry.id === button.dataset.slipInspect);
      if (slip) { inspect({ game: slip.game, quote: { ...slip.quote, price: slip.odds }, label: slip.selection, analysis: slip.model || {}, comparisons: [{ ...slip.quote, price: slip.odds }] }, 'sources'); document.querySelector('[data-track-current]').hidden = true; }
    }
  });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'sample-window') { state.window = Number(event.target.value); onWindowChange(); render(); void loadMarket(true); }
    if (event.target.id === 'market-event') { ui.eventId = event.target.value; void loadMarket(true); }
    if (event.target.id === 'market-key') { ui.market = event.target.value; void loadMarket(true); }
    if (event.target.id === 'bet-league-filter') { ui.betLeague = event.target.value; render(); }
  });
  document.addEventListener('input', (event) => { if (event.target.closest('#track-bet-form')) updateStakePreview(); });
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!['track-bet-form', 'bankroll-form', 'settle-bet-form'].includes(form.id)) return;
    event.preventDefault();
    try {
      const values = new FormData(form);
      if (form.id === 'track-bet-form') updateAccount((wallet) => {
        const openingCents = values.has('opening') ? Math.round(Number(values.get('opening')) * 100) : wallet.openingCents;
        if (!Number.isSafeInteger(openingCents) || openingCents < 0 || openingCents > 100000000) throw new Error('Enter a valid opening bankroll.');
        const slip = createSlip(tracking, values.get('stake'), values.get('odds'), betMetrics(wallet.slips, openingCents).availableCents);
        slip.quote.book = String(values.get('book')).trim();
        slip.quote.priceEntry = Number(values.get('odds')) === tracking.quote.price ? 'Provider price' : 'Manually entered price';
        return { openingCents, slips: [...wallet.slips, slip] };
      });
      if (form.id === 'bankroll-form') updateAccount((wallet) => {
        const openingCents = Math.round(Number(values.get('opening')) * 100);
        if (!Number.isSafeInteger(openingCents) || openingCents < 0 || openingCents > 100000000) throw new Error('Enter a bankroll from $0 to $1,000,000.');
        return { ...wallet, openingCents };
      });
      if (form.id === 'settle-bet-form') updateAccount((wallet) => ({ ...wallet, slips: wallet.slips.map((slip) => slip.id === form.dataset.slip ? settleSlip(slip, String(values.get('result')), String(values.get('reason')).trim() || 'Manual confirmation') : slip) }));
      document.querySelector('#detail-dialog').close();
      render();
      toast(form.id === 'track-bet-form' ? 'Bet saved to your active slips.' : 'Ledger updated.');
    } catch (error) { document.querySelector('#bet-form-error').textContent = error.message; }
  });
  window.addEventListener('storage', (event) => { if (event.key === 'sportsstat-ledger-v2') { ui.account = readAccounts(); render(); } });
  setInterval(() => { if (state.view === 'bets' && !document.hidden && !document.querySelector('#detail-dialog').open && document.querySelector('#auto-refresh').checked) void syncBets(); }, 30000);

  return {
    renderEngine, renderBets, renderMarketTable, inspectMoneyline: (id) => inspect(moneylineSignal(id)),
    advancedActive: () => state.view === 'engine' && ui.category !== 'moneyline',
    refresh: (force = false) => { if (state.view === 'engine') void loadMarket(force); if (state.view === 'bets') void syncBets(); },
    reset: () => { ui.controller?.abort(); ui.request += 1; ui.result = null; ui.loading = false; ui.error = ''; ui.eventId = ''; ui.results.clear(); if (!availableCategories().includes(ui.category)) ui.category = availableCategories()[0]; ui.market = availableMarkets()[0]; },
    canExport: () => state.view === 'bets' ? account().slips.length > 0 : state.view === 'engine' && ui.category !== 'moneyline' && Boolean(ui.result?.signals?.length),
    exportView: () => {
      if (state.view === 'bets') { download({ ...account(), metrics: betMetrics(account().slips, account().openingCents) }, 'sportsstat-ledger.json'); return true; }
      if (state.view === 'engine' && ui.category !== 'moneyline') { if (ui.result) download(ui.result, `sportsstat-${state.sport}-markets.json`); return true; }
      return false;
    },
  };
}