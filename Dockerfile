# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 单镜像服务器版：Nginx 前端与 Node.js API。
FROM node:22-alpine
RUN apk add --no-cache nginx bash tini
WORKDIR /app/server
ENV NODE_ENV=production PORT=4011 MEDIA_DIR=/app/data/media
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server/src ./src
COPY server/schema.sql ./schema.sql

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx.cloud.conf /etc/nginx/http.d/default.conf
COPY web/docker-entrypoint.sh /app/runtime-config.sh
COPY deploy/start.sh /app/start.sh
RUN mkdir -p /app/data/media && chown -R node:node /app/data /usr/share/nginx/html
USER node

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/bin/bash", "/app/start.sh"]
