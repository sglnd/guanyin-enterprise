ARG BASE_IMAGE=bankops/deepseek-harness-agent:0.1.7-alpha.2-core-arm64
FROM ${BASE_IMAGE}

ARG DSH_VERSION=0.1.5-rc.2
ARG DSH_RESOLVE_BEFORE=2026-09-11T00:00:00.000Z
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian

USER root

RUN if [ "$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || true)" != "$DSH_VERSION" ]; then \
      rm -rf /usr/local/lib/node_modules/@deepseek-ai/dsh \
      && npm config set registry "$NPM_REGISTRY" \
      && npm install --global --before="$DSH_RESOLVE_BEFORE" \
        --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
        "@deepseek-ai/dsh@${DSH_VERSION}"; \
    fi \
    && test "$(node -p "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version")" = "$DSH_VERSION" \
    && test -d /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty \
    && test -d /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sandbox-local \
    && rm -rf /opt/dsh-seed \
    && export DSH_HOME=/opt/dsh-seed \
    && dsh web --dump-config >/tmp/web-config.yml \
    && printf '%s\n' "dsh=${DSH_VERSION}" "profile=guanyin-plugins-v2" > /opt/dsh-seed/.bankops-release \
    && rm -rf /root/.npm /tmp/web-config.yml

COPY deploy/dsh-0.1.5-core/plugins /opt/guanyin-plugins
COPY deploy/dsh-0.1.5-core/profile-package.json /tmp/guanyin-profile-package.json
COPY deploy/dsh-0.1.5-core/finalize-profile.mjs /tmp/finalize-profile.mjs
COPY deploy/dsh-0.1.5-core/guanyin-ui-policy/build-policy.json /tmp/guanyin-ui-build-policy.json

RUN --mount=type=cache,target=/root/.npm export DSH_HOME=/opt/dsh-seed \
    && printf '%s\n' "dsh=${DSH_VERSION}" "profile=guanyin-plugins-v12" > /opt/dsh-seed/.bankops-release \
    && cp /tmp/guanyin-profile-package.json /opt/dsh-seed/profiles/web/package.json \
    && npm install --prefix /opt/dsh-seed/profiles/web --ignore-scripts --legacy-peer-deps --no-audit --no-fund \
    && node /tmp/finalize-profile.mjs /opt/dsh-seed/profiles/web /tmp/guanyin-ui-build-policy.json \
    && dsh web --dump-config >/tmp/web-config-with-plugins.yml \
    && ! grep -q 'dsh-univer-office' /tmp/web-config-with-plugins.yml \
    && ! grep -q 'dsh-agency-agents' /tmp/web-config-with-plugins.yml \
    && ! grep -q 'dsh-bridge-browser' /tmp/web-config-with-plugins.yml \
    && grep -q 'dsh-better-sidebar' /opt/dsh-seed/profiles/web/package.json \
    && grep -q 'dsh-skills-manager' /opt/dsh-seed/profiles/web/package.json \
    && grep -q 'dsh-automation' /opt/dsh-seed/profiles/web/package.json \
    && grep -q '@guanyin/dsh-ui-policy' /opt/dsh-seed/profiles/web/package.json \
    && grep -q '@js2hou/dsh-mcp-manager' /opt/dsh-seed/profiles/web/package.json \
    && rm -rf /tmp/web-config-with-plugins.yml /tmp/guanyin-profile-package.json /tmp/finalize-profile.mjs /tmp/guanyin-ui-build-policy.json \
    && mkdir -p /workspace /home/node /opt/dsh-runtime /data/dsh \
    && chown -R node:node /opt/dsh-seed /opt/dsh-docs-venv /workspace /home/node /opt/dsh-runtime /data/dsh

COPY deploy/dsh-0.1.5-core/web-proxy.mjs /opt/dsh-runtime/web-proxy.mjs
COPY assets/branding/guanyin-mark-graphite-cinnabar-v4.png /opt/dsh-runtime/guanyin-logo.png
COPY deploy/dsh-0.1.5-core/entrypoint.sh /usr/local/bin/dsh-core-entrypoint

RUN chmod 0755 /usr/local/bin/dsh-core-entrypoint

LABEL org.opencontainers.image.title="Guanyin DSH workspace runtime" \
      org.opencontainers.image.version="0.1.5-rc.2-gy.1" \
      io.deepseek-harness.version="0.1.5-rc.2" \
      io.guanyin.identity-contract="1" \
      io.guanyin.branding="0.2.6" \
      io.guanyin.profile="guanyin-plugins-v12" \
      io.guanyin.better-sidebar="0.18.0" \
      io.guanyin.univer="absent" \
      io.guanyin.agency-agents="absent" \
      io.guanyin.browser-bridge="absent"

USER node
WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["dsh-core-entrypoint"]
CMD ["dsh", "--profile", "web", "--host", "127.0.0.1", "--port", "3081", "--no-open"]
