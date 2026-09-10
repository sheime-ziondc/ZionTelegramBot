# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY glossary.json ./glossary.json

# Persist per-chat settings, context and usage counters across restarts.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
ENV STATE_FILE=/app/data/state.json

USER node
EXPOSE 8080

# Only meaningful in webhook mode; harmless in polling mode.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(process.env.MODE==='webhook'?1:0))"

CMD ["node", "dist/index.js"]
