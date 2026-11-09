#!/usr/bin/env python3
"""P6 gate driver (the P3/P4/P5 pattern: fixed log names + `EXIT rc=` accounting), in Python.

Usage:
  python3 scripts/p6-run-gates.py base
  python3 scripts/p6-run-gates.py G1 [--no-live]
  python3 scripts/p6-run-gates.py G3 [--min-total N]

Every branch writes its own fixed log, appends every subprocess's stdout+stderr
to it, records the `EXIT rc=` line of the primary step, then runs the judge
(`scripts/p6-gate-check.mjs`) and returns its rc. The batch red line forbids new
shell scripts, so this file is Python only.

G1 = the fingerprint sheet (measured samples only) + the two replay playbooks
     (repair closure with the N-threshold and recurrence) + the mask check +
     the bridge over the measured run rows + the live window (`--live`,
     default on) that reads the NAS and runs a real model call. `--no-live`
     records the skip by name and cannot pass G1.
G3 = unit tests, coverage of the seven P6 files, mirror, typecheck, contract
     sync, the P5 zero-reference check and the state-matrix count.
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
    "src/fleet/{secret-mask,fingerprint,issues-machine,event-key,"
    "analyzer,error-pipeline,resolver,tools-errors}.ts"
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
    return rc


def check_p5_zero_ref(log: Path) -> int:
    """P5 sources must still never name the three keys; the row test asserts it."""
    rc = run(log, ["corepack", "pnpm", "exec", "vitest", "run", "test/fleet-p6-row.test.ts"])
    marker(log, "P5-ZERO-REF PASS" if rc == 0 else "P5-ZERO-REF FAIL")
    return rc


def check_state_matrix(log: Path) -> int:
    rc = run(log, ["corepack", "pnpm", "exec", "vitest", "run", "test/fleet-issues-machine.test.ts"])
    marker(log, "STATE-MATRIX PASS" if rc == 0 else "STATE-MATRIX FAIL")
    return rc


def gate_base() -> int:
    log = HANDOFF / "p6-baseline.txt"
    log.write_text("", encoding="utf-8")
    rc = run(log, ["corepack", "pnpm", "exec", "vitest", "run"])
    return finish(log, rc)


def gate_g3(min_total: str) -> int:
    log = HANDOFF / "p6-g3.log"
    log.write_text("", encoding="utf-8")
    rc = 0
    run(log, ["node", "scripts/test-count.mjs"])
    rc |= run(log, ["corepack", "pnpm", "exec", "vitest", "run", "--coverage", "--coverage.reporter=lcov"])
    rc |= run(log, ["node", "scripts/p2-coverage-gate.mjs", "--lcov", "coverage/lcov.info", "--scope", COVERAGE_SCOPE])
    rc |= run(log, ["node", "scripts/p2-mirror-check.mjs", "--canonical", ".omo/plans/p6-error-closure.md", "--mirror", "../docs/handoff/P6-实施计划.md"])
    typecheck = run(log, ["corepack", "pnpm", "exec", "tsc", "-p", "tsconfig.typecheck.json", "--noEmit"])
    marker(log, "TYPECHECK PASS" if typecheck == 0 else "TYPECHECK FAIL")
    rc |= typecheck
    sync = run(log, ["node", "scripts/sync-contracts.mjs", "--check"])
    marker(log, "SYNC-CONTRACTS PASS" if sync == 0 else "SYNC-CONTRACTS FAIL")
    rc |= sync
    rc |= check_p5_zero_ref(log)
    rc |= check_state_matrix(log)
    finish(log, rc)
    return run(log, ["node", "scripts/p6-gate-check.mjs", "--gate", "G3", "--log", str(log), "--min-total", min_total])


def gate_g1(no_live: bool) -> int:
    log = HANDOFF / "p6-g1.log"
    log.write_text("", encoding="utf-8")
    cmd = ["node", "scripts/smoke-p6.mjs", "--playbook"]
    cmd.append("--no-live" if no_live else "--live")
    # Truncate right before the first step: an interrupted earlier run can leave a
    # child appending to the same fixed log (P4 measured this). The fingerprint
    # evaluation runs *inside* the smoke so both sections share one env header.
    log.write_text("", encoding="utf-8")
    rc = run(log, cmd)
    finish(log, rc)
    judge = ["node", "scripts/p6-gate-check.mjs", "--gate", "G1", "--log", str(log)]
    if not no_live:
        judge.append("--live")
    return run(log, judge)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="P6 gates: base, G1, G3")
    parser.add_argument("gate", choices=["base", "G1", "G3"])
    parser.add_argument("--min-total", default="545")
    parser.add_argument("--no-live", action="store_true")
    # live is the default; --live is accepted so the E2E prompt in the plan reads as written.
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args(argv)
    HANDOFF.mkdir(parents=True, exist_ok=True)
    if args.gate == "base":
        return gate_base()
    if args.gate == "G3":
        return gate_g3(args.min_total)
    return gate_g1(args.no_live)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
