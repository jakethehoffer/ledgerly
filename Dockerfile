# syntax=docker/dockerfile:1.7

# ---- Build stage -----------------------------------------------------------
# Install all deps (including dev), compile TypeScript, then prune devDeps
# before handing the resulting node_modules to the runtime stage.
#
# Build tooling (python3 + build-essential) is here as a safety net for
# `better-sqlite3`'s native binding: the prebuilt binary usually downloads
# cleanly for linux/glibc + node 20, but if the prebuild isn't available
# for the target arch, the install falls back to compiling from source.

FROM node:20-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---- Runtime stage ---------------------------------------------------------
# Minimal runtime: node:20-slim + the pruned node_modules + compiled dist.
# No build tooling, no source, no tests. Runs as a non-root user; SQLite
# state lives on /data which operators mount as a volume to persist across
# container restarts.

FROM node:20-slim AS runtime
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Non-root runtime user. Owning /data lets the process write ledger.db
# without requiring host-side chown gymnastics for the bind/volume mount.
RUN groupadd --system --gid 10001 ledgerly \
    && useradd --system --uid 10001 --gid 10001 --no-create-home ledgerly \
    && mkdir -p /data && chown ledgerly:ledgerly /data

USER ledgerly

# Default DB path lines up with the persistence volume mount target.
# Operators override with `-e LEDGERLY_DB_PATH=...` for a different layout.
ENV LEDGERLY_DB_PATH=/data/ledger.db
EXPOSE 3000

# Liveness check against the in-process /health endpoint. Uses node's
# built-in http module to avoid pulling curl/wget into the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/server/cli.js"]
