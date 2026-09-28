export function normalizeEvent(event, sport, source = null) {
  const competition = event.competitions?.[0];
  if (!competition) return null;
  const normalizeTeam = (side) => {
    const competitor = competition.competitors?.find((item) => item.homeAway === side);
    if (!competitor?.team) return null;
    const periods = (competitor.linescores || []).slice(0, 2).map((period) => {
      const value = period.value ?? period.displayValue;
      return value === undefined || value === null || String(value).trim() === '' ? NaN : Number(value);
    });
    return {
      id: competitor.team.id,
      name: competitor.team.displayName,
      shortName: competitor.team.shortDisplayName || competitor.team.name,
      abbreviation: competitor.team.abbreviation,
      logo: competitor.team.logo || competitor.team.logos?.[0]?.href || '',
      score: Number(competitor.score?.value ?? competitor.score ?? 0),
      firstHalfScore: periods.length === 2 && periods.every(Number.isFinite)
        ? periods.reduce((total, value) => total + value, 0) : null,
      record: competitor.records?.find((record) => record.type === 'total')?.summary || '--',
      winner: competitor.winner === true,
    };
  };
  const home = normalizeTeam('home');
  const away = normalizeTeam('away');
  if (!home || !away) return null;
  const status = event.status || competition.status || {};
  return {
    id: event.id,
    sport,
    source,
    date: event.date,
    name: event.name || `${away.name} at ${home.name}`,
    home,
    away,
    state: status.type?.state || 'pre',
    completed: status.type?.completed === true,
    detail: status.type?.shortDetail || status.type?.detail || 'Scheduled',
    clock: status.displayClock,
    period: status.period,
    venue: competition.venue?.fullName || 'Venue to be confirmed',
    broadcast: competition.broadcasts?.flatMap((item) => item.names || []).join(', ') || '',
  };
}

function sortedCompletedGames(events, teamId, before) {
  return events
    .filter((game) => game.completed && new Date(game.date) < new Date(before)
      && [game.home.id, game.away.id].includes(teamId))
    .sort((first, second) => new Date(second.date) - new Date(first.date))
    .filter((game, index, all) => all.findIndex((item) => item.id === game.id) === index);
}

function outcomeFor(game, teamId) {
  const team = game.home.id === teamId ? game.home : game.away;
  const opponent = game.home.id === teamId ? game.away : game.home;
  return team.score === opponent.score ? 0.5 : Number(team.score > opponent.score);
}

// Parses an ESPN "W-L" or "W-L-T" record summary (e.g. "10-3", "7-5-1") into a win percentage.
// Used as a free strength-of-schedule proxy: it rides along on data already fetched with the
// schedule, so no extra API calls are needed to know how strong a team's past opponents were.
function parseRecord(summary) {
  if (typeof summary !== 'string') return null;
  const parts = summary.split('-').map(Number);
  if (parts.length < 2 || parts.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const [wins, losses, ties = 0] = parts;
  const total = wins + losses + ties;
  if (total <= 0) return null;
  return { wins, losses, ties, winPct: (wins + ties * 0.5) / total };
}

function opponentStrength(game, teamId) {
  const opponent = game.home.id === teamId ? game.away : game.home;
  return parseRecord(opponent.record);
}

const BASELINE_MIN_SAMPLE = 8;
const BASELINE_MAX_SAMPLE = 30;
const PRIOR_STRENGTH = 4;
const SOS_MIN_SAMPLE = 3;
// A team's schedule-adjusted probability is nudged by up to this much per full standard deviation
// of opponent win-rate above/below .500 - conservative enough that it corrects for obvious
// "padded stats vs. weak opponents" cases without letting a small sample of odd results dominate.
const SOS_WEIGHT = 0.3;

export function recentGames(events, teamId, before = new Date().toISOString(), window = 10) {
  return sortedCompletedGames(events, teamId, before).slice(0, window === 20 ? 20 : 10);
}

// decay applies exponential recency weighting within the window (1 = every game weighted equally,
// as before; <1 means more recent games count more). The Bayesian prior mean is shrunk toward the
// team's own longer-run baseline (the games just beyond the window) once enough of them exist,
// instead of a flat 0.5 league-average assumption. sosWeight defaults to the module constant but is
// exposed as a parameter so the app can explore alternative values and let the ledger (see
// src/ledger.js's bestSosWeight) discover which one is best calibrated over time.
export function historicalTrend(events, teamId, before = new Date().toISOString(), window = 10, decay = 1, sosWeight = SOS_WEIGHT) {
  const all = sortedCompletedGames(events, teamId, before);
  const games = all.slice(0, window === 20 ? 20 : 10);
  const outcomes = games.map((game) => outcomeFor(game, teamId));
  const wins = outcomes.reduce((total, value) => total + value, 0);
  const rate = Number.isFinite(decay) && decay > 0 && decay <= 1 ? decay : 1;
  const weight = Number.isFinite(sosWeight) && sosWeight >= 0 && sosWeight <= 1 ? sosWeight : SOS_WEIGHT;
  const weights = outcomes.map((value, index) => rate ** index);
  const weightedWins = outcomes.reduce((total, value, index) => total + value * weights[index], 0);
  const effectiveSample = weights.reduce((total, value) => total + value, 0);
  const baseline = all.slice(games.length, games.length + BASELINE_MAX_SAMPLE).map((game) => outcomeFor(game, teamId));
  const baselineMean = baseline.length >= BASELINE_MIN_SAMPLE ? baseline.reduce((total, value) => total + value, 0) / baseline.length : 0.5;
  const rawProbability = games.length >= 5 ? (weightedWins + PRIOR_STRENGTH * baselineMean) / (effectiveSample + PRIOR_STRENGTH) : null;
  const opponentRecords = games.map((game, index) => { const record = opponentStrength(game, teamId); return record ? { winPct: record.winPct, weight: weights[index] } : null; }).filter(Boolean);
  const opponentWeight = opponentRecords.reduce((total, entry) => total + entry.weight, 0);
  const averageOpponentWinPct = opponentRecords.length >= SOS_MIN_SAMPLE && opponentWeight > 0
    ? opponentRecords.reduce((total, entry) => total + entry.winPct * entry.weight, 0) / opponentWeight : null;
  const sosAdjustment = averageOpponentWinPct != null && weight !== 0 ? weight * (averageOpponentWinPct - 0.5) : 0;
  const probability = rawProbability != null ? Math.min(0.99, Math.max(0.01, rawProbability + sosAdjustment)) : null;
  return {
    sample: games.length,
    wins,
    outcomes,
    observations: games.map((game, index) => ({
      eventId: game.id, date: game.date, matchup: `${game.away.name || game.away.id} at ${game.home.name || game.home.id}`,
      homeScore: game.home.score, awayScore: game.away.score, outcome: outcomes[index],
      weight: weights[index] / effectiveSample, source: game.source || null,
    })),
    frequency: games.length ? wins / games.length : null,
    probability,
    rawProbability,
    decay: rate,
    baselineMean: baseline.length >= BASELINE_MIN_SAMPLE ? baselineMean : null,
    baselineSample: baseline.length,
    sos: { averageOpponentWinPct, adjustment: sosAdjustment, sample: opponentRecords.length, weight },
  };
}

export function predictGame(game, homeHistory, awayHistory, window = 10, biasFactor = 0, decay = 1, sosWeight = SOS_WEIGHT) {
  const cutoff = new Date(Math.min(Date.now(), new Date(game.date).getTime())).toISOString();
  const home = historicalTrend(homeHistory, game.home.id, cutoff, window, decay, sosWeight);
  const away = historicalTrend(awayHistory, game.away.id, cutoff, window, decay, sosWeight);
  const provenance = { version: 'recent-form-v3', cutoff, window, decay: home.decay, sosWeight: home.sos.weight, prior: { strength: 4, homeBaseline: home.baselineMean, homeBaselineSample: home.baselineSample, awayBaseline: away.baselineMean, awayBaselineSample: away.baselineSample }, minimum: 5, weighting: `${decay < 1 ? `Exponential recency weighting (decay ${decay}) within each team's window` : `Equal game weight within each team's window`}; each team's prior is shrunk toward its own longer-run baseline win rate when at least ${BASELINE_MIN_SAMPLE} older games are available, otherwise a neutral 50% prior. Strength-of-schedule: each team's win rate is nudged by ${home.sos.weight} times how far their recency-weighted average opponent record sits from .500 (using at least ${SOS_MIN_SAMPLE} opponent records), so results against weak schedules count for less and results against strong schedules count for more.`, sources: [...home.observations.map((entry) => ({ ...entry, cohort: 'Home form' })), ...away.observations.map((entry) => ({ ...entry, cohort: 'Away form' }))] };
  if (home.probability === null || away.probability === null || game.completed || game.sport === 'epl') {
    return { home, away, probability: null, selection: null, sample: Math.min(home.sample, away.sample), provenance };
  }
  const homeStrength = home.probability / (1 - home.probability);
  const awayStrength = away.probability / (1 - away.probability);
  const rawHomeProbability = homeStrength / (homeStrength + awayStrength);
  // Nudge against the model's own measured historical bias (see /api/predictions/stats), then re-derive the
  // selection from the corrected probability so the two stay consistent.
  const homeProbability = Math.min(0.999, Math.max(0.001, rawHomeProbability - (Number.isFinite(biasFactor) ? biasFactor : 0)));
  const selection = homeProbability >= 0.5 ? 'home' : 'away';
  return { home, away, selection, probability: selection === 'home' ? homeProbability : 1 - homeProbability, homeProbability, sample: Math.min(home.sample, away.sample), provenance };
}

export function expectedValue(probability, decimalOdds) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1
    || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  return (probability * decimalOdds - 1) * 100;
}

export function impliedProbability(decimalOdds) {
  return Number.isFinite(decimalOdds) && decimalOdds > 1 ? 1 / decimalOdds : null;
}

export function americanOdds(decimalOdds) {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return '--';
  return decimalOdds >= 2 ? `+${Math.round((decimalOdds - 1) * 100)}` : String(Math.round(-100 / (decimalOdds - 1)));
}

export function matchOdds(game, events) {
  const normalize = (value) => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const event = events.find((item) => normalize(item.home_team) === normalize(game.home.name)
    && normalize(item.away_team) === normalize(game.away.name)
    && Math.abs(new Date(item.commence_time) - new Date(game.date)) < 6 * 60 * 60 * 1000);
  if (!event) return [];
  return (event.bookmakers || []).flatMap((bookmaker) => {
    if (!['draftkings', 'fanduel', 'betmgm'].includes(bookmaker.key)) return [];
    const market = bookmaker.markets?.find((item) => item.key === 'h2h');
    return (market?.outcomes || []).flatMap((outcome) => {
      const side = ['home', 'away'].find((value) => normalize(game[value].name) === normalize(outcome.name));
      if (!side || !Number.isFinite(outcome.price) || outcome.price <= 1) return [];
      return [{ book: bookmaker.title, key: bookmaker.key, side, price: outcome.price, updated: market.last_update || bookmaker.last_update }];
    });
  });
}