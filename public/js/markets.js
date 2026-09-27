export const MARKETS = {
  h2h: { label: 'Moneyline', category: 'moneyline', kind: 'moneyline' },
  spreads: { label: 'Game spread / puck line', category: 'spreads', kind: 'spread' },
  alternate_spreads: { label: 'Alternate spreads', category: 'spreads', kind: 'spread' },
  spreads_h1: { label: 'Team 1st half spread', category: 'spreads', kind: 'half' },
  totals: { label: 'Game points / goal total', category: 'totals', kind: 'total' },
  team_totals: { label: 'Team total', category: 'totals', kind: 'teamTotal' },
  btts: { label: 'Both teams to score', category: 'btts', kind: 'btts' },
  player_points: { label: 'Player points', category: 'players', kind: 'player', fields: ['points', 'PTS'] },
  player_rebounds: { label: 'Player rebounds', category: 'players', kind: 'player', fields: ['rebounds', 'totalRebounds', 'REB'] },
  player_assists: { label: 'Player assists', category: 'players', kind: 'player', fields: ['assists', 'AST'] },
  player_threes: { label: 'Player 3-pointers made', category: 'players', kind: 'player', fields: ['threePointFieldGoalsMade', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3PT'], made: true },
  player_rush_yds: { label: 'Player rushing yards', category: 'players', kind: 'player', group: 'rushing', fields: ['rushingYards', 'YDS'] },
  player_pass_yds: { label: 'Player passing yards', category: 'players', kind: 'player', group: 'passing', fields: ['passingYards', 'YDS'] },
  player_shots_on_goal: { label: 'Player shots on goal', category: 'players', kind: 'player', fields: ['shots', 'shotsOnGoal', 'S', 'SOG'] },
  player_shots_on_target: { label: 'Player shots on target', category: 'players', kind: 'player', fields: ['shotsOnTarget', 'shotsOnGoal', 'SOT'] },
};

export const SPORT_MARKETS = {
  nfl: ['h2h', 'player_rush_yds', 'player_pass_yds', 'spreads', 'alternate_spreads', 'totals', 'team_totals'],
  nba: ['h2h', 'player_points', 'player_rebounds', 'player_assists', 'spreads', 'spreads_h1', 'totals'],
  wnba: ['h2h', 'player_points', 'player_rebounds', 'player_assists', 'player_threes', 'spreads', 'spreads_h1', 'totals', 'team_totals'],
  nhl: ['h2h', 'spreads', 'totals', 'player_shots_on_goal'],
  epl: ['totals', 'btts', 'player_shots_on_target'],
  mlb: ['h2h', 'spreads', 'totals'],
};

export const normalizeName = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = { manunited: 'manchesterunited', mancity: 'manchestercity', wolves: 'wolverhamptonwanderers', wolverhampton: 'wolverhamptonwanderers', tottenham: 'tottenhamhotspur', brightonandhovealbion: 'brightonhovealbion', bournemouth: 'afcbournemouth' };
const teamName = (value) => aliases[normalizeName(value)] || normalizeName(value);

export function findOddsEvent(game, events) {
  return events.find((event) => teamName(event.home_team) === teamName(game.home.name)
    && teamName(event.away_team) === teamName(game.away.name)
    && Math.abs(new Date(event.commence_time) - new Date(game.date)) < 6 * 3600000);
}

export function marketQuotes(game, events, marketKey) {
  if (!SPORT_MARKETS[game.sport]?.includes(marketKey)) return [];
  const definition = MARKETS[marketKey];
  const event = findOddsEvent(game, events);
  if (!event) return [];
  return (event.bookmakers || []).flatMap((book) => {
    if (!['draftkings', 'fanduel', 'betmgm'].includes(book.key)) return [];
    return (book.markets || []).filter((market) => market.key === marketKey).flatMap((market) => (market.outcomes || []).flatMap((outcome) => {
      const side = ['home', 'away'].find((value) => teamName(game[value].name) === teamName(outcome.description || outcome.name));
      if (!Number.isFinite(outcome.price) || outcome.price <= 1) return [];
      if (!['moneyline', 'btts'].includes(definition.kind) && !Number.isFinite(outcome.point)) return [];
      if (['spread', 'half', 'moneyline', 'teamTotal'].includes(definition.kind) && !side) return [];
      if (['total', 'teamTotal', 'player'].includes(definition.kind) && !['Over', 'Under'].includes(outcome.name)) return [];
      if (definition.kind === 'btts' && !['Yes', 'No'].includes(outcome.name)) return [];
      if (definition.kind === 'player' && !outcome.description) return [];
      return [{ market: marketKey, side, subject: outcome.description || (side ? game[side].name : ''), direction: outcome.name,
        line: outcome.point ?? null, price: outcome.price, book: book.title, bookKey: book.key,
        updated: market.last_update || book.last_update || null, eventId: event.id,
        source: { provider: 'The Odds API', url: `https://api.the-odds-api.com/v4/sports/${event.sport_key || game.sport}/events/${event.id}/odds`, fetchedAt: market.last_update || book.last_update || null },
      }];
    }));
  });
}

export function quoteKey(quote) {
  return [quote.market, normalizeName(quote.subject), quote.direction, quote.line ?? ''].join(':');
}

export function bestQuotes(quotes) {
  const groups = new Map();
  for (const quote of quotes) {
    const key = quoteKey(quote);
    if (!groups.has(key) || groups.get(key).price < quote.price) groups.set(key, quote);
  }
  return [...groups.values()];
}

export function readPlayerStat(summary, playerName, marketKey) {
  const definition = MARKETS[marketKey];
  if (definition?.kind !== 'player') return null;
  const matches = [];
  for (const team of summary.players || []) {
    for (const group of team.groups || []) {
      if (definition.group && normalizeName(group.name) !== definition.group) continue;
      for (const athlete of group.athletes || []) {
        if (normalizeName(athlete.name) !== normalizeName(playerName) || athlete.didNotPlay) continue;
        const index = (group.labels || []).findIndex((label, position) => definition.fields.some((field) => [label, group.names?.[position], group.keys?.[position]].some((name) => normalizeName(name) === normalizeName(field))));
        const raw = athlete.stats?.[index];
        if (index < 0 || raw == null || !String(raw).trim()) continue;
        const text = String(raw).trim();
        const value = definition.made && /^\d+-\d+$/.test(text) ? Number(text.split('-')[0]) : /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
        if (Number.isFinite(value)) matches.push({ value, raw: text, playerId: athlete.id, player: athlete.name, teamId: team.teamId, team: team.team, field: group.names?.[index] || group.labels[index], source: summary.source });
      }
    }
  }
  const unique = matches.filter((item, index, all) => all.findIndex((entry) => entry.playerId === item.playerId && entry.teamId === item.teamId && entry.value === item.value) === index);
  return unique.length === 1 ? unique[0] : null;
}

export function gameMarketValue(game, quote, teamId) {
  const kind = MARKETS[quote.market]?.kind;
  const side = game.home.id === teamId ? 'home' : game.away.id === teamId ? 'away' : null;
  const team = side ? game[side] : null;
  const opponent = side ? game[side === 'home' ? 'away' : 'home'] : null;
  if (kind === 'btts') return Number(game.home.score > 0 && game.away.score > 0);
  if (kind === 'total') return Number.isFinite(game.home.score) && Number.isFinite(game.away.score) ? game.home.score + game.away.score : null;
  if (!team) return null;
  if (kind === 'teamTotal') return team.score;
  if (kind === 'half') return Number.isFinite(team.firstHalfScore) && Number.isFinite(opponent.firstHalfScore) ? team.firstHalfScore - opponent.firstHalfScore : null;
  if (kind === 'spread' || kind === 'moneyline') return Number.isFinite(team.score) && Number.isFinite(opponent.score) ? team.score - opponent.score : null;
  return null;
}

export function gradeValue(value, quote) {
  if (!Number.isFinite(value)) return null;
  const kind = MARKETS[quote.market]?.kind;
  if (kind === 'btts') return Boolean(value) === (quote.direction === 'Yes') ? 'won' : 'lost';
  const margin = kind === 'moneyline' ? value : ['spread', 'half'].includes(kind) ? value + quote.line : (value - quote.line) * (quote.direction === 'Under' ? -1 : 1);
  return Math.abs(margin) < 1e-9 ? 'push' : margin > 0 ? 'won' : 'lost';
}

export function analyzeMarket(observations, quote, window = 10, cutoff = new Date().toISOString()) {
  const sample = observations.filter((entry) => entry.completed !== false && Number.isFinite(entry.value) && new Date(entry.date) < new Date(cutoff))
    .sort((first, second) => new Date(second.date) - new Date(first.date))
    .filter((entry, index, all) => all.findIndex((item) => item.eventId === entry.eventId) === index).slice(0, window === 20 ? 20 : 10)
    .map((entry) => ({ ...entry, outcome: gradeValue(entry.value, quote) }));
  const wins = sample.filter((entry) => entry.outcome === 'won').length;
  const losses = sample.filter((entry) => entry.outcome === 'lost').length;
  const pushes = sample.length - wins - losses;
  const pushProbability = sample.length ? pushes / sample.length : 0;
  const conditional = wins + losses >= 5 ? (wins + 2) / (wins + losses + 4) : null;
  const probability = conditional === null ? null : conditional * (1 - pushProbability);
  return { probability, pushProbability, sample: sample.length, wins, losses, pushes,
    frequency: sample.length ? wins / sample.length : null,
    ev: probability === null || !Number.isFinite(quote.price) ? null : (probability * quote.price + pushProbability - 1) * 100,
    provenance: { version: 'market-frequency-v1', cutoff, window, minimum: 5, prior: { wins: 2, losses: 2 },
      weighting: 'Equal weight per observed game. Beta(2,2) prior on decisive results. Observed push fraction reduces unconditional win probability.',
      sources: sample.map((entry) => ({ ...entry, weight: 1 / sample.length })),
    },
  };
}