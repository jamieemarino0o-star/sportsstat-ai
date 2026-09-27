import { MARKETS, analyzeMarket, bestQuotes, gameMarketValue } from './markets.js';

const LEAGUE_TEAMS = {
  nfl: [
    ['12', 'Kansas City Chiefs', 'Chiefs', 'KC', 'kc'], ['33', 'Baltimore Ravens', 'Ravens', 'BAL', 'bal'],
    ['2', 'Buffalo Bills', 'Bills', 'BUF', 'buf'], ['15', 'Miami Dolphins', 'Dolphins', 'MIA', 'mia'],
    ['25', 'San Francisco 49ers', '49ers', 'SF', 'sf'], ['6', 'Dallas Cowboys', 'Cowboys', 'DAL', 'dal'],
    ['21', 'Philadelphia Eagles', 'Eagles', 'PHI', 'phi'], ['8', 'Detroit Lions', 'Lions', 'DET', 'det'],
    ['9', 'Green Bay Packers', 'Packers', 'GB', 'gb'], ['16', 'Minnesota Vikings', 'Vikings', 'MIN', 'min'],
    ['24', 'Los Angeles Chargers', 'Chargers', 'LAC', 'lac'], ['23', 'Pittsburgh Steelers', 'Steelers', 'PIT', 'pit'],
  ],
  nba: [
    ['2', 'Boston Celtics', 'Celtics', 'BOS', 'bos'], ['18', 'New York Knicks', 'Knicks', 'NY', 'ny'],
    ['13', 'Los Angeles Lakers', 'Lakers', 'LAL', 'lal'], ['9', 'Golden State Warriors', 'Warriors', 'GS', 'gs'],
    ['7', 'Denver Nuggets', 'Nuggets', 'DEN', 'den'], ['25', 'Oklahoma City Thunder', 'Thunder', 'OKC', 'okc'],
    ['6', 'Dallas Mavericks', 'Mavericks', 'DAL', 'dal'], ['21', 'Phoenix Suns', 'Suns', 'PHX', 'phx'],
    ['15', 'Milwaukee Bucks', 'Bucks', 'MIL', 'mil'], ['20', 'Philadelphia 76ers', '76ers', 'PHI', 'phi'],
    ['14', 'Miami Heat', 'Heat', 'MIA', 'mia'], ['5', 'Cleveland Cavaliers', 'Cavaliers', 'CLE', 'cle'],
  ],
  mlb: [
    ['10', 'New York Yankees', 'Yankees', 'NYY', 'nyy'], ['2', 'Boston Red Sox', 'Red Sox', 'BOS', 'bos'],
    ['19', 'Los Angeles Dodgers', 'Dodgers', 'LAD', 'lad'], ['25', 'San Diego Padres', 'Padres', 'SD', 'sd'],
    ['15', 'Atlanta Braves', 'Braves', 'ATL', 'atl'], ['22', 'Philadelphia Phillies', 'Phillies', 'PHI', 'phi'],
    ['18', 'Houston Astros', 'Astros', 'HOU', 'hou'], ['13', 'Texas Rangers', 'Rangers', 'TEX', 'tex'],
    ['21', 'New York Mets', 'Mets', 'NYM', 'nym'], ['26', 'San Francisco Giants', 'Giants', 'SF', 'sf'],
    ['16', 'Chicago Cubs', 'Cubs', 'CHC', 'chc'], ['24', 'St. Louis Cardinals', 'Cardinals', 'STL', 'stl'],
  ],
  nhl: [
    ['1', 'Boston Bruins', 'Bruins', 'BOS', 'bos'], ['10', 'Toronto Maple Leafs', 'Maple Leafs', 'TOR', 'tor'],
    ['13', 'Florida Panthers', 'Panthers', 'FLA', 'fla'], ['3', 'New York Rangers', 'Rangers', 'NYR', 'nyr'],
    ['21', 'Colorado Avalanche', 'Avalanche', 'COL', 'col'], ['6', 'Chicago Blackhawks', 'Blackhawks', 'CHI', 'chi'],
    ['22', 'Edmonton Oilers', 'Oilers', 'EDM', 'edm'], ['20', 'Calgary Flames', 'Flames', 'CGY', 'cgy'],
    ['25', 'Dallas Stars', 'Stars', 'DAL', 'dal'], ['37', 'Vegas Golden Knights', 'Golden Knights', 'VGK', 'vgk'],
    ['16', 'Vancouver Canucks', 'Canucks', 'VAN', 'van'], ['23', 'Los Angeles Kings', 'Kings', 'LA', 'la'],
  ],
  wnba: [
    ['17', 'Las Vegas Aces', 'Aces', 'LV', 'lv'], ['9', 'New York Liberty', 'Liberty', 'NY', 'ny'],
    ['8', 'Minnesota Lynx', 'Lynx', 'MIN', 'min'], ['5', 'Indiana Fever', 'Fever', 'IND', 'ind'],
    ['14', 'Seattle Storm', 'Storm', 'SEA', 'sea'], ['11', 'Phoenix Mercury', 'Mercury', 'PHX', 'phx'],
    ['20', 'Atlanta Dream', 'Dream', 'ATL', 'atl'], ['19', 'Chicago Sky', 'Sky', 'CHI', 'chi'],
    ['3', 'Dallas Wings', 'Wings', 'DAL', 'dal'], ['6', 'Los Angeles Sparks', 'Sparks', 'LA', 'la'],
    ['18', 'Connecticut Sun', 'Sun', 'CON', 'con'], ['16', 'Washington Mystics', 'Mystics', 'WSH', 'wsh'],
  ],
  epl: [
    ['359', 'Arsenal', 'Arsenal', 'ARS', '359'], ['364', 'Liverpool', 'Liverpool', 'LIV', '364'],
    ['382', 'Manchester City', 'Man City', 'MCI', '382'], ['363', 'Chelsea', 'Chelsea', 'CHE', '363'],
    ['360', 'Manchester United', 'Man United', 'MUN', '360'], ['367', 'Tottenham Hotspur', 'Tottenham', 'TOT', '367'],
    ['361', 'Newcastle United', 'Newcastle', 'NEW', '361'], ['362', 'Aston Villa', 'Aston Villa', 'AVL', '362'],
    ['349', 'AFC Bournemouth', 'Bournemouth', 'BOU', '349'], ['331', 'Everton', 'Everton', 'EVE', '331'],
    ['379', 'West Ham United', 'West Ham', 'WHU', '379'], ['384', 'Crystal Palace', 'Palace', 'CRY', '384'],
  ],
};

export function createDemo(sport) {
  const now = Date.now();
  const source = { provider: 'Demo fixtures (simulated)', url: null, fetchedAt: new Date(now).toISOString() };
  const teams = LEAGUE_TEAMS[sport].map(([id, name, shortName, abbreviation, logo], index) => ({
    id, name, shortName, abbreviation, logo: `https://a.espncdn.com/i/teamlogos/${sport === 'epl' ? 'soccer' : sport}/500/${logo}.png`, score: 0, record: index % 2 ? '5-5' : '8-2',
  }));
  const games = Array.from({ length: 6 }, (_, index) => ({
    id: `demo-${sport}-${index}`, sport, date: new Date(now + (index < 2 ? -3600000 : (index + 1) * 3600000)).toISOString(),
    source,
    home: { ...teams[index * 2], score: index < 2 ? ({ nfl: 24, nba: 87, wnba: 72, mlb: 4, nhl: 3, epl: 2 }[sport]) + index : 0 },
    away: { ...teams[index * 2 + 1], score: index < 2 ? ({ nfl: 17, nba: 82, wnba: 67, mlb: 2, nhl: 1, epl: 1 }[sport]) + index : 0 },
    state: index < 2 ? 'in' : 'pre', completed: false,
    detail: index < 2 ? { nfl: 'Q3 08:42', nba: 'Q3 04:32', wnba: 'Q4 06:18', mlb: 'Top 6th', nhl: 'P2 08:42', epl: '67 min' }[sport] : 'Scheduled',
    venue: { nfl: 'GEHA Field at Arrowhead Stadium', nba: 'TD Garden', wnba: 'Michelob ULTRA Arena', mlb: 'Yankee Stadium', nhl: 'TD Garden', epl: 'Emirates Stadium' }[sport], broadcast: 'Demo broadcast',
  }));
  const history = new Map(teams.map((team, index) => [team.id, Array.from({ length: 20 }, (_, offset) => {
    const win = ((offset * 3 + index) % 10) < [8, 5, 7, 5, 8, 6, 7, 6, 6, 5, 7, 4][index];
    const base = { nfl: 20, nba: 100, wnba: 75, mlb: 2, nhl: 1, epl: 0 }[sport];
    const high = base + ({ nfl: 10, nba: 12, wnba: 10, mlb: 4, nhl: 3, epl: 2 }[sport]) + offset % 3;
    return { id: `${team.id}-${offset}`, date: new Date(now - (offset + 2) * (sport === 'nfl' ? 7 : 2) * 86400000).toISOString(), completed: true, source,
      home: { ...team, score: win ? high : base, firstHalfScore: win ? 44 + offset % 8 : 37 + offset % 4 },
      away: { id: 'opponent', name: 'Demo opponent', score: win ? base : high, firstHalfScore: win ? 37 : 44 } };
  })]));
  const odds = games.map((game, index) => ({ home_team: game.home.name, away_team: game.away.name, commence_time: game.date, bookmakers: ['draftkings', 'fanduel', 'betmgm'].map((key, bookIndex) => ({
    key, title: ['DraftKings', 'FanDuel', 'BetMGM'][bookIndex], last_update: new Date(now).toISOString(), markets: [{ key: 'h2h', outcomes: [{ name: game.home.name, price: 1.65 + index * 0.05 + bookIndex * 0.02 }, { name: game.away.name, price: 2.2 - index * 0.04 + bookIndex * 0.03 }] }],
  })) }));
  const summaries = new Map(games.map((game, index) => [game.id, {
    game, source,
    fetchedAt: new Date(now).toISOString(),
    probabilities: game.state === 'in' ? Array.from({ length: 45 }, (_, point) => ({ home: Math.min(0.91, Math.max(0.2, 0.5 + point * 0.004 + Math.sin(point * 0.6) * 0.045 + index * 0.04)), playId: String(point) })) : [],
    plays: game.state === 'in' ? [
      { id: '1', text: `${game.home.name} maintain a ${game.home.score - game.away.score}-point lead. The latest scoring sequence moves the home win probability higher.`, clock: '08:42', period: 3 },
      { id: '2', text: `${game.away.name} convert their latest possession to close the gap.`, clock: '09:16', period: 3 },
      { id: '3', text: `${game.home.name} take the lead following a scoring play.`, clock: '10:03', period: 3 },
    ] : [],
    statistics: [game.home, game.away].map((team, teamIndex) => ({ team: team.name, statistics: [
      { label: 'Score', displayValue: String(team.score) },
      { label: sport === 'nfl' ? 'Total yards' : 'Shots / attempts', displayValue: String(teamIndex ? 247 : 312) },
      { label: 'Turnovers', displayValue: String(teamIndex ? 2 : 1) },
    ] })),
    players: sport === 'nfl' && index === 0 ? [{ team: game.home.name, groups: [{ name: 'passing', labels: ['C/ATT', 'YDS', 'TD', 'INT'], athletes: [{ name: 'Patrick Mahomes', stats: ['22/30', '268', '2', '0'] }] }] }, { team: game.away.name, groups: [{ name: 'passing', labels: ['C/ATT', 'YDS', 'TD', 'INT'], athletes: [{ name: 'Lamar Jackson', stats: ['18/26', '214', '1', '1'] }] }] }] : [],
  }]));
  if (sport === 'wnba') {
    summaries.get(games[0].id).players = [{ team: games[0].home.name, teamId: games[0].home.id, groups: [{ name: 'basketball', labels: ['PTS', 'REB', 'AST', '3PT'], names: ['points', 'rebounds', 'assists', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'], athletes: [{ id: 'demo-aja', name: "A'ja Wilson", stats: ['26', '11', '4', '1-2'] }] }] }];
  }
  return { games, history, odds, summaries };
}

export function createDemoMarkets(game, history, marketKey, window = 10) {
  const definition = MARKETS[marketKey];
  const source = { provider: 'Demo fixtures (simulated)', url: null, fetchedAt: new Date().toISOString() };
  const names = { nba: ['Jayson Tatum', 'Jalen Brunson'], wnba: ["A'ja Wilson", 'Sabrina Ionescu'], nfl: marketKey === 'player_rush_yds' ? ['Isiah Pacheco', 'Derrick Henry'] : ['Patrick Mahomes', 'Lamar Jackson'], nhl: ['David Pastrnak', 'Auston Matthews'], epl: ['Bukayo Saka', 'Mohamed Salah'] };
  const line = { player_points: 22.5, player_rebounds: 7.5, player_assists: 5.5, player_threes: 2.5, player_pass_yds: 249.5, player_rush_yds: 69.5, player_shots_on_goal: 3.5, player_shots_on_target: 1.5,
    totals: { nba: 219.5, wnba: 163.5, nfl: 47.5, nhl: 5.5, epl: 2.5, mlb: 7.5 }[game.sport], team_totals: game.sport === 'wnba' ? 81.5 : 24.5 }[marketKey];
  const baseQuotes = ['spread', 'half'].includes(definition.kind) ? ['home', 'away'].map((side, index) => ({ side, subject: game[side].name, direction: game[side].name, line: (index ? 1 : -1) * (marketKey === 'alternate_spreads' ? 7.5 : 3.5) }))
    : definition.kind === 'btts' ? ['Yes', 'No'].map((direction) => ({ subject: '', direction, line: null }))
      : (definition.kind === 'player' ? (names[game.sport] || ['Demo Player']).map((subject) => ({ subject })) : [{ subject: definition.kind === 'teamTotal' ? game.home.name : '', side: definition.kind === 'teamTotal' ? 'home' : undefined }])
        .flatMap((subject) => ['Over', 'Under'].map((direction) => ({ ...subject, direction, line })));
  const quotes = baseQuotes.flatMap((quote) => ['DraftKings', 'FanDuel', 'BetMGM'].map((book, index) => ({ ...quote, market: marketKey, price: 1.87 + index * 0.04, book, updated: source.fetchedAt, source })));
  return { configured: true, game, quotes, fetchedAt: source.fetchedAt, inspectedGames: window, partial: false,
    signals: bestQuotes(quotes).map((quote, quoteIndex) => {
      const observations = definition.kind === 'player' ? Array.from({ length: 20 }, (_, index) => ({ eventId: `demo-prop-${index}`, date: new Date(Date.now() - (index + 2) * 3 * 86400000).toISOString(), matchup: `${game.away.name} at ${game.home.name}`,
        value: Math.max(0, Math.round(line) + ((index * 3 + quoteIndex) % 9) - 3), player: quote.subject, field: definition.label, source }))
        : [...(history.get(game[quote.side || 'home'].id) || [])].map((entry) => ({ eventId: entry.id, date: entry.date, matchup: `${entry.away.name} at ${entry.home.name}`, value: gameMarketValue(entry, quote, game[quote.side || 'home'].id), source: entry.source, field: definition.label }));
      return { quote, analysis: analyzeMarket(observations, quote, window, game.date) };
    }),
  };
}