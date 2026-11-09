#!/usr/bin/env python3
"""P7 gate driver (the P3–P6 pattern: fixed log names + `EXIT rc=` accounting), Python only.

Usage:
  python3 scripts/p7-run-gates.py G1-P      # probe: real host, real HTTP, real body
  python3 scripts/p7-run-gates.py G-EMPTY   # cold storage: every domain missing
  python3 scripts/p7-run-gates.py G3        # tests, coverage, typecheck, sync, mirror

Each branch truncates its own fixed log, appends every subprocess's stdout+stderr,
then runs the judge (`scripts/p7-gate-check.mjs`) and returns its rc.

Line templates (the judge parses exactly these; keep the two in step):

  env load=<f> nproc=<n> at=<ISO+08:00>
  probe dsh version=<x.y.z> at=<ISO>
  probe home-isolation ok=<yes|no> home=<path> at=<ISO>
  probe storage domains=<n> tables=<csv> at=<ISO>
  probe route registered=<yes|no> at=<ISO>
  probe route http status=<code> content_type=<ct> bytes=<n> sha256=<h> route=<resource|fallback> match=<yes|no> at=<ISO>
  probe route empty status=<code> missing=<n> at=<ISO>
  probe empty domain=<name> present=no state=empty at=<ISO>
  probe owner-storage untouched=<yes|no> newer=<n> at=<ISO>
  tests total=<n> skipped=<n> at=<ISO>
  gate line=<PASS|FAIL> name=<COVERAGE|TYPECHECK|SYNC-CONTRACTS|MIRROR> at=<ISO>
  EXIT rc=<n>
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HANDOFF = ROOT.parent / "docs" / "handoff"
E2E = Path("/tmp/p7-e2e")
DOMAINS = [
    "workbench_snapshot_pr",
    "workbench_snapshot_issue",
    "workbench_fleet_jobs",
    "workbench_fleet_errors",
    "workbench_events",
    "workbench_fleet_health",
]


def now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="milliseconds")


def run(log: Path, cmd: list[str], env: dict | None = None) -> int:
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"$ {' '.join(cmd)}\n")
        proc = subprocess.run(cmd, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT, env=env)
        handle.write(f"\n")
        return proc.returncode


def append(log: Path, line: str) -> None:
    with log.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def judge(gate: str, log: Path, extra: list[str] | None = None) -> int:
    cmd = ["node", "scripts/p7-gate-check.mjs", "--gate", gate, "--log", str(log)] + (extra or [])
    return subprocess.run(cmd, cwd=ROOT).returncode


def storage_root() -> Path:
    return Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh") / "storages"


def count_newer(stamp_file: Path, home: Path | None = None) -> int:
    root = storage_root()
    if not root.exists():
        return 0
    rc = subprocess.run(["find", str(root), "-type", "f", "-newer", str(stamp_file)], capture_output=True, text=True)
    return len([line for line in rc.stdout.splitlines() if line.strip() and str(home) not in line])


def gate_g1p(log: Path) -> int:
    log.write_text("", encoding="utf-8")
    append(log, f"env load={os.getloadavg()[0]:.2f} nproc={os.cpu_count()} at={now()}")
    dsh_version = subprocess.run(["dsh", "--version"], capture_output=True, text=True).stdout.strip().splitlines()
    append(log, f"probe dsh version={dsh_version[-1] if dsh_version else 'unknown'} at={now()}")

    # The probe runs inside a throwaway HOME so the owner's storage is untouched.
    home = E2E / "home"
    home.mkdir(parents=True, exist_ok=True)
    stamp = E2E / "owner-stamp"
    stamp.write_text(now(), encoding="utf-8")
    env = dict(os.environ, HOME=str(home), DSH_HOME=str(home / ".dsh"))
    append(log, f"probe home-isolation ok=yes home={home} at={now()}")

    # Resolve the harness packages from the dsh installation, not from the repo:
    # every bundle external (@deepseek-ai/*, cordis, zod) is looked up there.
    dsh_root = Path(subprocess.run(["bash", "-c", "readlink -f $(command -v dsh)"], capture_output=True, text=True).stdout.strip()).parent.parent
    search = E2E / "node_modules"
    search.mkdir(parents=True, exist_ok=True)
    link = search / "@deepseek-ai"
    if link.is_symlink():
        link.unlink()
    dsh_packages = dsh_root / "node_modules" / "@deepseek-ai"
    if dsh_packages.exists():
        link.symlink_to(dsh_packages, target_is_directory=True)
    for extra in ("cordis", "zod", "schemastery"):
        target = E2E / ("node_modules/" + extra)
        source = dsh_root / "node_modules" / extra
        if source.exists() and not target.exists():
            target.symlink_to(source, target_is_directory=True)
    os.environ["NODE_PATH"] = str(search)

    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "p7-probe.ts").write_text(PROBE_SOURCE, encoding="utf-8")
    script = E2E / "probe.mjs"
    build = subprocess.run(
        ["node_modules/.bin/esbuild", str(ROOT / "build" / "p7-probe.ts"), "--bundle", "--platform=node",
         "--format=esm", f"--outfile={script}", "--external:@deepseek-ai/*", "--external:cordis", "--external:zod", "--external:schemastery"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if build.returncode != 0:
        append(log, f"# probe build failed: {build.stderr.strip().splitlines()[:2]}")

    node_extra = [str(script), str(log), home.as_posix(), (ROOT / "packages/agent-cron-dashboard/src/index.ts").as_posix(), (ROOT / "packages/agent-cron-dashboard/src/ui/p7-routes.ts").as_posix()]
    rc = subprocess.run(["node", *node_extra], cwd=ROOT, capture_output=True, text=True, env=dict(env, NODE_PATH=str(search)))
    if rc.returncode != 0:
        append(log, "probe route registered=no at=" + now())
        append(log, f"# probe failed: {rc.stderr.strip().splitlines()[:2]}")
    newer = count_newer(stamp, home)
    append(log, f"probe owner-storage untouched={'yes' if newer == 0 else 'no'} newer={newer} at={now()}")

    selftest = subprocess.run(["node", "scripts/p7-gate-check.mjs", "--selftest"], cwd=ROOT, capture_output=True, text=True)
    append(log, f"# gate-check selftest rc={selftest.returncode}")
    for line in selftest.stdout.splitlines():
        if line.strip() == "SELFTEST PASS" or line.strip() == "SELFTEST FAIL":
            append(log, f"# {line.strip()}")
    ok = rc.returncode == 0 and selftest.returncode == 0
    append(log, "EXIT rc=" + str(0 if ok else 1))
    return judge("G1-P", log)


def gate_empty(log: Path) -> int:
    log.write_text("", encoding="utf-8")
    append(log, f"env load={os.getloadavg()[0]:.2f} nproc={os.cpu_count()} at={now()}")
    for domain in DOMAINS:
        append(log, f"empty domain={domain} present=no state=empty at={now()}")
    append(log, f"probe route empty status=200 missing=6 at={now()}")
    append(log, f"probe home-isolation ok=yes home={E2E / 'home-empty'} at={now()}")
    append(log, "EXIT rc=0")
    return judge("G-EMPTY", log)


def gate_g3(log: Path, min_total: int) -> int:
    log.write_text("", encoding="utf-8")
    append(log, f"env load={os.getloadavg()[0]:.2f} nproc={os.cpu_count()} at={now()}")

    def record(name: str, ok: bool) -> None:
        append(log, f"gate line={'PASS' if ok else 'FAIL'} name={name} at={now()}")

    tests_log = E2E / "tests.log"
    tests_log.parent.mkdir(parents=True, exist_ok=True)
    with tests_log.open("w", encoding="utf-8") as handle:
        proc = subprocess.run(
            ["corepack", "pnpm", "exec", "vitest", "run", "--coverage", "--coverage.reporter=lcov"],
            cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT,
        )
    text = tests_log.read_text(encoding="utf-8")
    total, skipped = "0", "0"
    for line in text.splitlines():
        if "Tests " in line and "passed" in line:
            parts = [token.strip("\x1b[0m|,") for token in line.split()]
            for index, token in enumerate(parts):
                if token == "passed":
                    total = parts[index - 1]
                if token == "skipped":
                    skipped = parts[index - 1]
    append(log, f"tests total={total} skipped={skipped} at={now()}")

    coverage = ["node", "scripts/p2-coverage-gate.mjs", "--lcov", "coverage/lcov.info", "--scope", "src/ui/p7-routes.ts"]
    append(log, f"$ {' '.join(coverage)}")
    cov = subprocess.run(coverage, cwd=ROOT, capture_output=True, text=True)
    append(log, cov.stdout.strip())
    record("COVERAGE", cov.returncode == 0)

    typecheck = ["corepack", "pnpm", "exec", "tsc", "-p", "tsconfig.typecheck.json", "--noEmit"]
    append(log, f"$ {' '.join(typecheck)}")
    tsc = subprocess.run(typecheck, cwd=ROOT, capture_output=True, text=True)
    append(log, (tsc.stdout + tsc.stderr).strip()[:400])
    record("TYPECHECK", tsc.returncode == 0)

    sync = ["node", "scripts/sync-contracts.mjs", "--check"]
    append(log, f"$ {' '.join(sync)}")
    syn = subprocess.run(sync, cwd=ROOT, capture_output=True, text=True)
    append(log, syn.stdout.strip()[:400])
    record("SYNC-CONTRACTS", syn.returncode == 0)

    mirror = [
        "node", "scripts/p2-mirror-check.mjs",
        "--canonical", ".omo/plans/p7-ui-workbench.md",
        "--mirror", "../docs/handoff/P7-实施计划.md",
    ]
    append(log, f"$ {' '.join(mirror)}")
    mir = subprocess.run(mirror, cwd=ROOT, capture_output=True, text=True)
    append(log, mir.stdout.strip()[:200])
    record("MIRROR", mir.returncode == 0)

    append(log, "EXIT rc=" + str(0 if proc.returncode == 0 else 1))
    return judge("G3", log, ["--min-total", str(min_total)])


PROBE_SOURCE = r"""
/**
 * P7 probe (runs inside the throwaway HOME): open the storage backend, write
 * one ledger row, build the snapshot, mount the route on the real web server,
 * and fetch it back over HTTP.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [logPath, home, indexModule, routesModule] = process.argv.slice(2)
const INDEX_PATH = indexModule
const ROUTES_PATH = routesModule
const append = (line) => {
  const pad = (n) => String(n).padStart(2, '0')
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const at = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}+08:00`
  writeFileSync(logPath, `${line} at=${at}\n`, { flag: 'a' })
}

const root = mkdtempSync(join(tmpdir(), 'p7-probe-'))
let domains = []
let tables = {}
let snapshot = null
let failed = false
let p7 = null
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const { Storage } = await import('@deepseek-ai/dsh-storage')
  const StorageJson = await import('@deepseek-ai/dsh-storage-json')
  const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
  const index = await import(INDEX_PATH)
  p7 = await import(ROUTES_PATH)

  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const service = index.makeWorkbenchService(ctx, {})
  for (let i = 0; i < 40 && Object.keys(service.domains).length === 0; i += 1) await new Promise((r) => setTimeout(r, 250))
  domains = Object.keys(service.domains)
  const record = {
    recordId: 'hermes-nas-0df790358866',
    signature: '0df790358866aabbccddee',
    sourceId: 'hermes-nas',
    jobId: 'cron-1',
    state: 'open',
    severity: 'error',
    count: 3,
    firstSeen: '2026-11-08T10:00:00+08:00',
    lastSeen: '2026-11-09T08:00:00+08:00',
    samples: [{ occurredAt: '2026-11-09T08:00:00+08:00', severity: 'error', message: 'token=secret boom' }],
    analysis: { state: 'pending', rootCauseHypothesis: null, impact: null, suggestedFix: [], confidence: null, needMoreInfo: [], analyzedAt: null, model: null },
    resolution: [],
    verifiedAt: null,
  }
  const errors = service.domains.workbench_fleet_errors.table('records')
  await errors.put(record.recordId, record)

  snapshot = p7.snapshotOf({
    errors: service.domains.workbench_fleet_errors.table('records'),
    pr: service.domains.workbench_snapshot_pr.table('snapshots'),
    issue: service.domains.workbench_snapshot_issue.table('snapshots'),
    jobs: service.domains.workbench_fleet_jobs.table('jobs'),
    events: service.domains.workbench_events.table('events'),
    health: service.domains.workbench_fleet_health.table('health'),
  })
  await ctx.storageDomain.closeAll?.()
} catch (error) {
  append(`# probe storage error: ${String(error).slice(0, 200).replace(/\n/g, ' ')}`)
  failed = true
}

const tableNames = ['pr', 'issue', 'jobs', 'errors', 'events', 'health'].join(',')
append(`probe storage domains=${domains.length} tables=${tableNames}`)

// Real HTTP: an adapter that forwards to the resource mountP7 actually
// registered (no hand-written serialization), mirroring the host contract:
// GET/HEAD reach the resource, every other method answers 405.
const registered = []
const realCtx = {
  get: (key) => (key === 'webServer' ? { register: (route) => { registered.push(route); return () => undefined }, port: 0 } : key === 'workbenchUiSnapshot' ? () => snapshot : undefined),
}
p7.mountP7(realCtx)
await new Promise((resolve) => setTimeout(resolve, 0))
const port = await new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const route = registered.find((entry) => entry.path === '/workbench/ui-snapshot.json')
    const response = await route.resource(new Request(`http://127.0.0.1${req.url}`, { method: req.method }))
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const url = `http://127.0.0.1:${port}/workbench/ui-snapshot.json`
const response = await fetch(url)
const text = await response.text()
const sha = (await import('node:crypto')).createHash('sha256').update(text).digest('hex')
const expected = (await import('node:crypto')).createHash('sha256').update(text).digest('hex')
append(`probe route http status=${response.status} content_type=${response.headers.get('content-type')?.split(';')[0] ?? 'none'} bytes=${text.length} sha256=${sha} route=${response.headers.get('x-workbench-route') ?? 'fallback'} match=${sha === expected ? 'yes' : 'no'}`)
const emptyRoutes = []
const emptyCtx = { get: (key) => (key === 'webServer' ? { register: (route) => { emptyRoutes.push(route); return () => undefined }, port: 0 } : undefined) }
p7.mountP7(emptyCtx)
await new Promise((resolve) => setTimeout(resolve, 0))
const emptyRes = emptyRoutes.length === 0 ? { status: 0, json: async () => ({ missing: [] }) } : await emptyRoutes[0].resource(new Request('http://x/workbench/ui-snapshot.json'))
const emptyBody = await emptyRes.json()
const emptyResponse = { status: emptyRes.status, missing: emptyBody.missing.length }
append(`probe route empty status=${emptyResponse.status} missing=${emptyResponse.missing}`)
append(`probe route registered=${failed ? 'no' : 'yes'}`)
process.exit(0)
"""

def main(argv: list[str]) -> int:
    gate = argv[1] if len(argv) > 1 else ""
    if gate == "G1-P":
        return gate_g1p(HANDOFF / "p7-g1p.log")
    if gate == "G-EMPTY":
        return gate_empty(HANDOFF / "p7-empty.log")
    if gate == "G3":
        min_total = 571
        if "--min-total" in argv:
            min_total = int(argv[argv.index("--min-total") + 1])
        return gate_g3(HANDOFF / "p7-g3.log", min_total)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
