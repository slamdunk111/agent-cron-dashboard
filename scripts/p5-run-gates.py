#!/usr/bin/env python3
"""P5 gate driver (P3/P4 pattern: fixed log names + `EXIT rc=` accounting), in Python.

Usage:
  python3 scripts/p5-run-gates.py base
  python3 scripts/p5-run-gates.py G1 [--rounds N] [--no-live] [--inject-failure]
  python3 scripts/p5-run-gates.py G3 [--min-total N]

Every branch writes its own fixed log, appends every subprocess's stdout+stderr
to it, records the `EXIT rc=` line of the primary step, then runs the judge
(`scripts/p5-gate-check.mjs`) and returns its rc. The batch red line forbids new
shell scripts, so this file is Python only (same shape as `p4-run-gates.py`).

G1 = fixture replay of all three adapters + the real NAS/GMK rounds (`--rounds`,
default 3) + one injected ssh failure (`--inject-failure`). A no-live run
records the skip by name and cannot pass G1 (the gate needs the real rounds).
G3 = unit tests, coverage of the seven fleet files, mirror, typecheck and contract sync.
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
    "src/fleet/{ssh-exec,log-tail,hermes-ssh,jiuwenswarm-local,"
    "generic-ssh-sqlite,grade-fleet,fleet-watch}.ts"
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
    log = HANDOFF / "p5-g3-base.log"
    log.write_text("", encoding="utf-8")
    rc = run(log, ["corepack", "pnpm", "exec", "vitest", "run"])
    finish(log, rc)
    return rc


def gate_g3(min_total: str) -> int:
    log = HANDOFF / "p5-g3.log"
    log.write_text("", encoding="utf-8")
    rc = 0
    run(log, ["node", "scripts/test-count.mjs"])
    rc |= run(log, ["corepack", "pnpm", "exec", "vitest", "run", "--coverage", "--coverage.reporter=lcov"])
    rc |= run(log, ["node", "scripts/p2-coverage-gate.mjs", "--lcov", "coverage/lcov.info", "--scope", COVERAGE_SCOPE])
    rc |= run(log, ["node", "scripts/p2-mirror-check.mjs", "--canonical", ".omo/plans/p5-fleet-adapters.md", "--mirror", "../docs/handoff/P5-实施计划.md"])
    typecheck = run(log, ["corepack", "pnpm", "exec", "tsc", "-p", "tsconfig.typecheck.json", "--noEmit"])
    marker(log, "TYPECHECK PASS" if typecheck == 0 else "TYPECHECK FAIL")
    rc |= typecheck
    sync = run(log, ["node", "scripts/sync-contracts.mjs", "--check"])
    marker(log, "SYNC-CONTRACTS PASS" if sync == 0 else "SYNC-CONTRACTS FAIL")
    rc |= sync
    finish(log, rc)
    return run(log, ["node", "scripts/p5-gate-check.mjs", "--gate", "G3", "--log", str(log), "--min-total", min_total, "--baseline", str(HANDOFF / "p5-baseline.txt")])


def gate_g1(rounds: str, no_live: bool, inject_failure: bool) -> int:
    log = HANDOFF / "p5-g1.log"
    log.write_text("", encoding="utf-8")
    cmd = ["node", "scripts/smoke-p5.mjs", "--rounds", "0" if no_live else rounds]
    if no_live:
        cmd.append("--no-live")
    if inject_failure:
        cmd.append("--inject-failure")
    # Truncate again immediately before the step: an interrupted earlier run can
    # leave a smoke child appending to the same fixed log (P4 measured this).
    log.write_text("", encoding="utf-8")
    rc = run(log, cmd)
    finish(log, rc)
    return run(log, ["node", "scripts/p5-gate-check.mjs", "--gate", "G1", "--log", str(log)])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="P5 gates: base, G1, G3")
    parser.add_argument("gate", choices=["base", "G1", "G3"])
    parser.add_argument("--rounds", default="3")
    parser.add_argument("--min-total", default="401")
    parser.add_argument("--no-live", action="store_true")
    parser.add_argument("--inject-failure", action="store_true")
    args = parser.parse_args(argv)
    HANDOFF.mkdir(parents=True, exist_ok=True)
    if args.gate == "base":
        return gate_base()
    if args.gate == "G3":
        return gate_g3(args.min_total)
    return gate_g1(args.rounds, args.no_live, args.inject_failure)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
