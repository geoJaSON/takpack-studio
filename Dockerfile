# syntax=docker/dockerfile:1

# ---- build stage ------------------------------------------------------------
# Debian (glibc) slim — best prebuilt-binary support for the native deps
# (better-sqlite3, sharp). Build tools are here only as a compile fallback.
FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install with manifests first so deps cache independently of source changes.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

# Build server (tsc -> server/dist) and frontend (vite -> frontend/dist).
COPY . .
RUN npm run build

# Strip dev deps; compiled native binaries (sharp, better-sqlite3) are
# production deps and stay intact.
RUN npm prune --omit=dev

# ---- runtime stage ----------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8745 \
    TAKPACK_DATA_DIR=/data

# GDAL powers DTED elevation export. It degrades gracefully (a warning) when
# absent, so delete the next two lines to drop ~300MB if you don't need DTED.
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin \
    && rm -rf /var/lib/apt/lists/*

# App + production node_modules (with the matching native binaries) from build.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/frontend/dist ./frontend/dist

# SQLite job store + artifact zips live here; mount a volume to persist them.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8745

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8745)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
