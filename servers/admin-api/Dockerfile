# syntax=docker/dockerfile:1
FROM node:24-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# 编译 TypeScript 到 dist（源内 ESM 说明符使用 .js 后缀，直接跑 TS 源码会 ERR_MODULE_NOT_FOUND）
RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# 运行时仅安装生产依赖；镜像启动不依赖 tsx / NODE_OPTIONS
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=build /app/dist ./dist

USER node

EXPOSE 4002

ENTRYPOINT ["node", "dist/index.js"]
