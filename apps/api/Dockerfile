# IMPORTANT: the build context is the REPO ROOT, not apps/api.
#   docker build -f apps/api/Dockerfile .
# The API imports @whiteboard/shared, which lives in packages/shared, so the
# context must contain both. The build below stages a self-contained tree in
# /build (root package.json + packages/shared + apps/api), so `npm install`
# inside the image is a plain workspace install and does NOT need the host's
# node_modules or a committed package-lock.json.
#
#   docker build -f apps/api/Dockerfile -t whiteboard-api .
#   docker run --rm -p 3001:3001 -v whiteboard-data:/app/data whiteboard-api

# ---------- deps ----------
FROM node:22-slim AS deps

WORKDIR /build

# Copy only the manifests first: a source-only change must not invalidate the
# dependency layer.
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# The root manifest is kept for its `workspaces` (and `type`), NOT for its
# dependencies: those are repo tooling (dev scripts, the Playwright driver
# used by browser checks), and `--include-workspace-root` below would
# otherwise install them into the production image. Everything the API needs
# at runtime is declared in apps/api/package.json and packages/shared.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.dependencies;delete p.devDependencies;delete p.optionalDependencies;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\\n')"

# No lockfile is copied: the host lockfile spans every workspace (including
# the web app, which this image does not need) and would drag its dev
# dependencies in. This layer is a cache hit unless a manifest changes.
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund --workspaces --include-workspace-root \
 && npm cache clean --force

# ---------- runtime ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    API_PREFIX=/api \
    STORAGE=sqlite \
    SQLITE_PATH=/app/data/whiteboard.db \
    LOG_LEVEL=info

WORKDIR /app

# node:sqlite lives inside the Node binary (behind --experimental-sqlite), so
# there is nothing native to compile and the image needs no build toolchain.
# The tree mirrors the repo so `node_modules/@whiteboard/shared` (a workspace
# symlink to ../../packages/shared) resolves inside the image.
#
# packages/shared comes from the BUILD CONTEXT, not from the deps stage: deps
# only ever saw its package.json (so a source change keeps the npm layer
# cached), and the symlink above points at `packages/shared/src/index.js`.
# Copying `/build/packages` instead ships a manifest with no source, and the
# API dies on boot with ERR_MODULE_NOT_FOUND for @whiteboard/shared.
# What the context may contain (no host node_modules, no local .env or sqlite
# file) is narrowed by Dockerfile.dockerignore next to this file.
COPY --from=deps --chown=node:node /build/node_modules ./node_modules
COPY --from=deps --chown=node:node /build/package.json ./package.json
COPY --chown=node:node packages/shared ./packages/shared
COPY --chown=node:node apps/api ./apps/api

# Run from the app's own directory so the relative CMD path is correct.
# node_modules and the workspace symlinks are found by walking up to /app,
# so this costs nothing.
WORKDIR /app/apps/api

# The `node` user ships with the base image but cannot write to /app, and the
# sqlite file lives under /app/data. Create the dir as root, then hand it over.
# Mount a volume HERE (`-v whiteboard-data:/app/data`, as docker-compose.yml
# does): a new named volume copies this directory's node ownership only
# because the path already exists in the image. A mount at a path the image
# lacks (e.g. /data) starts out root:root 0755, and the non-root API then
# cannot create its database and exits on boot.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 3001

# node:sqlite is experimental in 22, so the flag is required. Matches the
# `start` script in apps/api/package.json.
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+(process.env.API_PREFIX||'/api')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "src/server.js"]
