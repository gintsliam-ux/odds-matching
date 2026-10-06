import { betsConfigured, betsDb } from './betsMongo.mjs';
import { enrich, mapMulti, mapSwift, streamMatch } from './ticker.mjs';

/**
 * Bets pushed off Mongo as they are struck, rather than polled for.
 *
 * Atlas is a replica set, so both collections can be watched. The thing that
 * makes it affordable is the `$match` below: it runs SERVER-SIDE, on Atlas,
 * before anything crosses the wire.
 *
 * That matters more than it sounds. Measured over 90 seconds on the live
 * cluster:
 *
 *   bets        insert      79/min        update     85/min
 *   multi_bets  insert      13/min        update  13,348/min
 *
 * The scraper re-syncs `multi_bets` wholesale, so an unfiltered stream would
 * be shipping better than thirteen thousand documents a minute to tell us
 * about thirteen bets. Filtered to inserts it is ~92 documents a minute across
 * both, which is nothing.
 */

/**
 * Inserts only, and only the bets this feed shows — see the rates above and
 * `streamMatch` in ticker.mjs. Both conditions are applied by Atlas.
 */
const pipeline = (name) => [{ $match: { operationType: 'insert', ...streamMatch(name) } }];

/**
 * Arrivals are collected and flushed on a timer rather than enriched one by
 * one. Enrichment costs a mapping lookup and a per-sport odds read, and doing
 * that per document would turn a quiet burst of ten bets into ten rounds of
 * the same work. At ~92/min a one-second window usually carries one or two.
 */
const FLUSH_MS = 1000;

/** A stream that has fallen over is retried, with a back-off, not abandoned. */
const RETRY_MS = 5000;
const RETRY_MAX_MS = 60_000;

const subscribers = new Set();
let running = null;
let buffered = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const batch = buffered;
    buffered = [];
    if (!batch.length || !subscribers.size) return;
    try {
      const { bets } = await enrich(batch);
      const live = bets.filter((b) => b.placedAt);
      if (!live.length) return;
      // Newest first, to match the order the table is already in.
      live.sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)));
      for (const send of subscribers) {
        try {
          send(live);
        } catch {
          // One broken client must not stop the others being served.
        }
      }
    } catch (err) {
      console.error('[ticker-stream] enrich failed:', err?.message ?? err);
    }
  }, FLUSH_MS);
}

/**
 * Open both watchers. One set per process, shared by every subscriber: a
 * change stream per connected browser would multiply connections against a
 * cluster the scrapers are also using.
 */
async function start() {
  const db = await betsDb();
  if (!db) throw new Error('bets source is not configured');

  const open = (name, map) => {
    let delay = RETRY_MS;
    let closed = false;
    const connect = () => {
      const cs = db.collection(name).watch(pipeline(name));
      cs.on('change', (ev) => {
        delay = RETRY_MS; // a delivered change proves the stream is healthy
        const doc = ev.fullDocument; // inserts always carry it
        if (!doc) return;
        try {
          buffered.push(map(doc));
          scheduleFlush();
        } catch (err) {
          console.error(`[ticker-stream] ${name} map failed:`, err?.message ?? err);
        }
      });
      cs.on('error', (err) => {
        console.error(`[ticker-stream] ${name} stream error:`, err?.message ?? err);
        cs.close().catch(() => {});
        if (closed) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      });
      return cs;
    };
    connect();
    return () => {
      closed = true;
    };
  };

  open('bets', mapSwift);
  open('multi_bets', mapMulti);
}

/**
 * Subscribe to pushed bets. Returns an unsubscribe function.
 *
 * `send` is called with an array of enriched rows, newest first.
 */
export async function subscribeToBets(send) {
  if (!betsConfigured) throw new Error('bets source is not configured');
  if (!running) {
    running = start().catch((err) => {
      running = null; // let the next subscriber try again rather than wedge
      throw err;
    });
  }
  await running;
  subscribers.add(send);
  return () => subscribers.delete(send);
}

export const tickerStreamConfigured = betsConfigured;
