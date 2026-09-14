#!/usr/bin/env python3
"""Substitute ${VAR} placeholders in a Kubernetes manifest from the environment.

Usage:  python3 build/render-manifest.py k8s/app.yaml [more.yaml ...]

Writes the rendered manifest(s) to stdout, so the caller pipes straight into
`kubectl apply -f -`.

WHY THIS EXISTS RATHER THAN `sed` OR `envsubst`.

The point is the FAILURE, not the substitution. If a placeholder has no value in the
environment, this exits non-zero and names the offending variable. `envsubst` silently
substitutes the empty string and `sed` silently leaves the literal text in place — and
either produces a manifest that applies cleanly and creates a broken workload. A pod
with DB_WRITE_HOST="" starts, passes a health probe that makes no database call, gets
registered behind the load balancer and returns 500 on every real request. Every layer
reports success.

That is the same defect shape this repo keeps hitting from the other direction: a field
something reads but nothing supplies. Here the manifest is the reader, the deploy task is
the supplier, and this script is the only thing that checks they agree.

`sed` was also the wrong tool for a second reason: the deploy step runs inside
`bash -c '...'`, whose payload must contain no single quotes, and quoting a sed program
safely under that constraint is exactly the kind of fragility that broke a real deploy
with `unexpected EOF`.

Only ${UPPER_SNAKE} is treated as a placeholder. Anything else — $VAR, $(cmd), a bare $
— is passed through untouched, so YAML that legitimately contains a dollar sign is safe.
"""

from __future__ import annotations

import os
import re
import sys

PLACEHOLDER = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")


def render(path: str) -> tuple[str, set[str]]:
    """Return the rendered text and the set of variables that had no value."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    missing: set[str] = set()

    def replace(match: re.Match) -> str:
        name = match.group(1)
        value = os.environ.get(name)
        # An explicitly EMPTY value is treated as missing too. Every placeholder in these
        # manifests is a hostname, ARN, region or image URI — none has a meaningful empty
        # value, and an empty one is overwhelmingly likely to be an unset upstream output
        # rather than an intent.
        if not value:
            missing.add(name)
            return match.group(0)
        return value

    return PLACEHOLDER.sub(replace, text), missing


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(f"usage: {argv[0]} <manifest.yaml> [...]", file=sys.stderr)
        return 2

    rendered: list[str] = []
    problems: dict[str, set[str]] = {}

    for path in argv[1:]:
        if not os.path.isfile(path):
            print(f"ERROR: manifest not found: {path}", file=sys.stderr)
            return 1
        text, missing = render(path)
        if missing:
            problems[path] = missing
        rendered.append(text)

    if problems:
        print(
            "ERROR: unresolved placeholders — refusing to emit a manifest that would "
            "create a broken workload:",
            file=sys.stderr,
        )
        for path, names in sorted(problems.items()):
            for name in sorted(names):
                print(f"  {path}: ${{{name}}} is unset or empty", file=sys.stderr)
        print(
            "\nEach of these is supplied by the deploy task from a stack output "
            "(dist/<stack>.env). An unset one usually means the upstream stack did not "
            "emit that CfnOutput, or its dotenv was not sourced by this step.",
            file=sys.stderr,
        )
        return 1

    # `---` between documents so multiple files concatenate into one valid stream.
    sys.stdout.write("\n---\n".join(doc.rstrip("\n") for doc in rendered) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
