FROM node:20-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json tsconfig.server.json ./
COPY client ./client
COPY server ./server
COPY shared ./shared
RUN npm ci

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends qpdf poppler-utils tini \
  && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="Inkflow" \
  org.opencontainers.image.description="Self-hosted Goodnotes-style PDF and notebook app optimized for large documents and Apple Pencil workflows." \
  org.opencontainers.image.source="https://github.com/Outlain/inkflow" \
  org.opencontainers.image.url="https://github.com/Outlain/inkflow"

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV INKFLOW_RENDER_CACHE_DESKTOP_PIXELS=100000000
ENV INKFLOW_RENDER_CACHE_TOUCH_PIXELS=50000000
ENV INKFLOW_PREFETCH_RADIUS_FAST=4
ENV INKFLOW_PREFETCH_RADIUS_MEDIUM=1
ENV INKFLOW_PREFETCH_RADIUS_SLOW=0
ENV INKFLOW_PREVIEW_RADIUS_FAST=all
ENV INKFLOW_PREVIEW_RADIUS_MEDIUM=2
ENV INKFLOW_PREVIEW_RADIUS_SLOW=1

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data/uploads /app/data/temp /app/data/previews /app/data/exports /app/data/logs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => response.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/src/index.js"]
