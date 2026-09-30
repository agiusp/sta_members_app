#!/usr/bin/env bash
# Sends the invite email for the very first developer, who then invites
# everyone else from the Developer page. The email must already be in the
# accounts table with is_developer = true.
#
# Local:  scripts/invite-first-developer.sh dev@example.com
#         (the invite shows up in the local test inbox, http://127.0.0.1:54324)
# Online: set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and APP_URL first. The
#         service role key is a secret: never commit it or paste it into a page.
set -euo pipefail

email="${1:?usage: $0 <email>}"

if [[ -z "${SUPABASE_URL:-}" ]]; then
  eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
  SUPABASE_URL="$API_URL"
  SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
fi
APP_URL="${APP_URL:-http://127.0.0.1:3000/app/}"

curl -sS -X POST "$SUPABASE_URL/auth/v1/invite?redirect_to=$APP_URL" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$email\"}"
echo
