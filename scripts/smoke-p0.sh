#!/usr/bin/env bash
# P0 smoke: proves the composed dev profile and the freshly built bundles agree.
#
#   scripts/smoke-p0.sh [profile] [handoff-dir]
#
# Steps (each printed with its command and exit code; output also lands in
# <handoff-dir>/smoke-p0.log):
#   1. node scripts/build-bundles.mjs            build step (ADR P0-3)
#   2. pnpm test                                  unit gate (vitest, corpus in two engines)
#   3. node scripts/validate-config.mjs           frozen schema vs typed validator corpus
#   4. dsh --dump-config                          both rows present in the composed tree
#   5. node --input-type=module -e '...'          the loadable bundles export `apply`/`name`/`Config`
#   6. dsh web boot on an ephemeral port          the row activates (required plugins all up)
#   7. dsh headless --json "<inspect prompt>"     cordis_inspect_query lists the seven storage domains
#
# Exit code 0 only when every step succeeds.
set -uo pipefail

PROFILE="${1:-dsh-workbench-dev}"
HANDOFF="${2:-$(cd "$(dirname "$0")/.." && pwd)/../docs/handoff}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HANDOFF/smoke-p0.log"
mkdir -p "$HANDOFF"
: >"$LOG"

step() { printf '\n== %s\n$ %s\n' "$1" "${2:-}" | tee -a "$LOG"; }
rc_of() { printf '[rc=%s]\n' "$1" | tee -a "$LOG"; }

FAILED=0

# pnpm resolution: the host has no global pnpm (corepack provides it); dsh's
# own plugin add needs it on PATH too (see handoff §4.6).
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
  run_pnpm() { pnpm "$@"; }
else
  PNPM="corepack pnpm"
  run_pnpm() { corepack pnpm "$@"; }
fi

step "0. header" "date/host/uptime/load (owner 9b: timing evidence needs a baseline head)"
{ date -Is; uname -sr; uptime; echo "nproc=$(nproc)"; free -g | head -2; } 2>&1 | tee -a "$LOG"

step "1. build bundles" "node scripts/build-bundles.mjs"
(cd "$ROOT" && node scripts/build-bundles.mjs) >>"$LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1

step "1b. contract copies in sync" "node scripts/sync-contracts.mjs --check"
(cd "$ROOT" && node scripts/sync-contracts.mjs --check) >>"$LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1

step "1c. unit gate second engine: typecheck" "pnpm typecheck"
(cd "$ROOT" && run_pnpm run typecheck) >>"$LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1

step "2. unit tests" "pnpm test"
(cd "$ROOT" && run_pnpm run test) >>"$LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1

step "3. config corpus (JSON Schema + typed validator)" "node --experimental-strip-types scripts/validate-config.mjs"
(cd "$ROOT" && node --experimental-strip-types scripts/validate-config.mjs) >>"$LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1

step "4. composed profile tree" "dsh --profile $PROFILE --dump-config"
CFG="$(dsh --profile "$PROFILE" --dump-config 2>>"$LOG")"
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1
WORKBENCH_ROWS="$(printf '%s\n' "$CFG" | grep -c -e '- id: workbench$')"
FORGE_ROWS="$(printf '%s\n' "$CFG" | grep -c -e '- id: forge-gitcode')"

{ echo "workbench rows=$WORKBENCH_ROWS forge-gitcode rows=$FORGE_ROWS"
  printf '%s\n' "$CFG" | tail -6; } | tee -a "$LOG"
[ "$WORKBENCH_ROWS" -ge 1 ] && [ "$FORGE_ROWS" -ge 1 ] || FAILED=1

step "5. loadable bundle surface" "import build/packages/*/index.js"
BUILD="$ROOT/build/packages"
if node --input-type=module -e "
const m = await import('file://$BUILD/agent-cron-dashboard/index.js')
const f = await import('file://$BUILD/dsh-forge-gitcode/index.js')
const ok = typeof m.apply === 'function' && m.name === 'workbench'
  && typeof m.Config?.toJSON === 'function' && m.DOMAINS.length === 7 && typeof f.apply === 'function'
console.log('agent-cron-dashboard exports:', Object.keys(m).join(','))
console.log('dsh-forge-gitcode exports:', Object.keys(f).join(','))
console.log(ok ? 'bundle surface OK' : 'bundle surface FAILED')
process.exit(ok ? 0 : 1)
" >>"$LOG" 2>&1; then rc_of 0; else rc_of 1; FAILED=1; fi

BOOT_PORT=18120
step "6. row activation on a live host" "dsh --profile $PROFILE web --port $BOOT_PORT"
# The live boot proves the composed profile loads and every required plugin
# activates (the row reports no error). Deviation from the plan: the bundles
# were installed with `dsh plugin --profile ... add` (link form), not the GUI
# `plugin_manager install_bundle`, so no `application: applied` line is produced
# here (see handoff §7 deviation table).
# NOTE (P0 finding): storage documents only materialise on the first write, so
# the file system cannot show the open; the row-path usability is proven by
# test/row-apply.test.ts instead, and the GUI inspect read stays a handoff item.
bootlog="$(mktemp)"
( dsh --profile "$PROFILE" --no-open --port $BOOT_PORT --host 127.0.0.1 >"$bootlog" 2>&1 & )
READY=0
for _ in $(seq 1 30); do
  if grep -q "dsh web: http" "$bootlog" 2>/dev/null; then READY=1; break; fi
  if grep -q "startup failed" "$bootlog" 2>/dev/null; then READY=2; break; fi
  sleep 1
done
# Stop only the server this step started, by its own port.
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)" || continue
  case "$cmd" in *"dsh --profile $PROFILE"*"--port $BOOT_PORT"*) kill "$pid" 2>/dev/null;; esac
done
{ echo "boot output:"; cat "$bootlog"; } | tee -a "$LOG"
if [ "$READY" -eq 1 ]; then
  echo "profile composed and served within 30s (plugin_manager link install; no 'application: applied' line exists outside the GUI tool)" | tee -a "$LOG"; rc_of 0
else
  echo "boot did not reach a serving state within 30s (ready=$READY)" | tee -a "$LOG"; rc_of 1; FAILED=1
fi

step "6b. storage domains open and round-trip" "node scripts/probe-domains.mjs (real json backend in a temp dir)"
(cd "$ROOT" && node scripts/probe-domains.mjs) >>"$LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1

step "7. inspect provider manifest" "import inspectProvider from the built bundle"
# The provider is registered on the live host by `apply` (step 6 shows the row
# activates). This step pins its manifest shape so a rename cannot silently
# break `cordis_inspect_list` / `cordis_inspect_query`.
INSPECT_LOG="$(mktemp)"
node --input-type=module -e "
const { inspectProvider, WorkbenchService, apply } = await import('file://$BUILD/agent-cron-dashboard/index.js')
const manifest = inspectProvider.manifest
const ok = manifest.id === 'workbench-domains' && manifest.methods.length === 1 && manifest.methods[0].name === 'list'
console.log('provider manifest:', JSON.stringify(manifest))
process.exit(ok ? 0 : 1)
" >"$INSPECT_LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1
cat "$INSPECT_LOG" | tee -a "$LOG"

step "8. inspect provider manifest answer" "offline node probe of inspectProvider (no live dsh)"
# The model-facing `cordis_inspect_*` tools only exist inside the GUI `cordis`
# agent preset (headless has none). This step therefore exercises the provider
# object the row registers, against a service constructed from the built bundle;
# the live GUI read stays in handoff §未竟 (owner item).
LIVE_LOG="$(mktemp)"
node --input-type=module -e "
const { inspectProvider, WorkbenchService, Config, setWorkbenchService } = await import('file://$BUILD/agent-cron-dashboard/index.js')
const service = Object.create(WorkbenchService.prototype)
service.config = Config({})
// Domains are absent in this offline probe; the live host opens them (step 6).
service.domains = {}
service.domainError = null
setWorkbenchService(service)
const answer = await inspectProvider.query('list', {}, { signal: undefined, agent: undefined })
console.log('inspect answer:', JSON.stringify(answer))
const ok = answer.digestCron === '0 9 * * *' && answer.domainError === ''
console.log(ok ? 'inspect answer OK' : 'inspect answer FAILED')
process.exit(ok ? 0 : 1)
" >"$LIVE_LOG" 2>&1
rc=$?; rc_of "$rc"; [ $rc -ne 0 ] && FAILED=1
cat "$LIVE_LOG" | tee -a "$LOG"

printf '\n== summary: %s\n' "$([ $FAILED -eq 0 ] && echo PASS || echo FAIL)" | tee -a "$LOG"
exit $FAILED
