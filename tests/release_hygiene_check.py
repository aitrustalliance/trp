#!/usr/bin/env python3
"""Fail when tracked files would put build output or local machine paths into a release archive.

Zenodo and GitHub release archives are built from the tracked tree, and an archived file cannot be
changed after publication. This check runs on every push so compiled Python files and absolute
paths from a contributor's machine never reach a tagged release.

Usage: python tests/release_hygiene_check.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

BLOCKED_SUFFIXES = (".pyc", ".pyo", ".class", ".o", ".so", ".dll", ".exe")
BLOCKED_PARTS = (
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "node_modules",
    ".venv",
)
LOCAL_PATH = re.compile(
    rb"(/home/[A-Za-z0-9._-]+/|/Users/[A-Za-z0-9._-]+/|\b[A-Z]:\\\\?[A-Za-z0-9 ._-]+\\)"
)


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
    ).stdout
    return [name for name in out.decode("utf-8").split("\0") if name]


def main() -> int:
    problems: list[str] = []
    for name in tracked_files():
        parts = Path(name).parts
        if name.endswith(BLOCKED_SUFFIXES) or any(
            part in BLOCKED_PARTS for part in parts
        ):
            problems.append(f"{name}: build output is tracked")
            continue
        path = ROOT / name
        if not path.is_file():
            continue
        data = path.read_bytes()
        for line_number, line in enumerate(data.splitlines(), start=1):
            match = LOCAL_PATH.search(line)
            if match:
                problems.append(
                    f"{name}:{line_number}: local machine path {match.group(0).decode('utf-8', 'replace')}"
                )
                break
    for problem in problems:
        print(f"FAIL {problem}")
    print(
        f"Release hygiene: {len(problems)} problem(s) in {len(tracked_files())} tracked files"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
