import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createFeeds, SPORTS } from './src/feeds.js';
import { createLedger } from './src/ledger.js';
import { createTelegramNotifier } from './src/notifier.js';
import { auditReport, isValidTimeZone } from './src/audit.js';
import { SPORT_MARKETS } from './public/js/markets.js';

const OPTIMIZED_PARAMS_FILE = fileURLToPath(new URL('./data/optimized-params.json', import.meta.url));
const LEDGER_FILE = fileURLToPath(new URL('./data/predictions.jsonl', import.meta.url));

// Reads the config file src/optimize.js writes (recency decay / SOS weight winners plus the
// fractional Kelly grid search), regenerated periodically offline via `npm run optimize`. Read
// fresh on every request rather than cached: the file is tiny and only changes when the script is
// re-run, and this keeps the endpoint honest without requiring a server restart to pick up updates.
function readOptimizedParams() {
  try { return JSON.parse(readFileSync(OPTIMIZED_PARAMS_FILE, 'utf8')); } catch { return { generatedAt: null, sports: {} }; }
}

export function createApp(feeds = createFeeds()) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (e.g. Render), set TRUST_PROXY=1 so rate limiting keys on the real client
  // IP rather than lumping every visitor into the proxy's single bucket. Off by default: trusting
  // X-Forwarded-For without a proxy in front would let clients spoof their IP to dodge the limit.
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://unpkg.com', "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://a.espncdn.com', 'https://images.unsplash.com'],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 150, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please try again in a minute.' } }));
  app.use('/api/predictions', express.json({ limit: '4kb', strict: true }));
  // Ledger-derived payloads must never be cached by browsers or intermediaries.
  app.use(['/api/audit', '/api/optimized-params'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/status', (req, res) => res.json(feeds.status()));
  app.get('/api/optimized-params', (req, res) => {
    const params = readOptimizedParams();
    if (req.query.sport && Object.hasOwn(SPORTS, req.query.sport)) {
      return res.json({ generatedAt: params.generatedAt, sport: params.sports?.[req.query.sport] || null });
    }
    res.json(params);
  });
  // Spans every sport in one payload (like /api/optimized-params above), so it is registered before
  // the sport-validation middleware and only checks ?sport= manually when it is present. Reads the
  // ledger file fresh on every request: it's an append-only log that changes only as games resolve,
  // so there is no server-side caching to invalidate and no risk of a stale audit after a restart.
  app.get('/api/audit', (req, res) => {
    const sport = req.query.sport && Object.hasOwn(SPORTS, req.query.sport) ? req.query.sport : null;
    const kellyFraction = Number(req.query.kellyFraction);
    // ?tz= is the viewer's IANA time zone so the win calendar buckets games by their local date.
    const timeZone = typeof req.query.tz === 'string' && req.query.tz.length <= 64 && isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
    res.json(auditReport(LEDGER_FILE, { sport, timeZone, kellyFraction: Number.isFinite(kellyFraction) && kellyFraction > 0 && kellyFraction <= 1 ? kellyFraction : 0.25 }));
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!Object.hasOwn(SPORTS, req.query.sport)) return res.status(400).json({ error: 'Choose a supported sport: nfl, nba, wnba, mlb, nhl, epl.' });
    next();
  });
  const route = (handler) => async (req, res, next) => {
    try { res.json(await handler(req)); } catch (error) { next(error); }
  };
  app.get('/api/scoreboard', route((req) => feeds.scoreboard(req.query.sport)));
  app.get('/api/injuries', route((req) => feeds.injuries(req.query.sport)));
  app.get('/api/odds', route((req) => feeds.odds(req.query.sport)));
  app.get('/api/odds/history', (req, res, next) => {
    if (!/^\d{1,12}$/.test(req.query.event || '')) return res.status(400).json({ error: 'A valid event ID is required.' });
    next();
  }, route((req) => feeds.lineHistory(req.query.sport, req.query.event)));
  app.post('/api/predictions', (req, res, next) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!/^\d{1,12}$/.test(String(body.eventId ?? '')) || !Number.isFinite(body.homeProbability) || body.homeProbability < 0 || body.homeProbability > 1) {
      return res.status(400).json({ error: 'A valid event ID and a home win probability between 0 and 1 are required.' });
    }
    next();
  }, route((req) => feeds.recordPrediction(req.query.sport, {
    eventId: String(req.body.eventId), homeProbability: req.body.homeProbability, selection: req.body.selection,
    window: req.body.window, decay: req.body.decay, sosWeight: req.body.sosWeight, sample: req.body.sample, expectedHome: req.body.expectedHome, expectedAway: req.body.expectedAway, marketImpliedHome: req.body.marketImpliedHome,
    selectionPrice: req.body.selectionPrice,
  })));
  app.get('/api/predictions/stats', route((req) => feeds.predictionStats(req.query.sport)));
  app.get('/api/history', (req, res, next) => {
    if (!/^\d{1,8}$/.test(req.query.team || '') || !/^20\d{2}$/.test(req.query.season || '')) return res.status(400).json({ error: 'A valid team ID and season are required.' });
    next();
  }, route((req) => feeds.history(req.query.sport, req.query.team, Number(req.query.season))));
  app.get('/api/summary', (req, res, next) => {
    if (!/^\d{1,12}$/.test(req.query.event || '')) return res.status(400).json({ error: 'A valid event ID is required.' });
    next();
  }, route((req) => feeds.summary(req.query.sport, req.query.event)));
  app.get('/api/markets', (req, res, next) => {
    if (!/^\d{1,12}$/.test(req.query.event || '') || !SPORT_MARKETS[req.query.sport].includes(req.query.market)
      || !['10', '20'].includes(req.query.window || '10')) return res.status(400).json({ error: 'A valid event, supported market and 10- or 20-game window are required.' });
    next();
  }, route((req) => feeds.markets(req.query.sport, req.query.event, req.query.market, Number(req.query.window || 10))));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url)), { etag: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.use((error, req, res, next) => {
    // Client errors raised by middleware (malformed JSON, oversized body) keep their 4xx status and
    // get a generic message; everything else is an upstream failure whose message feeds.js has
    // already reduced to a safe, secret-free summary.
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 502;
    if (status === 502) return res.status(502).json({ error: error.message || 'The upstream feed is temporarily unavailable.' });
    res.status(status).json({ error: status === 413 ? 'Request body is too large.' : 'Malformed request.' });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT || 3000;
  const notifier = createTelegramNotifier();
  const server = createApp(createFeeds({ ledger: createLedger({ file: LEDGER_FILE, notifier }) })).listen(PORT, '0.0.0.0', () => {
    console.log(`SportsStat AI Predictor running on all interfaces at port ${PORT}`);
    console.log(`Telegram notifications ${notifier.enabled ? 'enabled' : 'disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable)'}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections?.();
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
  // Every known async path already catches its own errors; this is a last line of defence so a
  // missed rejection is logged instead of terminating the server mid-request.
  process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason instanceof Error ? reason.message : reason));
}