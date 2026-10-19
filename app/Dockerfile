# Build stage: native deps (better-sqlite3) compiled here, not shipped in the runtime image.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# @anthropic-ai/claude-agent-sdk lazily downloads a ~215MB platform-specific "claude" binary
# (as a sibling optional package, e.g. @anthropic-ai/claude-agent-sdk-linux-x64) on its first
# query() call. Pre-install it here so the runtime image never needs registry access or a
# writable node_modules on first AI request.
RUN npm install --no-save @anthropic-ai/claude-agent-sdk-linux-x64@$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")

FROM node:22-bookworm-slim
# ffmpeg: audio segmentation for the meetings transcription pipeline (services/transcription.js).
# poppler-utils (pdftotext): extracts the FTC Competition Manual PDF (services/ftc-manual-updater.js,
# services/ftc-pdf-extract.js), monthly check for a new season version.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
# Run as `node` (uid 1000 = owner of the data dir on the host).
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production
USER node
EXPOSE 3001
CMD ["node", "server.js"]
