# Deploying the Odds Library API

## What actually needs solving

One thing: **a browser cannot speak Mongo's wire protocol**, so an HTTP API has
to exist. That is the only hard constraint — it would still be true if Mongo
were on the public internet.

Everything else follows from where Mongo is. `100.96.58.9` is `nas01` on the
Tailscale tailnet, inside `100.64.0.0/10`, so a Vercel function has no route to
it. The API therefore runs next to the database and is published through a
Cloudflare tunnel — the same way the existing odds API is already exposed.

**What runs where:** the page is `../index.html`, deployed by the Vercel
`workspace` project at odds-matching.vercel.app. This container serves only the
API. Locally `npm start` serves both on :5180.

## 1. The container

```sh
git clone https://github.com/gintsliam-ux/odds-matching.git
cd odds-matching/odds-matching-mongo
cp .env.api.example .env.api        # MONGO_URI, TUNNEL_TOKEN
docker compose up -d --build
curl localhost:8788/health          # {"ok":true,"db":"gutsys_sport",...}
```

Port **8788**, which just has to miss racing-flucs' 8787.

`MONGO_URI` is resolved from *inside* the container, so `127.0.0.1` there is the
container, not the host — use `host.docker.internal` or the host's LAN address.

There is no auth and no `AUTH_SECRET`: the archive is read-only and sets no
cookies, which is why this is simpler than the racing deployments. `.env.api`
has an optional `API_KEY` and an explanation of why it is off.

## 2. The tunnel

`docker-compose.yml` runs `cloudflared` as a second service against a **named**
tunnel. Create one in Zero Trust → Networks → Tunnels, put its token in
`.env.api` as `TUNNEL_TOKEN`, and add a Public Hostname routing to
`http://api:8788`.

Named rather than quick, for one reason: the page's rewrite destination is a
hostname committed to this repo, and a quick tunnel gets a **new random
`*.trycloudflare.com` name on every restart**. That would mean editing
`vercel.json` and redeploying each time the container bounces.

If a stable hostname is not worth a Cloudflare account, drop the `tunnel`
service and run `cloudflared tunnel --url http://localhost:8788` on the host —
it works identically, it just renames itself.

## 3. Point the page at it

Set the destination in `../vercel.json` to the tunnel hostname:

```json
{ "source": "/api/:path*", "destination": "https://<tunnel-host>/api/:path*" }
```

That one line is the whole wiring. It is why the page ships with
`ODDS_API_DEFAULT = ''`: every request is same-origin, so there is no CORS, no
preflight, and no build-time variable in a file that has no build step.

The alternative is to skip the rewrite and set `ODDS_API_DEFAULT` in
`index.html` to the tunnel URL. The browser then calls the tunnel directly and
`ALLOWED_ORIGINS` in `.env.api` must name the app's exact origin.

Redeploy the `workspace` project after either change.

## 4. Check it

```sh
curl https://<tunnel-host>/health
curl https://odds-matching.vercel.app/api/health
```

Both return the same JSON. Then open the site — in DevTools → Network the calls
go to `/api/...` on the app's own origin.

If the page loads but every sport is empty:

- **The tunnel is down** → `/api/health` 502s or 530s through Vercel.
- **`vercel.json` names the wrong host**, or was changed without redeploying.
- **Mongo is unreachable from the container** → `/health` on the host itself
  500s with a server-selection timeout. See the `MONGO_URI` note above.

## What this was verified against

The whole path — page, every API route, and a full event render — was run
through a real `cloudflared` quick tunnel and matched localhost exactly,
including the case where a merged competition's two league ids return different
row counts. What is *not* verified here is the container build: this machine has
no Docker, so the `Dockerfile` is written against the racing-flucs one that is
known to work, and its first `docker compose up --build` is the step to watch.

## Local development

```sh
npm start                  # page + API on :5180, no tunnel involved
LOG_REQUESTS=1 npm run dev
```
