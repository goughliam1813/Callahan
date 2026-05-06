# ── Stage 1: Build Frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline 2>/dev/null || npm install

COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_URL=/api/v1
RUN npm run build

# ── Stage 2: Build Backend ────────────────────────────────────────────────────
FROM golang:1.22-alpine AS backend-builder

RUN apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /app
COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./

RUN CGO_ENABLED=1 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /callahan \
    ./cmd/callahan

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM alpine:3.20

RUN apk add --no-cache \
    ca-certificates \
    git \
    curl \
    sqlite-libs \
    docker-cli \
    && addgroup -S callahan \
    && adduser -S -G callahan callahan

WORKDIR /app

COPY --from=backend-builder /callahan /usr/local/bin/callahan

# Put frontend next to binary so it's found at runtime
COPY --from=frontend-builder /app/frontend/out /app/static

RUN mkdir -p /data && chown -R callahan:callahan /data /app

USER callahan

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

WORKDIR /app
ENTRYPOINT ["/usr/local/bin/callahan"]
