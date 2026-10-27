/**
 * Bet constants that more than one module needs, in a module that imports
 * nothing — so it cannot take part in a cycle.
 *
 * They lived in bets.mjs, which imports queries.mjs. Once brandOdds began
 * reading parseBetMarket out of ticker.mjs that closed a loop:
 * bets -> queries -> brandOdds -> ticker -> bets. ESM answers a cycle with
 * whatever is initialised so far, so entering through bets.mjs left
 * COUNTER_ENTRY in its temporal dead zone and ticker.mjs threw on the first
 * line that used it — `SPORT_SINGLE`, evaluated at module load.
 *
 * Production never hit it, but only by luck: routes.mjs imports ticker.mjs
 * before bets.mjs, which happens to be the order that works. Reordering those
 * two imports would have taken down the whole API.
 *
 * Only the values used at module load moved. `betInstant` stays in bets.mjs
 * because it is only ever called from inside a function, by which time the
 * cycle has resolved.
 */

/**
 * How far a market-specific mybet event may sit from its own match event.
 *
 * Shared with the ticker's satellite resolver, which pairs them the other way
 * round, so the two cannot disagree about what counts as the same game.
 */
export const SATELLITE_SKEW_MS = 90 * 60_000;

export const COUNTER_ENTRY = /^(Return of|Cancellation of)/;

/**
 * A bet that never stood. Both halves of a cancellation say so in `bet_type` —
 * the original ("Cancelled at Tkt: 6490828", +250) and its reversal
 * ("Cancellation of Tkt: 6490674", -250) — so that field removes the pair in
 * one condition, where the status alone caught only the reversal and left 46
 * cancelled bets on the feed over three days.
 */
export const VOID_BET = /cancellation/i;
