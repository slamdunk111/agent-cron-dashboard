#!/usr/bin/env python3
"""P4 gate driver (the P3 pattern: fixed log names + `EXIT rc=` accounting), in Python.

Usage:
  python3 scripts/p4-run-gates.py base
  python3 scripts/p4-run-gates.py G3 [--min-total N]
  python3 scripts/p4-run-gates.py G1 [--window-minutes N] [--no-live]

Every branch writes its own fixed log, appends every subprocess's stdout+stderr
to it, records the `EXIT rc=` line of the primary step, then runs the judge and
returns its rc. The batch red line forbids new shell scripts, so this file is
Python only (same shape as `scripts/p3-run-gates.py`).

G1 = the fake seed segment (22-junction table, close-down path, backlog card,
digest idempotency, status tool) plus the live window segment, which forwards
the shipped P3 smoke's rounds. `--no-live` records the skip by name.
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
    "src/core/{change-engine,digest,grade,notify,notify-skill,"
    "schedule-types,tools-status}.ts"
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
    log = HANDOFF / "p4-g3-base.log"
    log.write_text("", encoding="utf-8")
    rc = run(log, ["corepack", "pnpm", "exec", "vitest", "run"])
    run(log, ["node", "scripts/p2-baseline-record.mjs", "--log", str(log), "--out", str(HANDOFF / "p4-baseline.txt")])
    return finish(log, rc)


def gate_g3(min_total: str) -> int:
    log = HANDOFF / "p4-g3.log"
    log.write_text("", encoding="utf-8")
    rc = 0
    run(log, ["node", "scripts/test-count.mjs"])
    rc |= run(log, ["corepack", "pnpm", "exec", "vitest", "run", "--coverage", "--coverage.reporter=lcov"])
    rc |= run(log, ["node", "scripts/p2-coverage-gate.mjs", "--lcov", "coverage/lcov.info", "--scope", COVERAGE_SCOPE])
    rc |= run(log, ["node", "scripts/p2-mirror-check.mjs", "--canonical", ".omo/plans/p4-change-engine.md", "--mirror", "../docs/handoff/P4-实施计划.md"])
    typecheck = run(log, ["corepack", "pnpm", "exec", "tsc", "-p", "tsconfig.typecheck.json", "--noEmit"])
    marker(log, "TYPECHECK PASS" if typecheck == 0 else "TYPECHECK FAIL")
    rc |= typecheck
    sync = run(log, ["node", "scripts/sync-contracts.mjs", "--check"])
    marker(log, "SYNC-CONTRACTS PASS" if sync == 0 else "SYNC-CONTRACTS FAIL")
    rc |= sync
    finish(log, rc)
    return run(log, ["node", "scripts/p4-gate-check.mjs", "--gate", "G3", "--log", str(log), "--min-total", min_total, "--baseline", str(HANDOFF / "p4-baseline.txt")])


def gate_g1(window: str, no_live: bool) -> int:
    log = HANDOFF / "p4-g1.log"
    log.write_text("", encoding="utf-8")
    cmd = ["node", "scripts/smoke-p4.mjs", "--window-minutes", window, "--action-cards=off"]
    if no_live:
        cmd.append("--no-live")
    rc = run(log, cmd)
    finish(log, rc)
    return run(log, ["node", "scripts/p4-gate-check.mjs", "--gate", "G1", "--log", str(log), "--window-minutes", "0" if no_live else window])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="P4 gates: base, G1, G3")
    parser.add_argument("gate", choices=["base", "G1", "G3"])
    parser.add_argument("--window-minutes", default="3")
    parser.add_argument("--min-total", default="251")
    parser.add_argument("--no-live", action="store_true")
    args = parser.parse_args(argv)
    HANDOFF.mkdir(parents=True, exist_ok=True)
    if args.gate == "base":
        return gate_base()
    if args.gate == "G3":
        return gate_g3(args.min_total)
    return gate_g1(args.window_minutes, args.no_live)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
