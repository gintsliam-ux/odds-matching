/**
 * Where our own price is longer than anyone else's.
 *
 * The event page shows our two brands beside the field one fixture at a time;
 * this is the same comparison swept across everything upcoming, which is the
 * only way to see it as a book rather than as a game. Measured on a sample of
 * 126 fixtures: swiftbet is longest on 8% of comparable selections and mybet on
 * none, so the rows this produces are few and worth reading individually.
 *
 * "Longest" is the strong test — longer than the BEST of the field, not its
 * average. A price merely better than the worst book is not news.
 *
 * Comparable means the same market, the same line and the same side, priced by
 * at least one other book. A selection nobody else quotes is left out rather
 * than reported as an edge: with nothing to compare against, there is no claim
 * to make.
 */
import { coll } from './mongo.mjs';
import { brandOddsForMany } from './brandOdds.mjs';
import { oddsForFixture } from './queries.mjs';

const OURS = new Set(['swiftbet', 'mybet']);

/** How far ahead to look, and how many fixtures one build will price. */
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/*
 * Capped because each fixture costs an odds read plus the two brand lookups.
 * At 120 that is about a minute on the API path, which the route's cache pays
 * once rather than per visitor.
 */
const FIXTURE_CAP = 120;

/** Same market, same line, same side. */
const keyOf = (r) => `${r.market_id}|${r.line ?? ''}|${r.outcome_no ?? r.selection}`;

const usable = (r) =>
  !r.is_lay &&
  Number(r.current_price) > 1 &&
  String(r.status ?? '').toLowerCase() !== 'suspended';

export async function topPrices() {
  const now = Date.now();
  const fixtures = await (await coll('fixtures'))
    .find({
      scheduled_start: { $gte: new Date(now), $lte: new Date(now + WINDOW_MS) },
      home_team: { $ne: null },
    })
    .sort({ scheduled_start: 1 })
    .limit(FIXTURE_CAP)
    .project({ _id: 0, fixture_id: 1, home_team: 1, away_team: 1, sport: 1, scheduled_start: 1, optic_league: 1 })
    .toArray();

  /*
   * Our prices FIRST, in three queries for the whole window — then the field
   * only for the fixtures that have one.
   *
   * The first version did the opposite: fetch the field for all 120 fixtures,
   * then discard the half we do not price. That paid for every odds read twice
   * over — once to fetch it, once to throw it away — on top of a mapping read
   * and two event reads per fixture. Asking our own cheap store first turns
   * 120 odds reads into ~50 and 360 round trips into 3.
   */
  const brandRows = await brandOddsForMany(fixtures);
  const priced = fixtures.filter((f) => brandRows.has(f.fixture_id));

  const rows = [];
  const counts = { fixtures: fixtures.length, withOurs: priced.length, comparable: 0, longest: 0, equal: 0 };

  /*
   * And the field is fetched in parallel. This was a plain `for await` loop,
   * which on the API path is one upstream round trip after another with the
   * rate limiter idle between them. Eight lanes, matching the surface's
   * in-flight allowance; the token bucket still decides how fast they leave.
   */
  const LANES = 8;
  const queue = [...priced];
  const lane = async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      // `brands: false` — we already hold ours from the batch above.
      // Cheap shape: current prices only. No ladder, no opening-price call —
      // this compares what is on offer now and reads neither.
      const odds = await oddsForFixture(f.fixture_id, f.sport, { brands: false, currentOnly: true })
        .catch(() => []);
      if (!odds.length) continue;

      // The best the field offers on each selection, and who offers it.
      const field = new Map();
      for (const r of odds) {
        if (OURS.has(r.sportsbook) || !usable(r)) continue;
        const k = keyOf(r);
        const cur = field.get(k);
        const p = Number(r.current_price);
        if (!cur) field.set(k, { price: p, book: r.sportsbook, books: 1 });
        else {
          cur.books += 1;
          if (p > cur.price) { cur.price = p; cur.book = r.sportsbook; }
        }
      }

      for (const r of brandRows.get(f.fixture_id) ?? []) {
        if (!usable(r)) continue;
        const best = field.get(keyOf(r));
        if (!best) continue;
        counts.comparable += 1;
        const price = Number(r.current_price);
        const edge = (price / best.price - 1) * 100;
        if (edge <= 0.01) {
          if (edge > -0.01) counts.equal += 1;
          continue;
        }
        counts.longest += 1;
        rows.push({
          fixtureId: f.fixture_id,
          event: `${f.home_team} v ${f.away_team}`,
          sport: f.sport,
          league: f.optic_league ?? null,
          startsAt: f.scheduled_start instanceof Date ? f.scheduled_start.toISOString() : f.scheduled_start ?? null,
          brand: r.sportsbook,
          market: r.market_id,
          line: r.line ?? null,
          selection: r.selection,
          price,
          best: best.price,
          bestBook: best.book,
          fieldBooks: best.books,
          edge: Math.round(edge * 100) / 100,
          at: r.current_at ?? null,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LANES, queue.length) }, lane));

  // Biggest edge first: this is a worklist, and the top of it is where the
  // money is.
  rows.sort((a, b) => b.edge - a.edge);
  return { configured: true, rows, counts, builtAt: new Date().toISOString() };
}
