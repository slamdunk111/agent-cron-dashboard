#!/usr/bin/env python3
"""P3 gate driver (the P2 pattern: fixed log names + `EXIT rc=` accounting), in Python.

Usage:
  python3 scripts/p3-run-gates.py base
  python3 scripts/p3-run-gates.py G3 [--min-total N]
  python3 scripts/p3-run-gates.py G2 [--window-minutes N]
  python3 scripts/p3-run-gates.py G1 [--window-minutes N]

Every branch appends its own `EXIT rc=` line to the fixed log, so the log is the
single evidence source and a truncated run cannot look like a pass. The batch
red line forbids new shell scripts, so this file replaces the draft
`p3-run-gates.sh` one-to-one (same branch names, same logs, same rc bookkeeping).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HANDOFF = ROOT.parent / "docs" / "handoff"
COVERAGE_SCOPE = (
    "src/community/{community-row,http-get,issue-sources,issue-types,"
    "issue-watch,issue-watch-github,issue-watch-gitcode}.ts"
)


def run(log: Path, cmd: list[str]) -> int:
    """Run one step; both streams go into the gate log; returns its rc."""
    env = dict(os.environ)
    env["CI"] = "1"
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env)
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"$ {' '.join(cmd)}\n")
        if proc.stdout:
            handle.write(proc.stdout if proc.stdout.endswith("\n") else proc.stdout + "\n")
        if proc.stderr:
            handle.write(proc.stderr if proc.stderr.endswith("\n") else proc.stderr + "\n")
    return proc.returncode


def marker(log: Path, text: str) -> None:
    with log.open("a", encoding="utf-8") as handle:
        handle.write(text + "\n")


def finish(log: Path, rc: int) -> int:
    marker(log, f"EXIT rc={rc}")
    print(f"EXIT rc={rc} ({log})")
    return rc


def gate_base() -> int:
    log = HANDOFF / "p3-g3-base.log"
    log.write_text("", encoding="utf-8")
    rc = run(log, ["corepack", "pnpm", "exec", "vitest", "run"])
    run(log, ["node", "scripts/p2-baseline-record.mjs", "--log", str(log), "--out", str(HANDOFF / "p3-baseline.txt")])
    return finish(log, rc)


def gate_g3(min_total: str) -> int:
    log = HANDOFF / "p3-g3.log"
    log.write_text("", encoding="utf-8")
    rc = 0
    run(log, ["node", "scripts/test-count.mjs"])
    rc |= run(log, ["corepack", "pnpm", "exec", "vitest", "run", "--coverage", "--coverage.reporter=lcov"])
    rc |= run(log, ["node", "scripts/p2-coverage-gate.mjs", "--lcov", "coverage/lcov.info", "--scope", COVERAGE_SCOPE])
    rc |= run(log, ["node", "scripts/p2-mirror-check.mjs", "--canonical", ".omo/plans/p3-issue-polling.md", "--mirror", "../docs/handoff/P3-实施计划.md"])
    typecheck = run(log, ["corepack", "pnpm", "exec", "tsc", "-p", "tsconfig.typecheck.json", "--noEmit"])
    marker(log, "TYPECHECK PASS" if typecheck == 0 else "TYPECHECK FAIL")
    rc |= typecheck
    sync = run(log, ["node", "scripts/sync-contracts.mjs", "--check"])
    marker(log, "SYNC-CONTRACTS PASS" if sync == 0 else "SYNC-CONTRACTS FAIL")
    rc |= sync
    finish(log, rc)
    verdict = run(log, ["node", "scripts/p3-gate-check.mjs", "--gate", "G3", "--log", str(log), "--min-total", min_total, "--baseline", str(HANDOFF / "p3-baseline.txt")])
    return verdict


def gate_g2(window: str) -> int:
    log = HANDOFF / "p3-g2.log"
    log.write_text("", encoding="utf-8")
    rc = run(log, ["node", "scripts/smoke-p3.mjs", "--no-token", "--offline", "--window-minutes", window, "--tick-seconds", "30"])
    finish(log, rc)
    return run(log, ["node", "scripts/p3-gate-check.mjs", "--gate", "G2", "--log", str(log), "--window-minutes", window])


def gate_g1(window: str) -> int:
    log = HANDOFF / "p3-g1.log"
    log.write_text("", encoding="utf-8")
    run(log, ["node", "scripts/p3-oracle.mjs", "--out", str(HANDOFF / "p3-oracle-github.json")])
    rc = run(log, ["node", "scripts/smoke-p3.mjs", "--config", "fixtures/p3-smoke-config.yaml", "--window-minutes", window, "--tick-seconds", "30"])
    finish(log, rc)
    return run(log, ["node", "scripts/p3-gate-check.mjs", "--gate", "G1", "--log", str(log), "--oracle", str(HANDOFF / "p3-oracle-github.json"), "--window-minutes", window])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="P3 gates: base, G1, G2, G3")
    parser.add_argument("gate", choices=["base", "G1", "G2", "G3"])
    parser.add_argument("--window-minutes", default="10")
    parser.add_argument("--min-total", default="226")
    args = parser.parse_args(argv)
    HANDOFF.mkdir(parents=True, exist_ok=True)
    if args.gate == "base":
        return gate_base()
    if args.gate == "G3":
        return gate_g3(args.min_total)
    if args.gate == "G2":
        return gate_g2(args.window_minutes)
    return gate_g1(args.window_minutes)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
