ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY control-plane/package.json ./package.json
COPY control-plane/package-lock.json ./package-lock.json
RUN npm ci --omit=dev && npm cache clean --force
COPY control-plane/server.mjs ./server.mjs
COPY control-plane/store.mjs ./store.mjs
COPY control-plane/license.mjs ./license.mjs
COPY control-plane/dsh-adapter.mjs ./dsh-adapter.mjs
COPY control-plane/api-runner.mjs ./api-runner.mjs
COPY control-plane/api-contract.mjs ./api-contract.mjs
COPY control-plane/api-builder-mcp.mjs ./api-builder-mcp.mjs
COPY control-plane/guanyin-identity.mjs ./guanyin-identity.mjs
COPY control-plane/mcp-sync.mjs ./mcp-sync.mjs
COPY control-plane/model-registry.mjs ./model-registry.mjs
COPY control-plane/space-admin.mjs ./space-admin.mjs
COPY control-plane/public ./public
COPY assets/branding/guanyin-mark-graphite-cinnabar-v4.png ./public/guanyin-logo.png

RUN addgroup -S guanyin && adduser -S -G guanyin -u 10001 guanyin \
    && mkdir -p /data && chown -R guanyin:guanyin /app /data

USER 10001
EXPOSE 8080
CMD ["node", "server.mjs"]
