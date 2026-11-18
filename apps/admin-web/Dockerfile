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

ARG VITE_ADMIN_API_URL
ENV VITE_ADMIN_API_URL=$VITE_ADMIN_API_URL
ARG VITE_AGENT_API_URL
ENV VITE_AGENT_API_URL=$VITE_AGENT_API_URL
RUN pnpm run build

FROM caddy:2-alpine AS runtime

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
COPY docker-entrypoint.d/ /docker-entrypoint.d/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /docker-entrypoint.d/*.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

EXPOSE 80
