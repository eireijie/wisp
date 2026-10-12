# Warren hub: API, realtime, memory vault, and the web app in one image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/hub/package.json apps/hub/
COPY apps/web/package.json apps/web/
COPY apps/node/package.json apps/node/
COPY packages/core/package.json packages/core/
COPY packages/vault/package.json packages/vault/
COPY packages/adapters/package.json packages/adapters/
COPY packages/mcp/package.json packages/mcp/
COPY packages/sdk/package.json packages/sdk/
COPY packages/update/package.json packages/update/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
# git powers the vault's version history
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
ENV NODE_ENV=production \
    WARREN_DATA_DIR=/data \
    PORT=4747
VOLUME ["/data"]
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:4747/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/warren-hub.mjs"]
