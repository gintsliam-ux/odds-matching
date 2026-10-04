/**
 * Does this logo need a light chip behind it to be visible on our dark surface?
 *
 * Club crests come from Wikipedia as-is, and some are drawn entirely in near
 * black — the NZ Breakers wordmark and the Detroit Tigers "D" both load
 * perfectly and then render as an invisible smudge on a #0d1220 background.
 *
 * The test is the logo's BRIGHTEST pixel, not its average. Average luminance
 * gets this wrong in both directions: the Brisbane Bullets crest averages a
 * middling 0.51 yet carries white highlights (max 1.00) that read clearly,
 * while the Breakers average 0.11 with a maximum of 0.11 — there is nothing in
 * the artwork that could show against a dark ground, whatever the mean says.
 * So: if the lightest thing in the image is still dark, it needs a chip.
 */

/** Luminance below which even the brightest pixel can't carry on a dark ground. */
const DARK_MAX_LUMA = 0.35;
/** Pixels fainter than this are treated as background, not artwork. */
const ALPHA_FLOOR = 0.35;
/** Sampling grid. Big enough to catch a small highlight, cheap to read back. */
const SAMPLE = 32;

// One analysis per distinct URL for the life of the page: a board can repeat the
// same crest across dozens of rows, and each would otherwise decode it again.
const cache = new Map<string, Promise<boolean>>();

function analyse(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    // Required for getImageData; the CDNs we use send `access-control-allow-origin: *`.
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(false);
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = SAMPLE;
        c.height = SAMPLE;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(false);
        ctx.clearRect(0, 0, SAMPLE, SAMPLE);
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

        let brightest = 0;
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] / 255 < ALPHA_FLOOR) continue;
          opaque++;
          const l =
            (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          if (l > brightest) brightest = l;
        }
        // An image we couldn't read any solid pixels from tells us nothing.
        resolve(opaque > 0 && brightest < DARK_MAX_LUMA);
      } catch {
        // A tainted canvas (a CDN without CORS) — leave the logo as it was.
        resolve(false);
      }
    };
    img.src = src;
  });
}

/** True when `src` is too dark to read on a dark background. Never throws. */
export function needsLightChip(src: string): Promise<boolean> {
  let hit = cache.get(src);
  if (!hit) {
    hit = analyse(src).catch(() => false);
    cache.set(src, hit);
  }
  return hit;
}
