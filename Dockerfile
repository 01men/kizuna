# Kizuna Hub — 中心服务镜像（含安装脚本与 kizuna-box 下发源）
FROM node:24-slim AS build
WORKDIR /app
COPY hub/package.json hub/package-lock.json ./
RUN npm ci
COPY hub/ ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY install ./install
# kizuna-box 单文件（经 /install/box.js 下发给端侧安装脚本）
COPY box/kizuna-box ./static/kizuna-box.js

ENV KIZUNA_DATA_DIR=/data \
    KIZUNA_HOST=0.0.0.0 \
    KIZUNA_PORT=7700
VOLUME /data
EXPOSE 7700
CMD ["node", "dist/index.js"]
