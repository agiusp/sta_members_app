#!/usr/bin/env bash
# Makes a separate local DEMO copy of the app (its own Supabase on ports
# 546xx, pages on http://127.0.0.1:3100/app/) filled with made-up club data
# by scripts/demo-seed.mjs. Your own local copy and its data are untouched.
#
#   DEMO_PASSWORD=... scripts/demo-copy.sh         start (or refresh) and fill it
#   scripts/demo-copy.sh stop                      stop it
#
# Sign in as alice.johnson@example.com (member) or dev@example.com
# (developer) with DEMO_PASSWORD. Needs about 2 GB of free memory in Colima.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
copy="$HOME/.sta-members-demo-copy"

if [[ "${1:-}" == "stop" ]]; then
  cd "$copy" && supabase stop >/dev/null 2>&1 || true
  pkill -f "$copy/scripts/serve.py" || true
  exit 0
fi
: "${DEMO_PASSWORD:?Set DEMO_PASSWORD (at least 10 characters)}"

rsync -a --delete --exclude .git --exclude 'supabase/.temp' --exclude 'supabase/.branches' "$repo/" "$copy/"
cd "$copy"

# Own project name and ports (543xx -> 546xx); no test data from seed.sql;
# links in emails point to the online demo's address.
sed -i '' \
  -e '1,/^project_id = /s/^project_id = .*/project_id = "sta_members_app_demo"/' \
  -e 's/^\(port = \)543\([0-9][0-9]\)$/\1546\2/' \
  -e 's/^shadow_port = 54320$/shadow_port = 54620/' \
  -e 's/^inspector_port = 8083$/inspector_port = 8383/' \
  -e 's#127.0.0.1:3000#127.0.0.1:3100#g; s#localhost:3000#localhost:3100#g' \
  supabase/config.toml
sed -i '' '/^\[db.seed\]/,/^enabled/ s/^enabled = true/enabled = false/' supabase/config.toml
printf '\n[edge_runtime.secrets]\nAPP_URL = "https://agiusp.github.io/sta_members_app/app/"\n' >> supabase/config.toml
sed -i '' 's#http://127.0.0.1:54321#http://127.0.0.1:54621#' app/config.js

echo "Starting the demo copy (a minute or two)..."
supabase start >/dev/null
supabase db reset >/dev/null 2>&1    # start from empty every time
eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|SERVICE_ROLE_KEY|PUBLISHABLE_KEY)=')"
SUPABASE_URL="$API_URL" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
  DEMO_PASSWORD="$DEMO_PASSWORD" node scripts/demo-seed.mjs

pkill -f "$copy/scripts/serve.py" || true
PORT=3100 nohup python3 "$copy/scripts/serve.py" >/dev/null 2>&1 &
echo "Demo copy: http://127.0.0.1:3100/app/   Demo inbox for developers: Developers sign-in, then Demo inbox."
