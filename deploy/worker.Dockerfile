# Background worker image. Build from the repository root:
#   docker build -f deploy/worker.Dockerfile -t dentalos-worker .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dentalos/worker build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/worker/dist/ ./
USER node
CMD ["node", "--enable-source-maps", "index.js"]
