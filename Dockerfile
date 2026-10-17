# One image for every part of a self-hosted server: the gateway, a team server, their scheduled
# jobs, the setup step and the admin CLI. docker-compose.yml picks the command for each.
FROM node:24-slim AS build
# better-sqlite3 compiles from source where no prebuilt binary fits.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY spec/package.json spec/
COPY wiki/package.json wiki/
COPY control/package.json control/
COPY team/package.json team/
COPY gateway/package.json gateway/
RUN npm ci --no-audit --no-fund --loglevel=error
COPY . .

FROM node:24-slim
# git: team wikis and connected repos are git repositories. tini: signals and zombie reaping.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && printf '#!/bin/sh\ncd /app && exec node --import tsx gateway/src/admin-cli.ts "$@"\n' > /usr/local/bin/admin \
 && chmod 755 /usr/local/bin/admin \
 && mkdir -p /data /var/lib/brain-health \
 && chown node:node /data /var/lib/brain-health
WORKDIR /app
# Owned by root: the server (user node) can't rewrite its own code; it writes only to /data.
COPY --from=build /app /app
USER node
ENV BRAIN_LISTEN_HOST=0.0.0.0 \
    BRAIN_DATA_DIR=/data
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "gateway/src/server.ts"]
