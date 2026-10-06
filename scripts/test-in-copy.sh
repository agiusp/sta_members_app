#!/usr/bin/env bash
# Runs the full test suite in a separate, throwaway copy of the local app
# (its own Supabase on different ports), so your own local data, sign-in and
# test clock are never reset. The copy is stopped afterwards (its files stay in ~/.doublesup-test-copy for next time).
#
#   scripts/test-in-copy.sh
#
# Needs about 2 GB of free memory in Colima while it runs.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# Under your home folder: Colima only shares folders there with Supabase.
copy="$HOME/.doublesup-test-copy"

rsync -a --delete --exclude .git --exclude 'supabase/.temp' --exclude 'supabase/.branches' "$repo/" "$copy/"
cd "$copy"

# Own project name and ports (543xx -> 544xx), so it runs beside the main copy.
sed -i '' \
  -e '1,/^project_id = /s/^project_id = .*/project_id = "sta_members_app_test"/' \
  -e 's/^\(port = \)543\([0-9][0-9]\)$/\1544\2/' \
  -e 's/^shadow_port = 54320$/shadow_port = 54420/' \
  -e 's/^inspector_port = 8083$/inspector_port = 8183/' \
  supabase/config.toml

cleanup() { supabase stop --no-backup >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Starting the test copy (a minute or two)..."
supabase start >/dev/null
tests/run.sh
