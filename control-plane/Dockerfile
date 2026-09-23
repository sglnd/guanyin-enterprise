FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY control-plane/package.json ./package.json
COPY control-plane/package-lock.json ./package-lock.json
RUN npm ci --omit=dev && npm cache clean --force
COPY control-plane/server.mjs ./server.mjs
COPY control-plane/store.mjs ./store.mjs
COPY control-plane/public ./public
COPY assets/branding/guanyin-mark-graphite-cinnabar-v4.png ./public/guanyin-logo.png

RUN addgroup -S guanyin && adduser -S -G guanyin -u 10001 guanyin \
    && mkdir -p /data && chown -R guanyin:guanyin /app /data

USER 10001
EXPOSE 8080
CMD ["node", "server.mjs"]
