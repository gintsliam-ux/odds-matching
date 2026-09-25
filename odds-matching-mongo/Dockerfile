# The API has to run next to MongoDB: the database is only on the Tailscale
# tailnet, so Vercel's functions cannot reach it. A Cloudflare tunnel publishes
# this container instead. It serves the API alone — the page is the workspace
# root's index.html, which Vercel deploys.
FROM node:24-alpine

WORKDIR /app

# Install first so the dependency layer is cached across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

# A failing Mongo connection should restart the container rather than sit there
# serving 500s.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
