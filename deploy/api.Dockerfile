# API service image. Build from the repository root:
#   docker build -f deploy/api.Dockerfile -t dentalos-api .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dentalos/api --filter @dentalos/db build

FROM node:22-slim
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /repo/apps/api/dist/ ./
COPY --from=build /repo/packages/db/dist/index.js ./migrate.js
COPY --from=build /repo/packages/db/migrations ./migrations
# Sentio admin commands (create a clinic, demo data): node admin.js --help
USER node
EXPOSE 8080
# Railway runs `node migrate.js migrate` as the pre-deploy command (see deploy/railway/api.json).
CMD ["node", "--enable-source-maps", "index.js"]
