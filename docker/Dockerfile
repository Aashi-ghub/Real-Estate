FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json ./
COPY tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/utils/package.json packages/utils/package.json

RUN npm install

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run db:generate
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/docker ./docker

RUN chmod +x /app/docker/entrypoint-api.sh /app/docker/entrypoint-worker.sh

FROM runtime AS api-runtime
CMD ["sh", "/app/docker/entrypoint-api.sh"]

FROM runtime AS worker-runtime
CMD ["sh", "/app/docker/entrypoint-worker.sh"]
