ARG COMMUNITY_DSH_IMAGE=bankops/guanyin-dsh:0.1.5-rc.2-gy.3-arm64
FROM ${COMMUNITY_DSH_IMAGE}

USER root

COPY deploy/dsh-enterprise/customize-profile.mjs /tmp/customize-enterprise-profile.mjs
COPY deploy/dsh-0.1.5-core/guanyin-ui-policy/lib/client.js /tmp/guanyin-enterprise-ui-client.js
COPY assets/branding/guanyin-mark-graphite-cinnabar-v4.png /opt/dsh-runtime/guanyin-logo.png
COPY deploy/dsh-enterprise/entrypoint.sh /usr/local/bin/guanyin-enterprise-entrypoint

RUN cp /tmp/guanyin-enterprise-ui-client.js /opt/dsh-seed/profiles/web/node_modules/@guanyin/dsh-ui-policy/lib/client.js \
    && node /tmp/customize-enterprise-profile.mjs /opt/dsh-seed/profiles/web /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
    && printf '%s\n' 'dsh=0.1.5-rc.2' 'profile=guanyin-enterprise-v5' > /opt/dsh-seed/.bankops-release \
    && rm -f /tmp/customize-enterprise-profile.mjs /tmp/guanyin-enterprise-ui-client.js \
    && chown node:node /opt/dsh-seed/profiles/web/node_modules/@guanyin/dsh-ui-policy/lib/client.js /opt/dsh-seed/.bankops-release \
    && chmod 0755 /usr/local/bin/guanyin-enterprise-entrypoint

LABEL org.opencontainers.image.title="Guanyin Enterprise DSH workspace runtime" \
      org.opencontainers.image.version="0.1.5-rc.2-gy.ent.5" \
      io.deepseek-harness.version="0.1.5-rc.2" \
      io.guanyin.edition="enterprise" \
      io.guanyin.profile="guanyin-enterprise-v5" \
      io.guanyin.deepseek-official="disabled" \
      io.guanyin.web-search="disabled"

USER node

ENTRYPOINT ["guanyin-enterprise-entrypoint"]
CMD ["dsh", "--profile", "web", "--host", "127.0.0.1", "--port", "3081", "--no-open"]
