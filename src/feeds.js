import { normalizeEvent } from '../public/js/model.js';
import { MARKETS, analyzeMarket, bestQuotes, findOddsEvent, marketQuotes, readPlayerStat, gameMarketValue } from '../public/js/markets.js';

export const SPORTS = {
  nfl: { path: 'football/nfl', odds: 'americanfootball_nfl', name: 'NFL' },
  nba: { path: 'basketball/nba', odds: 'basketball_nba', name: 'NBA' },
  mlb: { path: 'baseball/mlb', odds: 'baseball_mlb', name: 'MLB' },
  nhl: { path: 'hockey/nhl', odds: 'icehockey_nhl', name: 'NHL' },
  wnba: { path: 'basketball/wnba', odds: 'basketball_wnba', name: 'WNBA' },
  epl: { path: 'soccer/eng.1', odds: 'soccer_epl', name: 'EPL' },
};

export function createFeeds({ fetcher = fetch, oddsKey = process.env.ODDS_API_KEY } = {}) {
  const cache = new Map();
  const pending = new Map();
  const waiting = [];
  let active = 0;
  const health = {
    espn: { state: 'idle', lastSuccess: null, message: 'Awaiting first request' },
    odds: { state: oddsKey ? 'idle' : 'unconfigured', lastSuccess: null, message: oddsKey ? 'Awaiting first request' : 'API key required' },
  };

  async function request(key, url, ttl, provider) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < ttl) return hit;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      if (active >= 5) await new Promise((resolve) => waiting.push(resolve));
      else active += 1;
      try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`${provider === 'espn' ? 'ESPN' : 'The Odds API'} returned HTTP ${response.status}`);
        const data = await response.json();
        const result = { data, time: Date.now() };
        cache.set(key, result);
        if (cache.size > 400) cache.delete(cache.keys().next().value);
        health[provider] = { state: 'connected', lastSuccess: new Date(result.time).toISOString(), message: 'Feed connected' };
        if (provider === 'odds') health.odds.remaining = response.headers.get('x-requests-remaining');
        return result;
      } catch (error) {
        const message = error.name === 'TimeoutError' ? 'Upstream request timed out' : error.message.startsWith('ESPN returned') || error.message.startsWith('The Odds API returned') ? error.message : 'Upstream feed is unavailable';
        health[provider] = { ...health[provider], state: 'error', message };
        throw new Error(message);
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }

  const espn = (sport, resource, ttl) => request(`${sport}:${resource}`, `https://site.api.espn.com/apis/site/v2/sports/${SPORTS[sport].path}/${resource}`, ttl, 'espn');
  const source = (sport, resource, time) => ({ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/${SPORTS[sport].path}/${resource}`, fetchedAt: new Date(time).toISOString() });

  const feeds = {
    status: () => ({ espn: { ...health.espn }, odds: { ...health.odds }, serverTime: new Date().toISOString() }),
    async scoreboard(sport) {
      const result = await espn(sport, 'scoreboard', 20000);
      return {
        games: (result.data.events || []).map((event) => normalizeEvent(event, sport, source(sport, 'scoreboard', result.time))).filter(Boolean),
        season: result.data.leagues?.[0]?.season?.year || new Date().getFullYear(),
        fetchedAt: new Date(result.time).toISOString(),
        source: 'ESPN',
      };
    },
    async history(sport, team, season) {
      const seasons = await Promise.allSettled([season, season - 1].map((year) => espn(sport, `teams/${team}/schedule?season=${year}`, 900000)));
      if (seasons.every((result) => result.status === 'rejected')) throw new Error('Team history unavailable');
      return {
        events: seasons.flatMap((result, index) => result.status === 'fulfilled' ? (result.value.data.events || []).map((event) => normalizeEvent(event, sport, source(sport, `teams/${team}/schedule?season=${season - index}`, result.value.time))).filter(Boolean) : []),
        partial: seasons.some((result) => result.status === 'rejected'),
        sources: seasons.flatMap((result, index) => result.status === 'fulfilled' ? [source(sport, `teams/${team}/schedule?season=${season - index}`, result.value.time)] : []),
        fetchedAt: new Date(Math.max(...seasons.filter((result) => result.status === 'fulfilled').map((result) => result.value.time))).toISOString(),
      };
    },
    async summary(sport, event, historical = false) {
      const result = await espn(sport, `summary?event=${event}`, historical ? 900000 : 20000);
      const data = result.data;
      const drivePlays = [...(data.drives?.previous || []).flatMap((drive) => drive.plays || []), ...(data.drives?.current?.plays || [])];
      const plays = data.plays?.length ? data.plays : drivePlays.length ? drivePlays : data.scoringPlays || [];
      return {
        source: source(sport, `summary?event=${event}`, result.time),
        game: normalizeEvent({ ...data.header, id: String(event), date: data.header?.competitions?.[0]?.date }, sport, source(sport, `summary?event=${event}`, result.time)),
        fetchedAt: new Date(result.time).toISOString(),
        statistics: (data.boxscore?.teams || []).map((entry) => ({ team: entry.team?.displayName, statistics: entry.statistics || [] })),
        players: [
          ...(data.boxscore?.players || []).map((entry) => ({ team: entry.team?.displayName, teamId: entry.team?.id, groups: (entry.statistics || []).map((group) => ({ name: group.name, labels: group.labels || [], names: group.names || [], keys: group.keys || [], athletes: (group.athletes || []).map((athlete) => ({ id: athlete.athlete?.id, name: athlete.athlete?.displayName, didNotPlay: athlete.didNotPlay === true, stats: athlete.stats || [] })) })) })),
          ...(data.rosters || []).map((entry) => ({ team: entry.team?.displayName, teamId: entry.team?.id, groups: (entry.roster || []).map((athlete) => ({ name: 'match', names: (athlete.stats || []).map((stat) => stat.name), labels: (athlete.stats || []).map((stat) => stat.abbreviation), athletes: [{ id: athlete.athlete?.id, name: athlete.athlete?.displayName, didNotPlay: !athlete.stats?.some((stat) => stat.name === 'appearances' && stat.value > 0), stats: (athlete.stats || []).map((stat) => stat.displayValue) }] })) })),
        ],
        probabilities: (data.winprobability || []).filter((point) => Number.isFinite(point.homeWinPercentage)).map((point) => ({ home: point.homeWinPercentage, playId: point.playId })).slice(-200),
        plays: plays.filter((play, index, all) => !play.id || all.findIndex((item) => item.id === play.id) === index).slice(-8).reverse().map((play) => ({ id: play.id, text: play.text, clock: play.clock?.displayValue, period: play.period?.number })),
        headline: data.news?.articles?.[0]?.headline || null,
      };
    },
    async odds(sport) {
      if (!oddsKey) return { configured: false, events: [], fetchedAt: null };
      const query = new URLSearchParams({ apiKey: oddsKey, regions: 'us', markets: 'h2h', oddsFormat: 'decimal', bookmakers: 'draftkings,fanduel,betmgm' });
      const result = await request(`odds:${sport}`, `https://api.the-odds-api.com/v4/sports/${SPORTS[sport].odds}/odds/?${query}`, 180000, 'odds');
      return { configured: true, events: result.data, fetchedAt: new Date(result.time).toISOString() };
    },
    async markets(sport, eventId, marketKey, window = 10) {
      if (!oddsKey) return { configured: false, signals: [], message: 'Connect The Odds API to retrieve actual market lines.' };
      const cacheKey = `analysis:${sport}:${eventId}:${marketKey}:${window}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.time < 180000) return hit.data;
      const board = await feeds.scoreboard(sport);
      const game = board.games.find((entry) => entry.id === eventId && !entry.completed);
      if (!game) return { configured: true, signals: [], message: 'This event is not on the current active scoreboard.' };
      const odds = await feeds.odds(sport);
      const oddsEvent = findOddsEvent(game, odds.events);
      if (!oddsEvent) return { configured: true, signals: [], message: 'No sportsbook event matches these teams and start time.' };
      const query = new URLSearchParams({ apiKey: oddsKey, regions: 'us', markets: marketKey, oddsFormat: 'decimal', bookmakers: 'draftkings,fanduel,betmgm' });
      const prices = await request(`event-odds:${sport}:${oddsEvent.id}:${marketKey}`, `https://api.the-odds-api.com/v4/sports/${SPORTS[sport].odds}/events/${oddsEvent.id}/odds?${query}`, 180000, 'odds');
      const quotes = marketQuotes(game, [prices.data], marketKey);
      if (!quotes.length) return { configured: true, signals: [], message: 'The selected market is not currently offered by the connected sportsbooks.' };
      const histories = await Promise.all([feeds.history(sport, game.home.id, board.season), feeds.history(sport, game.away.id, board.season)]);
      const cutoff = new Date(Math.min(Date.now(), new Date(game.date).getTime())).toISOString();
      const recent = histories.flatMap((history) => history.events
        .filter((entry) => entry.completed && new Date(entry.date) < new Date(cutoff))
        .sort((first, second) => new Date(second.date) - new Date(first.date))
        .filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index)
        .slice(0, window));
      const games = recent.filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index);
      const needsBoxscore = ['player', 'half'].includes(MARKETS[marketKey].kind);
      const summaries = needsBoxscore ? await Promise.allSettled(games.map((entry) => feeds.summary(sport, entry.id, true))) : [];
      const result = {
        configured: true, game, fetchedAt: new Date(prices.time).toISOString(),
        partial: histories.some((history) => history.partial) || summaries.some((summary) => summary.status === 'rejected'),
        inspectedGames: games.length,
        signals: bestQuotes(quotes).map((quote) => {
          const observations = games.flatMap((entry, index) => {
            const summary = summaries[index]?.status === 'fulfilled' ? summaries[index].value : null;
            const player = MARKETS[marketKey].kind === 'player' ? readPlayerStat(summary || {}, quote.subject, marketKey) : null;
            const value = MARKETS[marketKey].kind === 'player' ? player?.value : gameMarketValue(summary?.game || entry, quote, game[quote.side || 'home'].id);
            if (!Number.isFinite(value)) return [];
            return [{ eventId: entry.id, date: entry.date, matchup: `${entry.away.name} at ${entry.home.name}`, value, raw: player?.raw, field: player?.field || MARKETS[marketKey].label,
              playerId: player?.playerId, player: player?.player, source: needsBoxscore ? summary?.source : entry.source, completed: entry.completed }];
          });
          return { quote, analysis: analyzeMarket(observations, quote, window, cutoff) };
        }),
        quotes,
      };
      cache.set(cacheKey, { time: Date.now(), data: result });
      return result;
    },
  };
  return feeds;
}