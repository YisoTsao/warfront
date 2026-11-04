# FRONTLINE 對戰伺服器映像。必須以常駐容器執行（不能是 serverless function）。
#
#   docker build -f apps/game-server/Dockerfile -t frontline-server .
#   docker run -p 2567:2567 -e ALLOWED_ORIGINS=https://你的網站 frontline-server
#
# 森林谷地（assets/maps/forest-valley）已提交在 repo；範例地圖在建置時產生。

FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run maps:sample
RUN bun run build:server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=2567 \
    MAPS_DIR=/app/maps \
    RESULTS_LOG=/app/logs/match-results.jsonl
COPY --from=build /app/apps/game-server/dist/index.js ./index.js
COPY --from=build /app/assets/maps ./maps
RUN mkdir -p /app/logs && chown -R node:node /app
USER node
EXPOSE 2567
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Colyseus 收到 SIGTERM 時會優雅關閉：停止接受新玩家，等房間結束
CMD ["node", "index.js"]
