# Build context is the REPO ROOT, not apps/web: the build needs packages/shared
# (`npm ci` resolves the whole workspace). Build from the root:
#   docker build -f apps/web/Dockerfile -t whiteboard-web .

# ---------- stage 1: build ----------
FROM node:22-slim AS build
WORKDIR /repo

# Manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/

RUN npm ci --no-audit --no-fund

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

RUN npm run build -w @whiteboard/web

# ---------- stage 2: serve ----------
FROM nginx:alpine

COPY --from=build --chown=nginx:nginx /repo/apps/web/dist /usr/share/nginx/html
COPY --chown=nginx:nginx apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# nginx:alpine ships an `nginx` user but its stock nginx.conf listens on 80
# and writes to /var/cache/nginx, both of which a non-root worker cannot do.
# Replace the whole config and hand the writable dirs to `nginx` BEFORE
# dropping privileges — every write to /etc must happen while we are still root.
RUN printf '%s\n' \
  'worker_processes auto;' \
  'error_log /var/log/nginx/error.log warn;' \
  'pid /var/run/nginx.pid;' \
  'events { worker_connections 1024; }' \
  'http {' \
  '  include /etc/nginx/mime.types;' \
  '  default_type application/octet-stream;' \
  '  access_log /var/log/nginx/access.log;' \
  '  client_body_temp_path /tmp/client_temp;' \
  '  proxy_temp_path /tmp/proxy_temp;' \
  '  fastcgi_temp_path /tmp/fastcgi_temp;' \
  '  uwsgi_temp_path /tmp/uwsgi_temp;' \
  '  scgi_temp_path /tmp/scgi_temp;' \
  '  sendfile on;' \
  '  include /etc/nginx/conf.d/*.conf;' \
  '}' \
  > /etc/nginx/nginx.conf \
 && touch /var/run/nginx.pid \
 && mkdir -p /tmp/client_temp \
 && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/run /tmp/client_temp /etc/nginx/nginx.conf

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/ || exit 1
