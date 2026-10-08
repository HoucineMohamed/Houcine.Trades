# syntax=docker/dockerfile:1
#
# Houcine.Trades, hosted image (module 8). See docs/deploy.md.
#
# - The base images are pinned to an exact Node version AND an exact digest (Node 22, as in .nvmrc),
#   so a rebuild gives the same system. To update them, change both on purpose.
# - Everything is installed from the lockfile (npm ci). The final image has NO dev dependencies.
# - No secret, no .env, no database and no local data are copied in (.dockerignore, and the smoke
#   test plants decoys to prove it).
# - It starts as root only to give the app user ownership of the data folder (some platforms mount a
#   disk owned by root), then the entrypoint drops to the unprivileged "node" user for good.
ARG BUILD_IMAGE=node:22.22.0-bookworm@sha256:20a424ecd1d2064a44e12fe287bf3dae443aab31dc5e0c0cb6c74bef9c78911c
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# ---------------------------------------------------------------- build
FROM ${BUILD_IMAGE} AS build
WORKDIR /app
# The full (not slim) Node image is used for building only: it already contains Python, make and g++,
# which better-sqlite3 needs to compile its native binary during `npm ci`. None of that reaches the
# final image, which is built on the slim image.
COPY package.json package-lock.json ./
# Install scripts are ALLOWED on purpose (that is what builds better-sqlite3). The build then checks
# that the native modules really load, and fails if they do not.
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev \
 && node -e "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get();require('@node-rs/argon2');console.log('native modules load')"

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTED=true \
    PORT=10000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --chown=node:node package.json tsconfig.json next.config.ts ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node docs ./docs
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 10000
# "ok" or "not ok", nothing else (the same route the platform checks)
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "--conditions=react-server", "scripts/host/start.ts"]
