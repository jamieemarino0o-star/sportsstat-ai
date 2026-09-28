const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const percent = (value, digits = 1) => Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
const timestamp = (value) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not available';
const insightIcon = { positive: 'circle-check', warning: 'triangle-alert', info: 'info' };
const STRATA_TABS = [['byRiskTier', 'Risk tier'], ['byOddsBracket', 'Odds bracket'], ['bySport', 'Sport']];
const AUDIT_SPORTS = ['nfl', 'nba', 'wnba', 'mlb', 'nhl', 'epl'];

// Reads the same localStorage key research.js's bet tracker uses for its Quarter/Half Kelly toggle,
// so the audit's Kelly-grid insight can compare the historical recommendation against whichever
// fraction the user is actually using -- without the two modules needing to share any live state.
function readKellyFraction() {
  const stored = Number(localStorage.getItem('sportsstat-kelly-fraction'));
  return [0.25, 0.5].includes(stored) ? stored : 0.25;
}

export function createAuditWorkspace({ state, api, render, icons, toast }) {
  const ui = { loading: false, error: '', data: null, sport: 'all', strata: 'byRiskTier', search: '', outcome: 'all', controller: null, request: 0 };

  async function load(force = false) {
    if (!force && ui.data && ui.data.sport === (ui.sport === 'all' ? null : ui.sport)) return;
    ui.controller?.abort();
    ui.controller = new AbortController();
    const request = ++ui.request;
    ui.loading = true;
    ui.error = '';
    render();
    try {
      const query = ui.sport === 'all' ? '' : `&sport=${ui.sport}`;
      const data = await api(`audit?kellyFraction=${readKellyFraction()}${query}`, ui.controller.signal);
      if (request !== ui.request) return;
      ui.data = data;
    } catch (error) {
      if (request === ui.request && error.name !== 'AbortError') ui.error = error.message;
    }
    if (request === ui.request) { ui.loading = false; render(); }
  }

  function download(payload, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderKpis(data) {
    const items = [
      ['Total ROI', percent(data.roi.roi, 2), `${data.roi.bets} decisive bets`, 'chart-no-axes-combined'],
      ['Win rate', percent(data.winRate.winRate), `${data.winRate.wins}W / ${data.winRate.losses}L`, 'target'],
      ['Brier score', Number.isFinite(data.brier) ? data.brier.toFixed(4) : '--', '0 = perfect, 1 = worst', 'crosshair'],
      ['Sample size', String(data.sample), data.sport ? data.sport.toUpperCase() : 'All sports', 'database'],
    ];
    return `<section class="metrics">${items.map(([label, value, note, symbol]) => `<article class="metric"><div class="metric-top"><span>${label}</span>${icon(symbol)}</div><div class="metric-value">${value}</div><div class="metric-bottom">${note}</div></article>`).join('')}</section>`;
  }

  function renderPortfolioDetail(data) {
    const rows = [
      ['Closing Line Value', data.clv ? `${percent(data.clv.averageClv, 2)} avg · beats close ${percent(data.clv.beatCloseRate)} of the time (n=${data.clv.sample})` : 'No trials with both an opening and closing price yet'],
      ['Max drawdown', `${data.drawdown.maxDrawdown.toFixed(2)}u (${percent(data.drawdown.maxDrawdownPct)}) from a ${data.drawdown.startingBankroll}u starting bankroll`],
      ['Walk-forward validation', data.walkForward.windows.length ? `${data.walkForward.windows.length} rolling windows of ${data.walkForward.windowSize} · drift ${data.walkForward.drift >= 0 ? '+' : ''}${data.walkForward.drift.toFixed(4)} (recent vs. earliest Brier)` : `Needs ${data.walkForward.windowSize}+ resolved trials (currently ${data.walkForward.sample})`],
      ['Fractional Kelly grid search', data.kellyGrid.grid.length ? `Recommends ${data.kellyGrid.recommendedFraction} fraction (n=${data.kellyGrid.sample}, capped at 40% max drawdown)` : `Needs ${data.kellyGrid.minSample}+ decisive priced trials (currently ${data.kellyGrid.sample})`],
    ];
    return `<section class="status-table"><h2>Portfolio detail</h2><div class="table-container"><table class="signal-table"><tbody>${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  function renderInsights(data) {
    return `<section class="status-table"><h2>Amelioration &amp; Insights</h2><div class="insight-list">${data.insights.map((entry) => `<div class="insight-item ${entry.level}">${icon(insightIcon[entry.level] || 'info')}<span>${escapeHtml(entry.message)}</span></div>`).join('')}</div></section>`;
  }

  function renderStrata(data) {
    const buckets = data[ui.strata] || [];
    return `<section class="status-table"><div class="section-heading"><div class="section-title">${icon('layers-2')}<h2>Stratified performance audit</h2></div></div><div class="research-tabs" role="group" aria-label="Stratification">${STRATA_TABS.map(([key, label]) => `<button data-strata="${key}" class="${ui.strata === key ? 'active' : ''}" aria-pressed="${ui.strata === key}">${label}</button>`).join('')}</div>${buckets.length ? `<div class="table-container"><table class="signal-table"><thead><tr><th>Bucket</th><th>Sample</th><th>Win rate</th><th>ROI</th><th>Brier</th></tr></thead><tbody>${buckets.map((bucket) => `<tr><td>${escapeHtml(bucket.label || bucket.key)}</td><td>${bucket.sample}</td><td>${percent(bucket.winRate?.winRate)}</td><td class="${bucket.roi?.roi > 0 ? 'profit-positive' : bucket.roi?.roi < 0 ? 'profit-negative' : ''}">${bucket.sample ? percent(bucket.roi?.roi, 2) : '--'}</td><td>${Number.isFinite(bucket.brier) ? bucket.brier.toFixed(3) : '--'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="table-footnote">No resolved trials yet.</p>'}<p class="table-footnote"><span>${icon('info')}A blended total can hide a losing slice -- compare tabs above before trusting the headline ROI.</span></p></section>`;
  }

  function filteredHistory(data) {
    const query = ui.search.trim().toLowerCase();
    return (data.history || []).filter((row) => {
      if (ui.outcome === 'resolved' && !row.resolved) return false;
      if (ui.outcome === 'pending' && row.resolved) return false;
      if (ui.outcome === 'win' && (!row.resolved || row.favoriteCorrect !== true)) return false;
      if (ui.outcome === 'loss' && (!row.resolved || row.favoriteCorrect !== false)) return false;
      if (!query) return true;
      return `${row.homeTeam} ${row.awayTeam} ${row.sport} ${row.eventId}`.toLowerCase().includes(query);
    });
  }

  function outcomePill(row) {
    if (!row.resolved) return '<span class="outcome-pill pending">PENDING</span>';
    if (row.outcome === 0.5) return '<span class="outcome-pill push">PUSH</span>';
    if (row.favoriteCorrect == null) return '<span class="outcome-pill pending">NO PICK</span>';
    return row.favoriteCorrect ? '<span class="outcome-pill win">WIN</span>' : '<span class="outcome-pill loss">LOSS</span>';
  }

  function renderHistory(data) {
    return `<section class="status-table"><div class="section-heading"><div class="section-title">${icon('list')}<h2>Ledger history</h2></div><button class="button button-secondary" data-audit-export>${icon('download')}Export JSON</button></div><div class="audit-toolbar"><div class="audit-search"><label class="search-box">${icon('search')}<input type="search" data-audit-search value="${escapeHtml(ui.search)}" placeholder="Search team, sport or event ID..." aria-label="Search ledger history"></label><select data-audit-outcome aria-label="Filter by outcome"><option value="all" ${ui.outcome === 'all' ? 'selected' : ''}>All predictions</option><option value="resolved" ${ui.outcome === 'resolved' ? 'selected' : ''}>Resolved only</option><option value="pending" ${ui.outcome === 'pending' ? 'selected' : ''}>Pending only</option><option value="win" ${ui.outcome === 'win' ? 'selected' : ''}>Wins</option><option value="loss" ${ui.outcome === 'loss' ? 'selected' : ''}>Losses</option></select></div></div><div id="audit-history-body">${renderHistoryBody(data)}</div></section>`;
  }

  // A dedicated update path for the history table, separate from the full-page render(): the search
  // box has no stable id the way #signal-search does in app.js's own focus-preservation logic, so
  // re-running the whole-page render() on every keystroke would steal focus from the input the user
  // is actively typing into. Only the table body is replaced instead, exactly as app.js/research.js
  // already do for their own live-filtered tables (#engine-table).
  function renderHistoryBody(data) {
    const rows = filteredHistory(data);
    return rows.length ? `<div class="table-container"><table class="signal-table"><thead><tr><th>Matchup</th><th>Selection</th><th>Model prob.</th><th>Opening / closing odds</th><th>Result</th><th>Outcome</th></tr></thead><tbody>${rows.slice(0, 200).map((row) => `<tr><td>${escapeHtml(row.sport?.toUpperCase())} · ${escapeHtml(row.awayTeam || '--')} @ ${escapeHtml(row.homeTeam || '--')}<small class="cell-note">Event ${escapeHtml(row.eventId)} · ${escapeHtml(timestamp(row.loggedAt))}</small></td><td>${row.selection ? escapeHtml(row.selection === 'home' ? row.homeTeam || 'Home' : row.awayTeam || 'Away') : '<span class="no-value">--</span>'}</td><td>${percent(row.homeProbability)}</td><td>${row.openingPrice ? row.openingPrice.toFixed(2) : '--'} ${row.closingPrice && row.closingPrice !== row.openingPrice ? `→ ${row.closingPrice.toFixed(2)}` : ''}</td><td>${row.resolved ? `${row.homeScore} - ${row.awayScore}` : '<span class="no-value">In progress</span>'}</td><td>${outcomePill(row)}</td></tr>`).join('')}</tbody></table></div>${rows.length > 200 ? `<p class="table-footnote">Showing the first 200 of ${rows.length} matching rows. Narrow your search to see more specific results.</p>` : ''}` : `<div class="empty-state">${icon('receipt-text')}<h3>No matching predictions</h3><p>Adjust your search or filter.</p></div>`;
  }

  function renderAudit() {
    if (ui.loading && !ui.data) return '<div class="loading-state"><span class="loading-spinner"></span><h2>Auditing the ledger</h2><p>Reading resolved predictions and running the backtest engine.</p></div>';
    if (ui.error && !ui.data) return `<div class="empty-state">${icon('wifi-off')}<h3>Audit unavailable</h3><p>${escapeHtml(ui.error)}</p></div><div style="display:flex;justify-content:center;gap:12px;margin-top:20px"><button class="button button-primary" data-audit-retry>${icon('refresh-cw')}Try again</button></div>`;
    const data = ui.data;
    if (!data) return '<div class="empty-state"><h3>Loading...</h3></div>';
    return `<div class="ledger-heading"><span class="small-tag">QUANT AUDIT · LEDGER-DRIVEN</span><div class="ledger-actions"><select data-audit-sport aria-label="Filter by sport"><option value="all" ${ui.sport === 'all' ? 'selected' : ''}>All sports</option>${AUDIT_SPORTS.map((sport) => `<option value="${sport}" ${ui.sport === sport ? 'selected' : ''}>${sport.toUpperCase()}</option>`).join('')}</select><button class="button button-secondary" data-audit-refresh ${ui.loading ? 'disabled' : ''}>${icon('refresh-cw')}${ui.loading ? 'Refreshing...' : 'Refresh'}</button></div></div>${renderKpis(data)}${renderInsights(data)}${renderStrata(data)}${renderPortfolioDetail(data)}${renderHistory(data)}<div class="table-footnote"><span>${icon('info')}Generated ${escapeHtml(timestamp(data.generatedAt))} from data/predictions.jsonl.</span><span>Backtest math: flat 1-unit ROI, ledger-reconciled Brier score, opening-vs-closing CLV.</span></div>`;
  }

  document.addEventListener('click', (event) => {
    if (state.view !== 'audit') return;
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.strata) { ui.strata = button.dataset.strata; render(); }
    if (button.hasAttribute('data-audit-retry') || button.hasAttribute('data-audit-refresh')) void load(true);
    if (button.hasAttribute('data-audit-export')) { if (ui.data) { download(ui.data, `sportsstat-audit-${ui.sport}-${new Date().toISOString().slice(0, 10)}.json`); toast('Audit report exported.'); } }
  });
  document.addEventListener('input', (event) => {
    if (state.view !== 'audit') return;
    if (event.target.matches('[data-audit-search]')) {
      ui.search = event.target.value;
      const container = document.querySelector('#audit-history-body');
      if (container && ui.data) { container.innerHTML = renderHistoryBody(ui.data); icons(); }
    }
  });
  document.addEventListener('change', (event) => {
    if (state.view !== 'audit') return;
    if (event.target.matches('[data-audit-sport]')) { ui.sport = event.target.value; void load(true); }
    if (event.target.matches('[data-audit-outcome]')) {
      ui.outcome = event.target.value;
      const container = document.querySelector('#audit-history-body');
      if (container && ui.data) { container.innerHTML = renderHistoryBody(ui.data); icons(); }
    }
  });

  return {
    renderAudit,
    refresh: (force = false) => { if (state.view === 'audit') void load(force); },
  };
}
