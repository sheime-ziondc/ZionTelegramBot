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

# Where per-chat settings, conversation context and the spend counter live.
# Mount a persistent volume here in your host's dashboard; without one the
# budget cap resets on every restart (the app says so loudly at startup).
#
# Deliberately NOT declared as a Docker VOLUME: several hosts, Railway among
# them, manage volumes themselves and the instruction conflicts with that.
RUN mkdir -p /app/data
ENV STATE_FILE=/app/data/state.json

EXPOSE 8080

# Runs as root so that a host-mounted volume - typically owned by root - stays
# writable. The container runs only this bot and executes no untrusted input.
CMD ["node", "dist/index.js"]
