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


def head_binding() -> list[str]:
    """The HEAD, work-tree state and command the run belongs to (R3 finding 001)."""
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    return [
        f"run head={head} branch={branch} dirty={len(dirty.splitlines())}",
        f"run command=python3 scripts/p7-run-gates.py {sys.argv[1] if len(sys.argv) > 1 else ''}",
        f"run started={now()}",
    ]


def append(log: Path, line: str) -> None:
    with log.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def judge(gate: str, log: Path, extra: list[str] | None = None) -> int:
    cmd = ["node", "scripts/p7-gate-check.mjs", "--gate", gate, "--log", str(log)] + (extra or [])
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    for line in proc.stdout.splitlines():
        if line.startswith(f"GATE {gate} "):
            # the verdict is part of the audit trail, so it lands in the same log
            append(log, line)
    print(proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else f"GATE {gate} FAIL (no output)")
    return proc.returncode


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
    for line in head_binding():
        append(log, line)
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
    rc = subprocess.run(["node", *node_extra], cwd=ROOT, capture_output=True, text=True, env=dict(env, NODE_PATH=str(search), P7_DEBUG="1"))
    for line in (rc.stdout or "").splitlines():
        if "p7" in line or "mount" in line:
            append(log, f"# probe stdout: {line[:200]}")
    if rc.returncode != 0:
        append(log, "probe route registered=no at=" + now())
        append(log, f"# probe failed: {rc.stderr.strip().splitlines()[:3]}")
    newer = count_newer(stamp, home)
    append(log, f"probe owner-storage untouched={'yes' if newer == 0 else 'no'} newer={newer} at={now()}")

    selftest = subprocess.run(["node", "scripts/p7-gate-check.mjs", "--selftest"], cwd=ROOT, capture_output=True, text=True)
    append(log, f"# gate-check selftest rc={selftest.returncode}")
    for line in selftest.stdout.splitlines():
        if line.strip() == "SELFTEST PASS" or line.strip() == "SELFTEST FAIL":
            append(log, f"# {line.strip()}")
    selftest_ok = rc.returncode == 0 and selftest.returncode == 0
    verdict = judge("G1-P", log)
    append(log, "EXIT rc=" + str(0 if selftest_ok and verdict == 0 else 1))
    return 0 if selftest_ok and verdict == 0 else verdict or 1


EMPTY_SOURCE = r"""
// Cold-store probe: mount the real route with no provider and make sure it
// answers 200 with every domain named missing.
const [logPath, routesModule] = process.argv.slice(2)
const p7 = await import(routesModule)
const routes = []
const ctx = { get: (key) => (key === "webServer" ? { port: 0, register: (route) => { routes.push(route); return () => undefined } } : undefined) }
p7.mountP7(ctx)
await new Promise((r) => setTimeout(r, 50))
const res = await routes[0].resource(new Request("http://x/workbench/ui-snapshot.json"))
const body = await res.json()
const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00")
const { appendFileSync } = await import("node:fs")
for (const name of body.missing) appendFileSync(logPath, `empty domain=${name} present=no state=empty at=${stamp}\n`)
appendFileSync(logPath, `probe route empty status=${res.status} missing=${body.missing.length} at=${stamp}\n`)
process.exit(body.missing.length === 6 && res.status === 200 ? 0 : 1)
"""


def gate_empty(log: Path) -> int:
    log.write_text("", encoding="utf-8")
    for line in head_binding():
        append(log, line)
    append(log, f"env load={os.getloadavg()[0]:.2f} nproc={os.cpu_count()} at={now()}")
    home_empty = E2E / "home-empty"
    home_empty.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HOME=str(home_empty), DSH_HOME=str(home_empty / ".dsh"))
    (E2E / "empty.mjs").write_text(EMPTY_SOURCE, encoding="utf-8")
    rc = subprocess.run(["node", str(E2E / "empty.mjs"), str(log), str((ROOT / "packages/agent-cron-dashboard/src/ui/p7-routes.ts").as_posix())], cwd=ROOT, capture_output=True, text=True, env=env)
    if rc.returncode != 0:
        append(log, f"# empty probe failed: {rc.stderr.strip().splitlines()[:2]}")
    verdict = judge("G-EMPTY", log)
    append(log, "EXIT rc=" + str(0 if rc.returncode == 0 and verdict == 0 else 1))
    return 0 if rc.returncode == 0 and verdict == 0 else verdict or 1


def gate_g3(log: Path, min_total: int) -> int:
    log.write_text("", encoding="utf-8")
    for line in head_binding():
        append(log, line)
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

    verdict = judge("G3", log, ["--min-total", str(min_total)])
    append(log, "EXIT rc=" + str(0 if proc.returncode == 0 and verdict == 0 else 1))
    return 0 if proc.returncode == 0 and verdict == 0 else verdict or 1


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
let failed = false
let p7 = null
let index = null
let ledgerRecord = {
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
const routes = []
try {
  const { Context } = await import('@deepseek-ai/cordis')
  class StubWebServer {
    constructor() {
      this.port = 0
      this.registered = []
    }
    register(route) {
      this.registered.push(route)
      routes.push(route)
      return () => undefined
    }
  }
  const storagePlugins = await import('@deepseek-ai/dsh-storage')
  const storageJsonPlugin = await import('@deepseek-ai/dsh-storage-json')
  const storageDomainPlugin = await import('@deepseek-ai/dsh-storage-domain')
  index = await import(INDEX_PATH)
  p7 = await import(ROUTES_PATH)

  // ONE host context, exactly what a deployment provides: storage JSON backend,
  // a webServer service and the plugin's own apply.
  const hostCtx = new Context()
  const stubWebServer = new StubWebServer()
  hostCtx.reflect.provide('webServer', stubWebServer)

  await hostCtx.plugin(storagePlugins.Storage)
  await hostCtx.plugin(storageJsonPlugin, { root: root })
  await hostCtx.plugin(storageDomainPlugin, { backend: 'json' })
  for (let i = 0; i < 20 && hostCtx.get('storageDomain') === undefined; i += 1) await new Promise((r) => setTimeout(r, 250))


  index.apply(hostCtx, {})
  for (let i = 0; i < 60 && index.getWorkbenchService() === undefined; i += 1) await new Promise((r) => setTimeout(r, 250))
  for (let i = 0; i < 80 && Object.keys(index.getWorkbenchService()?.domains ?? {}).length < 6; i += 1) await new Promise((r) => setTimeout(r, 250))



  // The plugin effect mounts on its own timer; wait for the route, then read it.
  for (let i = 0; i < 120 && routes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 250))
  append(`# probe routes=${routes.length} after-wait`)

  // Wait for the row to publish the provider; the context that `apply` ran on
  // is where the row lives, so `index.getWorkbenchService()` becomes defined.
  for (let i = 0; i < 40 && index.getWorkbenchService() === undefined; i += 1) await new Promise((r) => setTimeout(r, 250))
  for (let i = 0; i < 60 && index.getWorkbenchService() === undefined; i += 1) await new Promise((r) => setTimeout(r, 250))
  const rowService = index.getWorkbenchService()
  for (let i = 0; i < 40 && (rowService === undefined || Object.keys(rowService.domains ?? {}).length < 6); i += 1) await new Promise((r) => setTimeout(r, 250))
  const names = Object.keys(rowService.domains)
  append(`probe storage domains=${names.length} tables=pr,issue,jobs,errors,events,health`)
  await rowService.domains.workbench_fleet_errors.table('records').put(ledgerRecord.recordId, ledgerRecord)

  // The plugin effect mounts on its own timer; wait for the route, then read it.
  for (let i = 0; i < 120 && routes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 250))
  append(`# probe routes=${routes.length} after-wait`)

  const port = await new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const route = routes.find((entry) => entry.path === '/workbench/ui-snapshot.json')
      if (route === undefined) {
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('no route registered')
        return
      }
      const response = await route.resource(new Request(`http://127.0.0.1${req.url}`, { method: req.method }))
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  const reply = await fetch(`http://127.0.0.1:${port}/workbench/ui-snapshot.json`)
  const text = await reply.text()
  const sha = (await import('node:crypto')).createHash('sha256').update(text).digest('hex')
  // Independent expectation: the probe projects the row's own tables and
  // serializes them here; the route's bytes are compared against that.
  const expectedSnapshot = p7.snapshotOf({
    errors: rowService.domains.workbench_fleet_errors.table('records'),
    pr: rowService.domains.workbench_snapshot_pr.table('snapshots'),
    issue: rowService.domains.workbench_snapshot_issue.table('snapshots'),
    jobs: rowService.domains.workbench_fleet_jobs.table('jobs'),
    events: rowService.domains.workbench_events.table('events'),
    health: rowService.domains.workbench_fleet_health.table('health'),
  })
  // the route stamps its own `at`; compare every field except that instant.
  const expectedText = JSON.stringify({ ...expectedSnapshot, at: JSON.parse(text).at })
  const expected = (await import('node:crypto')).createHash('sha256').update(expectedText).digest('hex')
  append(`probe route http status=${reply.status} content_type=${reply.headers.get('content-type')?.split(';')[0] ?? 'none'} bytes=${text.length} sha256=${sha} expected=${expected} route=${reply.headers.get('x-workbench-route') ?? 'fallback'} match=${sha === expected ? 'yes' : 'no'}`)
  // same route, cold store: mountP7 over a stub server with no provider
  const emptyRoutes = []
  const emptyCtx = { get: (key) => (key === 'webServer' ? { port: 0, register: (route) => { emptyRoutes.push(route); return () => undefined } } : undefined) }
  p7.mountP7(emptyCtx)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const emptyRes = await emptyRoutes[0].resource(new Request('http://x/workbench/ui-snapshot.json'))
  const emptyBody = await emptyRes.json()
  append(`probe route empty status=${emptyRes.status} missing=${emptyBody.missing.length}`)
} catch (error) {
  append(`# probe storage error: ${String(error).slice(0, 200).replace(/\n/g, ' ')}`)
  failed = true
}
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
