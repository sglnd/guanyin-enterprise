FROM node:24-alpine
WORKDIR /app
COPY deploy/test-mcp/server.mjs ./server.mjs
USER node
EXPOSE 19090
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:19090/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
