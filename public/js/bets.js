import { MARKETS, gameMarketValue, gradeValue, readPlayerStat } from './markets.js';

export function betMetrics(slips, openingCents = 0) {
  const active = slips.filter((slip) => slip.status === 'active');
  const settled = slips.filter((slip) => ['won', 'lost', 'push'].includes(slip.status));
  const wins = settled.filter((slip) => slip.status === 'won').length;
  const losses = settled.filter((slip) => slip.status === 'lost').length;
  const profitCents = settled.reduce((total, slip) => total + (slip.status === 'won' ? Math.round(slip.stakeCents * (slip.odds - 1)) : slip.status === 'lost' ? -slip.stakeCents : 0), 0);
  const settledStakeCents = settled.reduce((total, slip) => total + slip.stakeCents, 0);
  const exposureCents = active.reduce((total, slip) => total + slip.stakeCents, 0);
  return { wins, losses, settled: settled.length, active: active.length, profitCents, settledStakeCents, exposureCents,
    balanceCents: openingCents + profitCents, availableCents: openingCents + profitCents - exposureCents,
    winRate: wins + losses ? wins / (wins + losses) : null,
    roi: settledStakeCents ? profitCents / settledStakeCents : null };
}

export function createSlip(signal, stake, odds, availableCents, mode) {
  const stakeCents = Math.round(Number(stake) * 100);
  const price = Number(odds);
  if (!Number.isSafeInteger(stakeCents) || stakeCents <= 0 || stakeCents > 100000000) throw new Error('Enter a stake between $0.01 and $1,000,000.');
  if (!Number.isFinite(price) || price <= 1 || price > 10000) throw new Error('Decimal odds must be greater than 1 and at most 10,000.');
  if (stakeCents > availableCents) throw new Error('Stake exceeds your available bankroll.');
  if (!['live', 'demo'].includes(mode) || !MARKETS[signal.quote?.market] || !signal.game?.id) throw new Error('This signal cannot be tracked.');
  if (signal.game.completed) throw new Error('Completed games cannot be added as active bets.');
  const model = structuredClone(signal.analysis);
  if (model) model.ev = Number.isFinite(model.probability) ? (model.probability * price + (model.pushProbability || 0) - 1) * 100 : null;
  return { id: crypto.randomUUID(), mode, sport: signal.game.sport, eventId: signal.game.id, game: structuredClone(signal.game),
    quote: structuredClone(signal.quote), selection: signal.label, model,
    stakeCents, odds: price, status: 'active', createdAt: new Date().toISOString(), settledAt: null, audit: [] };
}

export function settleSlip(slip, status, reason = 'Manual settlement') {
  if (!['active', 'won', 'lost', 'push', 'void'].includes(status)) throw new Error('Invalid settlement status.');
  if (slip.status === status) return slip;
  return { ...slip, status, settledAt: status === 'active' ? null : new Date().toISOString(),
    audit: [...(slip.audit || []), { from: slip.status, to: status, at: new Date().toISOString(), reason }] };
}

export function suggestedResult(slip, summary) {
  const game = summary.game;
  if (!game?.completed || game.id !== slip.eventId || game.sport !== slip.sport) return null;
  const value = MARKETS[slip.quote.market].kind === 'player' ? readPlayerStat(summary, slip.quote.subject, slip.quote.market)?.value
    : gameMarketValue(game, slip.quote, slip.game[slip.quote.side || 'home']?.id);
  const status = gradeValue(value, slip.quote);
  return status ? { status, value, source: summary.source, checkedAt: summary.fetchedAt } : null;
}