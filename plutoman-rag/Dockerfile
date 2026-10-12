# ---------------------------------------------------------------------------
# plutoman-rag application image.
#
# ONE image serves every Node role; docker-compose picks the role by command:
#   api          node dist/src/server.js                 (default)
#   worker       node dist/src/ingestion/ingestWorker.js
#   migrate      node dist/scripts/migrate.js            (one-shot, DB owner)
#   ingest-demo  node dist/scripts/ingest-demo.js        (one-shot, demo data)
#
# Configuration comes only from environment variables (there is no .env in the
# image); see docker-compose.yml and .env.example.
# ---------------------------------------------------------------------------

# --- build: compile TypeScript ---------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

# --- runtime: production dependencies + compiled output ---------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/db/migrations \
    DEMO_DATA_DIR=/data/demo
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY db/migrations ./db/migrations

USER node
EXPOSE 3000
# Only meaningful for the api role; compose disables it for the other roles.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
