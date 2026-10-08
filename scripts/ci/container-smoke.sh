#!/usr/bin/env bash
# Container smoke test (module 8). Builds the image and proves, with a temporary volume:
#   - no .env, database or local data got into the image (decoys are planted and must be absent)
#   - no dev dependencies in the image
#   - it refuses to start without its secrets (exit code 78)
#   - it starts, applies the migrations, and with no owner stays in setup mode (health check only)
#   - once an owner exists, the web app and the worker start; /healthz works; HSTS is sent
#   - the process runs as a non-root user
#   - no secret appears in the log
#   - SIGTERM stops it cleanly (exit code 0); a restart on the same volume works and keeps the data
#
# Run it locally with Docker:   bash scripts/ci/container-smoke.sh
# Extra docker build / run arguments (for example behind a proxy):
#   SMOKE_BUILD_ARGS="--network host ..."   SMOKE_RUN_ARGS="--network none"
set -euo pipefail
cd "$(dirname "$0")/../.."

IMAGE="${SMOKE_IMAGE:-houcine-trades:smoke}"
NAME="houcine-smoke-$$"
VOLUME="houcine-smoke-data-$$"
PORT=10000
DECOY_ENV_CREATED=0
DECOY_DB="data/smoke-decoy.db"
DECOY_DB2="smoke-decoy-root.db"

fail() {
  echo "SMOKE FAIL: $*" >&2
  docker logs "$NAME" 2>&1 | tail -60 >&2 || true
  exit 1
}
ok() { echo "ok - $*"; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$DECOY_DB" "$DECOY_DB2"
  if [ "$DECOY_ENV_CREATED" = "1" ]; then rm -f .env; fi
}
trap cleanup EXIT

# ---- random values for this run only (nothing is stored) ---------------------------------------
rand() { head -c "$1" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
AUTH_SECRET="$(rand 48)"
BACKUP_KEY="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
S3_KEY_ID="AK$(rand 14 | tr -d '_-' | tr 'a-z' 'A-Z' | head -c 16)"
S3_SECRET="$(rand 30)"

# ---- 1. plant decoys, build ---------------------------------------------------------------------
if [ ! -e .env ]; then
  printf 'AUTH_SECRET=%s\n' "decoy-$(rand 30)" > .env
  DECOY_ENV_CREATED=1
fi
mkdir -p data
printf 'not a real database' > "$DECOY_DB"
printf 'not a real database' > "$DECOY_DB2"

# shellcheck disable=SC2086
docker build ${SMOKE_BUILD_ARGS:-} -t "$IMAGE" .
ok "image builds"

# ---- 2. what is inside the image ----------------------------------------------------------------
found="$(docker run ${SMOKE_RUN_ARGS:-} --rm --entrypoint sh "$IMAGE" -c \
  'find /app \( -name ".env" -o -name ".env.*" -o -name "*.db" -o -name "*.db-*" -o -name "smoke-decoy*" -o -name "*.pem" \) -not -path "/app/node_modules/*" 2>/dev/null; \
   test -d /app/data && echo "/app/data exists"; test -d /app/.git && echo ".git exists"; test -d /app/tests && echo "tests exist"; true')"
[ -z "$found" ] || fail "private or local files are in the image: $found"
ok "no .env, database, data folder, git folder or tests in the image (decoys were planted and are absent)"

docker run ${SMOKE_RUN_ARGS:-} --rm --entrypoint sh "$IMAGE" -c 'command -v find >/dev/null' \
  || fail "the image has no find command, so the scan for private files would pass vacuously"
docker run ${SMOKE_RUN_ARGS:-} --rm --entrypoint sh "$IMAGE" -c 'test ! -e /app/node_modules/vitest && test ! -e /app/node_modules/eslint && test ! -e /app/node_modules/prettier && test -e /app/node_modules/tsx' \
  || fail "dev dependencies are in the image (or tsx is missing)"
ok "no dev dependencies in the image"

docker run ${SMOKE_RUN_ARGS:-} --rm --entrypoint sh "$IMAGE" -c 'test -e /app/node_modules/next/package.json && test -d /app/.next && test -d /app/drizzle && test -d /app/docs' \
  || fail "the image misses next, the build output, the migrations or the docs"
ok "the image has the build output, the migrations and the docs"

# ---- 3. refuses to start without its secrets ----------------------------------------------------
set +e
refusal="$(docker run ${SMOKE_RUN_ARGS:-} --rm --name "${NAME}-refuse" "$IMAGE" 2>&1)"
code=$?
set -e
[ "$code" = "78" ] || { echo "$refusal" >&2; fail "expected exit code 78 without secrets, got $code"; }
echo "$refusal" | grep -q 'boot.refused' || fail "the refusal is not logged"
echo "$refusal" | grep -q 'auth_secret' || fail "the refusal does not name the missing AUTH_SECRET"
ok "refuses to start without secrets (exit 78, names the problem)"

# ---- 4. start with a temporary volume -----------------------------------------------------------
docker volume create "$VOLUME" >/dev/null
docker run ${SMOKE_RUN_ARGS:-} -d --name "$NAME" -v "$VOLUME:/var/data" \
  -e AUTH_SECRET="$AUTH_SECRET" -e BACKUP_KEY="$BACKUP_KEY" \
  -e TRUST_PROXY=true -e DATA_DIR=/var/data -e DATABASE_URL=file:/var/data/houcine-trades.db \
  -e S3_ENDPOINT=https://objects.smoke.invalid -e S3_REGION=eu-smoke-1 -e S3_BUCKET=smoke-bucket \
  -e S3_ACCESS_KEY_ID="$S3_KEY_ID" -e S3_SECRET_ACCESS_KEY="$S3_SECRET" \
  "$IMAGE" >/dev/null

probe() { # probe PATH -> "STATUS BODY"
  docker exec "$NAME" node -e "fetch('http://127.0.0.1:$PORT$1',{redirect:'manual'}).then(async r=>console.log(r.status+' '+(await r.text()).slice(0,30).replace(/\s+/g,' ')),()=>console.log('down'))" 2>/dev/null || echo down
}
wait_for() { # wait_for SECONDS DESCRIPTION CHECK...
  local limit="$1" what="$2"; shift 2
  for _ in $(seq 1 "$limit"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for: $what"
}
healthz_ok() { [ "$(probe /healthz)" = "200 ok" ]; }

wait_for 120 "setup mode health check" healthz_ok
docker logs "$NAME" 2>&1 | grep -q 'boot.setup_mode' || fail "no owner yet, but setup mode was not entered"
[ "$(probe /login | cut -d' ' -f1)" = "503" ] || fail "in setup mode the app must not serve pages"
ok "no owner yet: only /healthz answers (setup mode), pages are not served"

uid="$(docker exec "$NAME" sh -c "grep '^Uid:' /proc/1/status | cut -f2")"
[ "$uid" != "0" ] || fail "the main process runs as root"
ok "the process runs as a non-root user (uid $uid)"

count="$(docker exec "$NAME" node -e "const D=require('better-sqlite3');const d=new D('/var/data/houcine-trades.db',{readonly:true});console.log(d.prepare('select count(*) c from __drizzle_migrations').get().c)")"
[ "$count" -ge 7 ] || fail "migrations were not applied (found $count)"
ok "migrations applied on the volume ($count)"

# ---- 5. the owner appears (the real owner script needs a terminal: here a row is inserted) --------
docker exec "$NAME" node -e "
const D=require('better-sqlite3');const d=new D('/var/data/houcine-trades.db');
d.prepare(\"INSERT INTO owner (id,password_hash,totp_secret_enc,created_at,updated_at,password_changed_at) VALUES (1,'h','e','t','t','t')\").run();d.close();"
web_up() { [ "$(probe /login | cut -d' ' -f1)" = "200" ]; }
wait_for 120 "the web app after the owner exists" web_up
ok "owner exists: the web app and worker start"

wait_for 60 "/healthz with the worker running" healthz_ok
status="$(probe / | cut -d' ' -f1)"
{ [ "$status" = "303" ] || [ "$status" = "307" ]; } || fail "an unauthenticated visit to / should redirect to /login, got $status"
hsts="$(docker exec "$NAME" node -e "fetch('http://127.0.0.1:$PORT/login').then(r=>console.log(r.headers.get('strict-transport-security')||'none'))")"
case "$hsts" in max-age=*) ;; *) fail "HSTS is missing (got: $hsts)";; esac
ok "web app answers, / redirects to /login, HSTS is sent, /healthz is ok"

docker logs "$NAME" 2>&1 | grep -q '"child":"worker"' || fail "the worker did not start"
docker logs "$NAME" 2>&1 | grep -q '"event":"worker.started"' || fail "the worker did not report that it started"
ok "supervisor started the web server and the worker"

# /healthz must really say "not ok" when the worker shows no sign of life (the heartbeat file is removed)
docker exec "$NAME" rm -f /var/data/.worker-heartbeat
[ "$(probe /healthz)" = "503 not ok" ] || fail "/healthz must be 503 'not ok' without a worker heartbeat"
wait_for 90 "the worker to write its heartbeat again" healthz_ok
ok "/healthz is 503 'not ok' without a heartbeat and recovers when the worker is alive"

# the code is read-only for the app user, and the web server has no backup key or storage credentials
docker exec --user node "$NAME" sh -c 'touch /app/src/probe 2>/dev/null' && fail "the app user can write into the code" || true
env_check="$(docker exec --user node "$NAME" node -e "
const fs=require('fs');
for (const d of fs.readdirSync('/proc')) {
  if (!/^[0-9]+\$/.test(d) || d === String(process.pid)) continue; // never look at this checker itself
  try {
    const cmd = fs.readFileSync('/proc/'+d+'/cmdline','utf8');
    if (cmd.includes('next-server') || (cmd.includes('next') && cmd.includes('start'))) { // Next renames its process
      let env;
      try { env = fs.readFileSync('/proc/'+d+'/environ','utf8'); } catch { console.log('UNREADABLE'); process.exit(0); }
      console.log(/(^|\\0)(BACKUP_KEY|S3_SECRET_ACCESS_KEY)=/.test(env) ? 'LEAK' : 'CLEAN');
      process.exit(0);
    }
  } catch {}
}
console.log('NOPROC');
")"
[ "$env_check" = "CLEAN" ] || fail "web server environment check: $env_check (expected CLEAN)"
ok "code is read-only for the app user; the web server has no backup key or storage credentials"

# ---- 6. no secret in the log -------------------------------------------------------------------
logs="$(docker logs "$NAME" 2>&1)"
for secret in "$AUTH_SECRET" "$BACKUP_KEY" "$S3_SECRET" "$S3_KEY_ID"; do
  if printf '%s' "$logs" | grep -qF -- "$secret"; then fail "a secret value appears in the log"; fi
done
ok "no secret value appears in the log"

# ---- 7. clean stop, then a restart on the same volume ------------------------------------------
start_ts="$(date +%s)"
docker stop -t 30 "$NAME" >/dev/null
elapsed=$(( $(date +%s) - start_ts ))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$exit_code" = "0" ] || fail "expected a clean stop (exit 0), got $exit_code"
docker logs "$NAME" 2>&1 | grep -q 'supervisor.stopped' || fail "no clean-shutdown message"
ok "SIGTERM stops everything cleanly in ${elapsed}s (exit 0)"

docker start "$NAME" >/dev/null
wait_for 120 "restart on the same volume" healthz_ok
docker logs "$NAME" 2>&1 | grep -q 'release.up_to_date' || fail "the restart did not find the database up to date"
docker exec "$NAME" node -e "const D=require('better-sqlite3');const d=new D('/var/data/houcine-trades.db',{readonly:true});process.exit(d.prepare('select count(*) c from owner').get().c===1?0:1)" \
  || fail "the data did not survive the restart"
ok "restart on the same volume: data kept, nothing re-applied"

echo "ALL SMOKE CHECKS PASSED"
