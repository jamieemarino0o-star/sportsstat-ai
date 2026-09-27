import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createFeeds, SPORTS } from './src/feeds.js';
import { SPORT_MARKETS } from './public/js/markets.js';

export function createApp(feeds = createFeeds()) {
  const app = express();
  app.disable('x-powered-by');
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
  app.get('/api/status', (req, res) => res.json(feeds.status()));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!Object.hasOwn(SPORTS, req.query.sport)) return res.status(400).json({ error: 'Choose a supported sport: nfl, nba, wnba, mlb, nhl, epl.' });
    next();
  });
  const route = (handler) => async (req, res, next) => {
    try { res.json(await handler(req)); } catch (error) { next(error); }
  };
  app.get('/api/scoreboard', route((req) => feeds.scoreboard(req.query.sport)));
  app.get('/api/odds', route((req) => feeds.odds(req.query.sport)));
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
    res.status(502).json({ error: error.message || 'The upstream feed is temporarily unavailable.' });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createApp().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`SportsStat AI Predictor running at http://localhost:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}