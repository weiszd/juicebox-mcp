#!/usr/bin/env bash
# Build juicebox-web (fork worktree with the room widget) and upload it to the
# Cloudflare Pages project "juicebox-web-dev", served at https://juicebox-v2.3dg.io/.
# Direct upload, not a git build: the branch depends on local tarballs (juicebox.js
# 4.6.0 from the fork, @aidenlab/juicebox-remote) that are not published.
#
#   WEB_DIR=../juicebox-web-16 scripts/deploy-web-dev.sh
#
# Vite inlines VITE_* vars at build time and a direct upload never sees the Pages
# project's variables, so everything the page needs is passed here. The Share
# button shortens through juicebox-web's own jb-shortlink worker, so no TinyURL key.
#
# Pairs with the v2 Worker: `wrangler deploy --env v2` in packages/server (its
# [env.v2] BROWSER_URL points here and ALLOWED_ORIGINS lists this origin).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${WEB_DIR:-$REPO_ROOT/../juicebox-web-16}"
PROJECT="${PROJECT:-juicebox-web-dev}"
VITE_WS_URL="${VITE_WS_URL:-wss://juicebox-mcp-v2.aidenlab.workers.dev/ws}"
cd "$WEB_DIR"
echo "building $WEB_DIR with VITE_WS_URL=$VITE_WS_URL"
VITE_WS_URL="$VITE_WS_URL" npm run build
grep -q "${VITE_WS_URL#wss://}" dist/assets/*.js || { echo "built assets do not contain $VITE_WS_URL" >&2; exit 1; }
grep -q "juicebox.aidenlab.org/shorten" dist/assets/*.js || { echo "built assets do not contain the jb-shortlink /shorten endpoint" >&2; exit 1; }
npx wrangler pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true
echo "live at https://juicebox-v2.3dg.io/ (and https://$PROJECT.pages.dev/)"
