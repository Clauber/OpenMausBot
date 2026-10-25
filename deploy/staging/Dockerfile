FROM node:24.21.0-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@0.163.0 @anthropic-ai/claude-code@2.1.306 \
    && npm cache clean --force
WORKDIR /app
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node dist-server ./dist-server
COPY --chown=node:node dist ./dist
COPY --chown=node:node skills ./skills
ENV OMB_DATA_DIR=/home/node/.openmausbot \
    OMB_STATIC_DIR=/app/dist \
    OMB_PORT=8799 \
    OMB_WEBHOOK_PORT=8800 \
    NODE_ENV=production
USER node
CMD ["node", "dist-server/server-launcher.js"]
