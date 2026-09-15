#!/usr/bin/env python3
"""Fail if a key/secret/token file or an API-key-looking string is about to enter the repo.

    python3 scripts/check_secrets.py --staged   # pre-commit hook (.githooks/pre-commit)
    python3 scripts/check_secrets.py --all      # CI: every tracked file

Rules:
  - file names ending in _KEY, _SECRET or _TOKEN (any case, with or without an extension)
  - content matching common credential formats (private keys, GitHub/AWS/Google/Slack/Stripe/
    OpenAI/Anthropic tokens) or a KEY/SECRET/TOKEN-named variable assigned a literal value
A line containing `secret-scan: allow` is exempt. Matches are reported by file and line only;
the matched text is never printed.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

NAME = re.compile(r"(^|/)[^/]*_(KEY|SECRET|TOKEN)(\.[^/]*)?$", re.IGNORECASE)
PATTERNS = {
    "private key block": re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
    "AWS access key id": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[0-9A-Za-z\-]{10,}"),
    "Stripe live key": re.compile(r"\b[sr]k_live_[0-9A-Za-z]{20,}"),
    "OpenAI/Anthropic key": re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{32,}"),
    "credential assignment": re.compile(
        r"""(?ix)
        \b[a-z0-9_]*(?:api[_-]?key|secret|token|password|_key)\b ["']?
        \s*[:=]\s*
        ["']?(?![$<{])[A-Za-z0-9+/_\-]{16,}["']?\s*$
        """
    ),
}
ALLOW = "secret-scan: allow"
BINARY_SUFFIXES = (".gz", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pdf", ".gpkg")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def files(staged: bool) -> list[str]:
    if staged:
        return [f for f in git("diff", "--cached", "--name-only", "--diff-filter=ACMR").splitlines() if f]
    return [f for f in git("ls-files").splitlines() if f]


def content(path: str, staged: bool) -> str | None:
    if path.endswith(BINARY_SUFFIXES):
        return None
    try:
        if staged:
            raw = subprocess.run(["git", "show", f":{path}"], check=True, capture_output=True).stdout
        else:
            with open(path, "rb") as fh:
                raw = fh.read()
    except (OSError, subprocess.CalledProcessError):
        return None
    if b"\0" in raw[:8000]:
        return None
    return raw.decode("utf-8", errors="replace")


def scan(path: str, text: str | None) -> list[str]:
    problems = []
    if NAME.search(path):
        problems.append(f"{path}: file name looks like a key/secret/token file")
    if text is None:
        return problems
    for number, line in enumerate(text.splitlines(), start=1):
        if ALLOW in line:
            continue
        for label, pattern in PATTERNS.items():
            if pattern.search(line):
                problems.append(f"{path}:{number}: {label}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--all", action="store_true")
    args = parser.parse_args(argv)
    problems = [p for f in files(args.staged) for p in scan(f, content(f, args.staged))]
    for problem in problems:
        print(f"✗ {problem}", file=sys.stderr)
    if problems:
        print(f"secret scan: {len(problems)} problem(s). Remove the secret, or mark a false positive "
              f"with '{ALLOW}'.", file=sys.stderr)
        return 1
    print("secret scan: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
