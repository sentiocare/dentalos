#!/usr/bin/env bash
# Runs the browser tests end to end: fresh demo clinic, API and dashboard, then Playwright at phone size.
# Needs DATABASE_URL (a database the tests may reset, never production).
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a throwaway database}"
case "$DATABASE_URL" in *supabase.co*|*pooler.supabase.com*) echo "Refusing to run e2e against Supabase"; exit 1;; esac

export AUTH_JWT_SECRET="${AUTH_JWT_SECRET:-e2e-only-secret-0123456789abcdef0123456789}"
export APP_ENV=test DEV_LOGIN=on LOG_LEVEL=warn NEXT_TELEMETRY_DISABLED=1
API_PORT=${API_PORT:-8080}
WEB_PORT=${WEB_PORT:-3000}

pnpm db:migrate
pnpm --filter @dentalos/api seed:demo --reset
pnpm --filter @dentalos/api --filter @dentalos/web build

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

(cd apps/api && PORT=$API_PORT WEB_ORIGINS="http://localhost:$WEB_PORT" node dist/index.js) &
pids+=($!)
# Serve the dashboard exactly as the production image does (standalone server + static files).
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -r apps/web/public apps/web/.next/standalone/apps/web/
(cd apps/web/.next/standalone && API_URL="http://localhost:$API_PORT" PORT=$WEB_PORT HOSTNAME=127.0.0.1 node apps/web/server.js) &
pids+=($!)

for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null && curl -sf "http://localhost:$WEB_PORT/login" >/dev/null; then break; fi
  sleep 1
done

cd apps/web
E2E_BASE_URL="http://localhost:$WEB_PORT" E2E_API_URL="http://localhost:$API_PORT" npx playwright test "$@"
