# syntax=docker/dockerfile:1
FROM node:24-alpine AS build

ARG PNPM_VERSION=12.16.1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
# 编译 TypeScript 到 dist（源内 ESM 说明符使用 .js 后缀，直接跑 TS 源码会 ERR_MODULE_NOT_FOUND）
RUN pnpm run build

FROM node:24-alpine AS runtime

ARG PNPM_VERSION=12.16.1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 运行时仅安装生产依赖；镜像启动不依赖 tsx / NODE_OPTIONS
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --store-dir=/pnpm/store
COPY --from=build /app/dist ./dist

USER node

EXPOSE 4003

ENTRYPOINT ["node", "dist/index.js"]
