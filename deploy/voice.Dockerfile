# Voice service image (phone-call media streams). Build from the repository root:
#   docker build -f deploy/voice.Dockerfile -t dentalos-voice .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dentalos/voice build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/voice/dist/ ./
USER node
EXPOSE 8090
CMD ["node", "--enable-source-maps", "index.js"]
