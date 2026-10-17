#!/usr/bin/env bash
# Local idea-board preview: fake GitHub + Anthropic, the Worker with a local D1 database, synthetic fixtures, and the
# page built with the board on. Nothing is deployed and no paid model is called.
#
#   worker/dev/preview.sh          then open http://127.0.0.1:8765/board/   (Ctrl-C stops everything)
#
# Ports: 8765 page, 8788 Worker, 8790 fake services. Local data lives in worker/dev/.state (deleted on each run).
set -euo pipefail
cd "$(dirname "$0")/../.."                                   # repo root
ROOT=$PWD; DEV=worker/dev; STATE=$DEV/.state

rm -rf "$STATE"; mkdir -p "$STATE"
(cd worker && npm ci --silent >/dev/null 2>&1 || true)
echo "1/5 D1 schema"
(cd worker && npx wrangler d1 migrations apply repo-safari-board-preview --local --config dev/wrangler.preview.toml --persist-to dev/.state >/dev/null)
echo "2/5 fixtures"
node "$DEV/seed.mjs" sql "$STATE/seed.sql"
(cd worker && npx wrangler d1 execute repo-safari-board-preview --local --config dev/wrangler.preview.toml --persist-to dev/.state --file dev/.state/seed.sql >/dev/null)

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
echo "3/5 services"
node "$DEV/fake-services.mjs" 8790 & pids+=($!)
(cd worker && exec npx wrangler dev --config dev/wrangler.preview.toml --persist-to dev/.state --port 8788 --ip 127.0.0.1 --test-scheduled >"$ROOT/$STATE/worker.log" 2>&1) & pids+=($!)
until curl -s -o /dev/null http://127.0.0.1:8788/board/contest; do sleep 1; done
echo "4/5 close past weeks and move the queue"
node "$DEV/seed.mjs" finish http://127.0.0.1:8788
echo "5/5 page"
IDEAS_URL=http://127.0.0.1:8788 BOARD_ENABLED=1 DB_PATH=/nonexistent npm run -s build-safari -- https://w20labs.github.io/repo-safari/ --site _site/board
if ! curl -s -o /dev/null http://127.0.0.1:8765/; then python3 -m http.server 8765 --bind 127.0.0.1 --directory _site >/dev/null 2>&1 & pids+=($!); fi
echo
echo "Preview: http://127.0.0.1:8765/board/   (test clock: Wed 21 Oct 2026 15:00 UTC; Worker log: $STATE/worker.log)"
wait
