import { subscribeToBets } from './tickerStream.mjs';

/**
 * The ticker's live leg, as Server-Sent Events.
 *
 * SSE rather than a websocket: this is one-way, and EventSource reconnects on
 * its own, which matters because a serverless host will close the response when
 * the function hits its duration cap no matter how healthy the stream is.
 *
 * `maxMs` is that cap, applied a little early and deliberately: ending the
 * response ourselves is a clean close the client reconnects from, where being
 * killed mid-write is not.
 */
export async function streamTicker(req, res, { maxMs }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    // Without this a proxy may buffer the whole response and deliver it at the
    // end, which for a stream means delivering it never.
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');

  let off = null;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(ping);
    clearTimeout(cap);
    off?.();
    res.end();
  };

  // Something must cross the wire regularly or an idle connection gets reaped
  // by whatever sits in the middle. A comment line is not an event, so the
  // client never sees these.
  const ping = setInterval(() => {
    if (!done) res.write(': ping\n\n');
  }, 15_000);
  const cap = setTimeout(stop, maxMs);
  req.on('close', stop);
  req.on('error', stop);

  try {
    off = await subscribeToBets((bets) => {
      if (!done) res.write(`event: bets\ndata: ${JSON.stringify(bets)}\n\n`);
    });
  } catch (err) {
    // Told, not left hanging: the client falls back to polling on this.
    res.write(`event: fatal\ndata: ${JSON.stringify({ error: String(err?.message ?? err) })}\n\n`);
    stop();
  }
}
