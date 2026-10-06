#!/usr/bin/env bash
# Runs every end-to-end test against the LOCAL Supabase, resetting the local
# database (and its fictitious test data) before each one.
# Afterwards, restore any private local setup, e.g. with
#   docker exec -i supabase_db_sta_members_app psql -U postgres < ~/Work/STA_SundayProgram/local-setup.sql
set -euo pipefail
cd "$(dirname "$0")/.."

for t in tests/*.test.mjs; do
  echo "=== $t"
  supabase db reset > /dev/null 2>&1
  node "$t"
done
