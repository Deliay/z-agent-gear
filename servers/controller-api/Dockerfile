# syntax=docker/dockerfile:1
FROM node:24-alpine AS build

ARG PNPM_VERSION=12.16.1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/usr/local/share/corepack
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .

FROM node:24-alpine AS runtime

ARG PNPM_VERSION=12.16.1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/usr/local/share/corepack
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=build /app /app

ENV NODE_ENV=production

USER node

ENTRYPOINT ["node", "src/index.ts"]
