# =============================================================
#  CS 1.6 Panel — Frontend Builder
#  Multi-stage: builds the Next.js app to a static export in
#  /out (consumed by panel.Dockerfile to land at /app/public/panel/).
# =============================================================
FROM node:20-alpine AS builder

WORKDIR /build

# Install only what we need to resolve the build
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund

# Copy the rest of the frontend source
COPY frontend/ ./

# Static export (configured in next.config.ts):
#   output: 'export'     -> emits /out as static HTML/JS/CSS
#   basePath: '/panel'   -> routes served under /panel/*
#   trailingSlash: true  -> /panel/ /panel/panel/ etc.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# /out is what the next stage (or panel.Dockerfile) consumes
FROM alpine:3.19 AS export
COPY --from=builder /build/out /out
