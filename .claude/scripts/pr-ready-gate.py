#!/usr/bin/env python3
"""PreToolUse hook gating PR-creation / PR-update commands on a clean /pr-ready run.

Reads the Claude Code PreToolUse JSON payload from stdin and either:
- exits 0 (allow) — for unrelated commands or when the gate is satisfied, or
- prints a deny JSON decision on stdout and exits 0 — for gated commands when
  the gate is not yet satisfied (this surfaces a tool error to the model with
  the reason string, so Claude routes into the /pr-ready skill).

Gate is satisfied when ANY of:
  1. The command contains `PR_READY_OK=1` (env-var bypass / explicit override).
  2. A marker file at `<gitdir>/PR_READY_OK` exists and its mtime is newer than
     the HEAD commit's timestamp on the current branch.

Match scope (case-insensitive, after collapsing whitespace):
  - `gh pr create` (any flags, including `--draft`)
  - `gh pr ready`  (draft → Ready for Review)
  - `git push` — only when the current branch has an OPEN, NON-DRAFT PR.
    Pushes on branches without a PR, or to draft PRs, are allowed through so
    that WIP iteration stays friction-free. The check is gated on a fast
    `gh pr view` lookup; if `gh` is unavailable, unauthenticated, or there's
    no PR for the branch, the push is allowed.

Everything else (including `gh pr list`, `gh pr view`, `gh issue …`, plain
`gh auth`, etc.) is allowed through.

Errors are non-fatal: any internal exception falls back to allow, so a broken
gate never blocks legitimate work. The model can still be redirected by the
soft CLAUDE.md rule in that case.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


SKILL_NAME = "/pr-ready"

# Matches `gh pr create` or `gh pr ready` as a command, tolerating extra spaces
# and leading env-var assignments / `sudo` / `bun x` / similar prefixes that
# don't change the fact that `gh pr create|ready` is what runs.
_PR_CMD_RE = re.compile(
    r"(?:^|[;&|`$(\s])gh\s+pr\s+(create|ready)\b",
    re.IGNORECASE,
)

_BYPASS_PREFIX_RE = re.compile(
    r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*"
    r"PR_READY_OK=1(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+"
    r"(?:gh\s+pr\s+(?:create|ready)|git\s+push)\b",
    re.IGNORECASE,
)

# Matches `git push` (any args). We only enforce when the branch has an open
# non-draft PR — see `_push_targets_ready_pr`.
_GIT_PUSH_RE = re.compile(
    r"(?:^|[;&|`$(\s])git\s+push\b",
    re.IGNORECASE,
)


def _read_payload() -> dict:
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def _deny(reason: str) -> None:
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
    sys.exit(0)


def _allow() -> None:
    sys.exit(0)


def _git(args: list[str], cwd: str | None = None) -> str | None:
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=3,
        )
        if r.returncode != 0:
            return None
        return r.stdout.strip()
    except Exception:
        return None


def _push_targets_ready_pr(cwd: str | None) -> bool:
    """Best-effort check: does the current branch have an OPEN, non-draft PR?

    Returns False if `gh` is missing, unauthenticated, the branch has no PR,
    or any error occurs — i.e. fail open (allow the push).
    """
    try:
        r = subprocess.run(
            ["gh", "pr", "view", "--json", "isDraft,state"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=4,
        )
        if r.returncode != 0:
            return False
        data = json.loads(r.stdout or "{}")
        return data.get("state") == "OPEN" and data.get("isDraft") is False
    except Exception:
        return False


def _gate_satisfied(cwd: str | None) -> tuple[bool, str]:
    """Return (satisfied, human-readable reason if not)."""
    gitdir = _git(["rev-parse", "--git-dir"], cwd=cwd)
    if not gitdir:
        # Not a git repo — let `gh pr create` fail on its own; don't block.
        return True, ""
    gitdir_path = Path(gitdir)
    if not gitdir_path.is_absolute() and cwd:
        gitdir_path = Path(cwd) / gitdir_path
    marker = gitdir_path / "PR_READY_OK"
    if not marker.exists():
        return False, "no marker file"
    try:
        marker_mtime = marker.stat().st_mtime
    except OSError:
        return False, "marker stat failed"

    head_ts_raw = _git(["log", "-1", "--format=%ct", "HEAD"], cwd=cwd)
    try:
        head_ts = float(head_ts_raw) if head_ts_raw else 0.0
    except ValueError:
        head_ts = 0.0

    if marker_mtime <= head_ts:
        return False, "marker is not newer than HEAD (new commits since last /pr-ready)"
    return True, ""


def main() -> None:
    payload = _read_payload()
    tool_name = payload.get("tool_name") or payload.get("tool") or ""
    tool_input = payload.get("tool_input") or {}
    if tool_name != "Bash":
        _allow()

    command = tool_input.get("command") or ""
    if not isinstance(command, str) or not command.strip():
        _allow()

    m_pr = _PR_CMD_RE.search(command)
    m_push = _GIT_PUSH_RE.search(command) if not m_pr else None
    if not m_pr and not m_push:
        _allow()

    # Bypass: explicit PR_READY_OK=1 as command-prefix env assignment
    if _BYPASS_PREFIX_RE.match(command):
        _allow()

    cwd = payload.get("cwd") or os.getcwd()

    # For `git push`, only enforce when the current branch has an open,
    # non-draft PR. Pushing on branches without a PR (or on draft PRs) is
    # the WIP path and must stay frictionless.
    if m_push and not _push_targets_ready_pr(cwd):
        _allow()

    satisfied, why = _gate_satisfied(cwd)
    if satisfied:
        _allow()

    if m_pr:
        subcmd = m_pr.group(1).lower()
        blocked = f"gh pr {subcmd}"
        action = (
            "create a PR" if subcmd == "create"
            else "flip a draft PR to Ready for Review"
        )
    else:
        blocked = "git push"
        action = "push new commits to this Ready-for-Review PR"
    reason = (
        f"Blocked: `{blocked}` requires a clean {SKILL_NAME} run first ({why}).\n"
        f"\n"
        f"Before you {action}, run the {SKILL_NAME} skill on this branch:\n"
        f"  1. It runs `coderabbit review --base origin/<base> --plain` locally.\n"
        f"  2. Triages findings into Auto-apply / Ask / Reject.\n"
        f"  3. Re-runs until clean, then writes the gate marker.\n"
        f"\n"
        f"Once {SKILL_NAME} reports CLEAN (or only documented-deferred items remain) and the\n"
        f"marker file `$(git rev-parse --git-dir)/PR_READY_OK` is newer than HEAD, retry this\n"
        f"command. For legitimate emergency bypass (e.g. sensitive security fix), prepend\n"
        f"`PR_READY_OK=1` to the command and document the reason in the PR description."
    )
    _deny(reason)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Fail open: never block on internal error.
        _allow()
