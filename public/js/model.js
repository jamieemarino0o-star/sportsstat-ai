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

export function historicalTrend(events, teamId, before = new Date().toISOString(), window = 10) {
  const games = events
    .filter((game) => game.completed && new Date(game.date) < new Date(before)
      && [game.home.id, game.away.id].includes(teamId))
    .sort((first, second) => new Date(second.date) - new Date(first.date))
    .filter((game, index, all) => all.findIndex((item) => item.id === game.id) === index)
    .slice(0, window === 20 ? 20 : 10);
  const outcomes = games.map((game) => {
    const team = game.home.id === teamId ? game.home : game.away;
    const opponent = game.home.id === teamId ? game.away : game.home;
    return team.score === opponent.score ? 0.5 : Number(team.score > opponent.score);
  });
  const wins = outcomes.reduce((total, value) => total + value, 0);
  return {
    sample: games.length,
    wins,
    outcomes,
    observations: games.map((game, index) => ({
      eventId: game.id, date: game.date, matchup: `${game.away.name || game.away.id} at ${game.home.name || game.home.id}`,
      homeScore: game.home.score, awayScore: game.away.score, outcome: outcomes[index],
      weight: 1 / games.length, source: game.source || null,
    })),
    frequency: games.length ? wins / games.length : null,
    probability: games.length >= 5 ? (wins + 2) / (games.length + 4) : null,
  };
}

export function predictGame(game, homeHistory, awayHistory, window = 10) {
  const cutoff = new Date(Math.min(Date.now(), new Date(game.date).getTime())).toISOString();
  const home = historicalTrend(homeHistory, game.home.id, cutoff, window);
  const away = historicalTrend(awayHistory, game.away.id, cutoff, window);
  const provenance = { version: 'recent-form-v1', cutoff, window, prior: { wins: 2, losses: 2 }, minimum: 5, weighting: 'Equal game weight within each team; smoothed team odds ratios normalized against each other.', sources: [...home.observations.map((entry) => ({ ...entry, cohort: 'Home form' })), ...away.observations.map((entry) => ({ ...entry, cohort: 'Away form' }))] };
  if (home.probability === null || away.probability === null || game.completed || game.sport === 'epl') {
    return { home, away, probability: null, selection: null, sample: Math.min(home.sample, away.sample), provenance };
  }
  const homeStrength = home.probability / (1 - home.probability);
  const awayStrength = away.probability / (1 - away.probability);
  const homeProbability = homeStrength / (homeStrength + awayStrength);
  const selection = homeProbability >= 0.5 ? 'home' : 'away';
  return { home, away, selection, probability: selection === 'home' ? homeProbability : 1 - homeProbability, sample: Math.min(home.sample, away.sample), provenance };
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