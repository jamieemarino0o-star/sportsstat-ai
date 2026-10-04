import { predictGame, predictionSettings, matchOdds } from '../public/js/model.js';
import { SPORTS } from './feeds.js';

export function createPredictionScanner({ feeds, sports = ['nfl'], intervalMs = 600000, now = Date.now, logger = console } = {}) {
  if (!sports.length || sports.some((sport) => !Object.hasOwn(SPORTS, sport) || sport === 'epl')) throw new Error('BACKGROUND_SCAN_SPORTS must contain supported moneyline sports: nfl,nba,wnba,mlb,nhl.');
  const leagues = [...new Set(sports)];
  let running = null;
  let lastAttempt = null;
  const state = { enabled: true, sports: leagues, intervalMs, lastStartedAt: null, lastCompletedAt: null, recorded: 0, skipped: 0, errors: [] };
  const status = () => ({ ...state, sports: [...leagues], errors: [...state.errors], running: Boolean(running) });

  async function scan() {
    for (const sport of leagues) {
      try {
        const board = await feeds.scoreboard(sport);
        const games = board.games.filter((game) => !game.completed && game.state === 'pre' && Date.parse(game.date) > now());
        if (!games.length) continue;
        const odds = await feeds.odds(sport);
        if (!odds.configured || !odds.events?.length) {
          state.skipped += games.length;
          state.errors.push(`${sport}: no moneyline odds available`);
          continue;
        }
        const stats = await feeds.predictionStats(sport);
        let next = 0;
        async function worker() {
          while (next < games.length) {
            const game = games[next++];
            try {
              const [home, away] = await Promise.all([feeds.history(sport, game.home.id, board.season), feeds.history(sport, game.away.id, board.season)]);
              if (home.partial || away.partial) { state.skipped += 1; continue; }
              const settings = predictionSettings(game.id, stats);
              const prediction = predictGame(game, home.events, away.events, 10, settings.biasFactor, settings.decay, settings.sosWeight);
              const price = matchOdds(game, odds.events).filter((quote) => quote.side === prediction.selection).sort((first, second) => second.price - first.price)[0];
              if (!Number.isFinite(prediction.homeProbability) || !price || Date.parse(game.date) <= now()) { state.skipped += 1; continue; }
              const result = await feeds.recordPrediction(sport, {
                eventId: game.id, homeProbability: prediction.homeProbability, selection: prediction.selection,
                window: 10, decay: prediction.provenance.decay, sosWeight: prediction.provenance.sosWeight,
                sample: prediction.sample, selectionPrice: price.price,
              });
              if (result.recorded) state.recorded += 1;
              else state.skipped += 1;
            } catch {
              state.errors.push(`${sport}:${game.id}: prediction scan failed; will retry`);
            }
          }
        }
        await Promise.all([worker(), worker(), worker()]);
      } catch {
        state.errors.push(`${sport}: feed or storage unavailable; will retry`);
      }
    }
    state.lastCompletedAt = new Date(now()).toISOString();
    if (state.errors.length) logger.warn?.(`[scanner] ${state.errors.join('; ')}`);
    return status();
  }

  return {
    status,
    run() {
      if (running) return running;
      if (lastAttempt !== null && now() - lastAttempt < intervalMs) return Promise.resolve(status());
      lastAttempt = now();
      Object.assign(state, { lastStartedAt: new Date(lastAttempt).toISOString(), recorded: 0, skipped: 0, errors: [] });
      running = Promise.resolve().then(scan).finally(() => { running = null; });
      return running;
    },
  };
}