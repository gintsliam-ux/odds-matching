# Logo store

Our own copies of team and competition logos, served from the `sports-logos`
Vercel Blob store (connected to the `workspace` project):

    https://mzmadqpfaf3glgvw.public.blob.vercel-storage.com/
      v1/<key>.png                 one 160px image per source file
      index/teams/<sport>.json     name -> logo, read by the Odds Library page
      index/competitions.json      competition name -> badge
      index/keys.json              every image key the store holds

`gutsys_sport.entities` stays the record of who uses which logo:

- `logo_url`        where the image came from (Wikipedia mostly)
- `logo_store_url`  our copy; sites serve this when it is set
- `logo_url_prev`, `logo_cleared`  set when an audit blanked a dead or wrong link

## Why

Links to other people's images rot. An audit on 23 Nov 2026
(`audit-2026-11-23.csv`) found 596 of 16,588 dead, the Buffalo Bills among
them, and 160 pointing at the wrong thing (Wikipedia project logos, kit
drawings, maps). Every site reading `entities` lost those logos at once.

## Running it

The working copy lives at `~/logo-store` on the Air (image cache in `img/`,
`.env` with `MONGO_URI` and `BLOB_READ_WRITE_TOKEN`). These files are the
source; copy changes there.

    node --env-file=.env sync.mjs             copy new logos, upload, record, publish lookups
    node --env-file=.env sync.mjs --no-fetch  skip the copying step
    node --env-file=.env sync.mjs --dry-run

It runs nightly at 04:10 from `odds-matching-mongo/scripts/run-logos.sh`, after
the two resolvers. Wikipedia allows about one image a second, so a night copies
at most 1,500 new images.

`clear-bad.mjs` is the one-off that blanked the 756 bad links from the audit.

## Using it from anywhere

There is no logo endpoint on gutsys-api; the files above are the API. They are
public, cached for an hour, and send `access-control-allow-origin: *`.

- By name: `index/teams/<sport>.json` is `{ p: [prefixes], l: { name: "i|rest" } }`
  where a name is lowercased, accents stripped, punctuation to spaces, and a
  value is prefix `i` followed by the rest of the address.
- By an existing Wikipedia link: key = `'w-' + sha1(file title with spaces)[0..16]`;
  if `index/keys.json` contains it, the copy is `v1/<key>.png`.

## Readers

- Odds Library (`index.html`): the lookup files, with the snapshot in
  `assets/` as a fallback.
- Sports Odds Desk (`arb-tracker-mongo/server/lib/events.mjs`, `crestOf`):
  `logo_store_url` first, then `logo_url`.
- live-fixtures (`src/lib/logoStore.ts`, used by `Avatar`): keeps its own
  Supabase `entities` table, so it swaps each Wikipedia link for our copy by
  key when the store holds one.
- polytracker has its own hand-kept ESPN logo map and does not use the store.
