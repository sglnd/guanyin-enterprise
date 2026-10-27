ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS runtime
ARG DEBIAN_MIRROR=https://deb.debian.org
USER root
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color
ENV NODE_ENV=production DSH_HOME=/data/dsh HOME=/home/node \
    PATH=/opt/dsh-runtime/node_modules/.bin:/opt/dsh-docs-venv/bin:$PATH \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked rm -rf /opt/dsh-seed /opt/dsh-runtime /opt/guanyin-plugins /usr/local/lib/node_modules/@deepseek-ai \
    && sed -i "s|https://mirrors.aliyun.com|${DEBIAN_MIRROR}|g; s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update && apt-get install -y --no-install-recommends \
    ca-certificates chromium fonts-noto-cjk fonts-liberation git openssh-client \
    python3 python3-venv python3-pip make g++ pkg-config libsecret-1-0 \
    && python3 -m venv /opt/dsh-docs-venv \
    && /opt/dsh-docs-venv/bin/pip install --no-cache-dir pypdf==5.9.0 python-docx==1.2.0 openpyxl==3.1.5 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/dsh-runtime
COPY deploy/dsh-0.2.1/runtime/package*.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund && npm cache clean --force
RUN npm install-scripts approve @deepseek-ai/dsh-subprocess-local koffi node-pty @google/genai protobufjs \
    && npm rebuild
COPY deploy/dsh-0.2.1/enterprise-plugin /opt/dsh-runtime/node_modules/@guanyin/dsh-enterprise
COPY deploy/dsh-0.1.5-core/model-sync.mjs ./model-sync.mjs
COPY deploy/dsh-0.2.1/web-proxy.mjs ./web-proxy.mjs
COPY deploy/dsh-0.2.1/prepare-profile.mjs ./prepare-profile.mjs
COPY deploy/dsh-0.2.1/patch-pi-no-auth.mjs ./patch-pi-no-auth.mjs
COPY deploy/dsh-0.2.1/patch-http-bridge.mjs /opt/dsh-runtime/patch-http-bridge.mjs
RUN node /opt/dsh-runtime/patch-http-bridge.mjs
COPY deploy/dsh-0.2.1/patch-session-log-menu.mjs /opt/dsh-runtime/patch-session-log-menu.mjs
RUN node /opt/dsh-runtime/patch-session-log-menu.mjs
COPY deploy/dsh-0.2.1/patch-workspace.mjs ./patch-workspace.mjs
COPY assets/branding/guanyin-mark-graphite-cinnabar-v4.png ./guanyin-logo.png
RUN DSH_HOME=/opt/dsh-seed dsh web --dump-config >/tmp/guanyin-base-config.yml \
    && node patch-pi-no-auth.mjs \
    && node patch-workspace.mjs \
    && node prepare-profile.mjs \
    && DSH_HOME=/opt/dsh-seed dsh --profile web --dump-config >/tmp/guanyin-enterprise-config.yml \
    && mkdir -p /workspace /data/dsh /home/node \
    && chown -R node:node /opt/dsh-seed /workspace /data/dsh /home/node \
    && rm -f /tmp/guanyin-*-config.yml
COPY deploy/dsh-0.2.1/profile-compat.mjs /opt/dsh-runtime/profile-compat.mjs
COPY deploy/dsh-0.2.1/entrypoint.mjs ./entrypoint.mjs
RUN apt-get purge -y --auto-remove make g++ pkg-config && rm -rf /var/lib/apt/lists/*

# Flatten the prepared runtime. Even when an existing local Node/Debian DSH
# image bootstraps an offline build, none of its removed old DSH layers ship.
FROM scratch
COPY --from=runtime / /
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color
ENV NODE_ENV=production DSH_HOME=/data/dsh HOME=/home/node \
    PATH=/opt/dsh-runtime/node_modules/.bin:/opt/dsh-docs-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
LABEL org.opencontainers.image.title="Guanyin Enterprise DSH 0.2.1 workspace" \
    org.opencontainers.image.version="0.2.1-rc.3-gy.ent.7" \
    io.deepseek-harness.version="0.2.1-rc.3" io.guanyin.edition="enterprise" \
    io.guanyin.identity-contract="1" io.guanyin.models-contract="1" \
    io.guanyin.usage-contract="1" io.guanyin.browser="playwright-mcp"
USER node
WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["node", "/opt/dsh-runtime/entrypoint.mjs"]
CMD ["dsh", "--profile", "web", "--host", "127.0.0.1", "--port", "3081", "--no-open"]
