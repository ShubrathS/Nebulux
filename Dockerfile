# Nebulux — multi-agent orchestrator
# Build: docker build -t nebulux .
# Run:   docker run --env-file server/.env -p 3000:3000 nebulux

FROM node:20-alpine AS deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# App code (frontend at /app, backend at /app/server)
COPY server/ ./server/
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY index.html style.css script.js nebulux_logo.png ./

# Drop privileges
RUN addgroup -S nebulux && adduser -S nebulux -G nebulux \
    && mkdir -p /app/output && chown -R nebulux:nebulux /app
USER nebulux

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health > /dev/null || exit 1

CMD ["node", "server/index.js"]
