# LiveKit SFU binary is bundled so WebRTC voice/screen share works out of the box.
ARG LIVEKIT_VERSION=v1.13.9
FROM livekit/livekit-server:${LIVEKIT_VERSION} AS livekit

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=livekit /livekit-server /usr/local/bin/livekit-server
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Same PORT serves HTTP or HTTPS when TLS_ENABLED + PEM paths are set (see .env.example).
# 7880 LiveKit signalling (http/ws), 7881/tcp + 7882/udp WebRTC media.
EXPOSE 8080 50000/udp 50000/tcp 7880 7881/tcp 7882/udp
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
