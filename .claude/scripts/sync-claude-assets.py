#!/usr/bin/env python3
"""
sync-claude-assets.py — mirror local Claude assets (skills, agents, commands,
hooks, scripts, exec plans, etc.) to their declared remote repos.

Reads ~/.claude/sync-registry.json. Each asset has:
  - local_path: path under ~/.claude/ (file or directory)
  - mirrors: list of {repo, remote_path, branch, pr?}
  - private_paths (optional, for directory assets): globs to exclude

Behavior:
  - For each asset, for each mirror: ensure a dedicated worktree of the repo
    pinned to a shared sync working directory, check out the declared branch
    (or create a new dated branch from main), copy the asset (excluding
    private_paths), commit, push, open draft PR if none exists, write the
    new PR number back into the registry.
  - Fast-path no-op when nothing changed.
  - Designed as a Stop hook. Never blocks Claude (always exits 0).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import date
from fnmatch import fnmatch
from pathlib import Path
from typing import List, Optional, Tuple

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
REGISTRY = CLAUDE_DIR / "sync-registry.json"
GITHUB_DIR = HOME / "Documents" / "GitHub"
STAMP_FILE = CLAUDE_DIR / ".asset-sync-last"
LOG_FILE = CLAUDE_DIR / "asset-sync.log"

# Files that live next to an asset for coordination but should never be pushed
NEVER_PUSH_BASENAMES = {"SYNC.md", "sync.json"}


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def run(cmd, cwd=None, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)
    if check and r.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nstdout: {r.stdout}\nstderr: {r.stderr}"
        )
    return r


def load_registry() -> dict:
    if not REGISTRY.exists():
        return {"assets": []}
    return json.loads(REGISTRY.read_text())


def save_registry(reg: dict) -> None:
    REGISTRY.write_text(json.dumps(reg, indent=2) + "\n")


def any_asset_changed_since(stamp_ts: float, assets: list) -> bool:
    for a in assets:
        src = CLAUDE_DIR / a["local_path"]
        if not src.exists():
            continue
        if src.is_file():
            if src.stat().st_mtime > stamp_ts:
                return True
        else:
            for f in src.rglob("*"):
                if f.is_file() and f.stat().st_mtime > stamp_ts:
                    return True
    return False


def ensure_worktree(repo: str) -> Path:
    repo_name = repo.split("/")[-1]
    main_clone = GITHUB_DIR / repo_name
    wt = GITHUB_DIR / f"{repo_name}-wt-claude-sync"
    if not main_clone.exists():
        raise RuntimeError(
            f"main clone of {repo} not found at {main_clone}; clone it first"
        )
    if not wt.exists():
        log(f"creating worktree {wt}")
        run(["git", "-C", str(main_clone), "fetch", "origin", "main"])
        run(["git", "-C", str(main_clone), "worktree", "add", str(wt), "origin/main"])
    return wt


def checkout_branch(wt: Path, branch: str, base: str = "main") -> str:
    run(["git", "-C", str(wt), "fetch", "origin", "--prune"], check=False)
    run(["git", "-C", str(wt), "reset", "--hard"], check=False)
    run(["git", "-C", str(wt), "clean", "-fd"], check=False)
    ls = run(
        ["git", "-C", str(wt), "ls-remote", "--heads", "origin", branch], check=False
    )
    if ls.stdout.strip():
        run(["git", "-C", str(wt), "checkout", "-B", branch, f"origin/{branch}"])
    else:
        run(["git", "-C", str(wt), "checkout", "-B", branch, f"origin/{base}"])
    return branch


def is_private(rel_path: str, private_globs: List[str]) -> bool:
    return any(fnmatch(rel_path, pg) for pg in private_globs)


def copy_asset(
    src: Path, target: Path, private_globs: List[str]
) -> Tuple[List[str], List[str]]:
    """Copy src (file or directory) into target. Returns (copied, redacted)."""
    copied, redacted = [], []
    if src.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        copied.append(src.name)
        return copied, redacted

    target.mkdir(parents=True, exist_ok=True)
    for f in src.rglob("*"):
        if f.is_dir():
            continue
        rel = f.relative_to(src).as_posix()
        if f.name in NEVER_PUSH_BASENAMES:
            continue
        if is_private(rel, private_globs):
            redacted.append(rel)
            continue
        dst = target / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dst)
        copied.append(rel)
    return copied, redacted


def has_diff(wt: Path, path: str) -> bool:
    r = run(["git", "-C", str(wt), "status", "--porcelain", "--", path], check=False)
    return bool(r.stdout.strip())


def commit_and_push(wt: Path, path: str, branch: str, asset_name: str) -> None:
    run(["git", "-C", str(wt), "add", "--", path])
    msg = f"chore(claude): sync {asset_name} from local"
    run(
        [
            "git",
            "-C",
            str(wt),
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            msg,
        ]
    )
    run(["git", "-C", str(wt), "push", "-u", "origin", branch])


def get_open_pr(repo: str, branch: str) -> Optional[int]:
    r = run(
        [
            "gh",
            "pr",
            "list",
            "--repo",
            repo,
            "--head",
            branch,
            "--state",
            "open",
            "--json",
            "number",
        ],
        check=False,
    )
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout or "[]")
        return data[0]["number"] if data else None
    except (json.JSONDecodeError, IndexError, KeyError):
        return None


def create_draft_pr(repo: str, branch: str, asset_name: str) -> Optional[int]:
    title = f"chore(claude): sync {asset_name} from local"
    body = (
        f"Automated sync of `{asset_name}` from local `~/.claude/` "
        "by sync-claude-assets.py.\n\nDraft — review before marking ready."
    )
    r = run(
        [
            "gh",
            "pr",
            "create",
            "--draft",
            "--repo",
            repo,
            "--head",
            branch,
            "--title",
            title,
            "--body",
            body,
        ],
        check=False,
    )
    if r.returncode != 0:
        log(f"  ✗ gh pr create failed: {r.stderr.strip()}")
        return None
    url = r.stdout.strip().splitlines()[-1]
    try:
        return int(url.rsplit("/", 1)[-1])
    except ValueError:
        return None


def sync_asset(asset: dict, asset_idx: int, registry: dict) -> List[str]:
    name = asset["name"]
    src = CLAUDE_DIR / asset["local_path"]
    if not src.exists():
        return [f"⚠️  {name}: local_path {src} missing"]

    private = asset.get("private_paths", [])
    lines = []
    registry_dirty = False

    for m_idx, mirror in enumerate(asset["mirrors"]):
        repo = mirror["repo"]
        remote_path = mirror["remote_path"]
        branch = mirror.get("branch", "main")
        pr = mirror.get("pr")

        if branch == "main":
            branch = f"chore/sync-{name}-{date.today().isoformat()}"

        try:
            wt = ensure_worktree(repo)
            actual_branch = checkout_branch(wt, branch)
            target = wt / remote_path
            copied, redacted = copy_asset(src, target, private)

            if not has_diff(wt, remote_path):
                lines.append(
                    f"✓ {name} → {repo}"
                    + (f"#{pr}" if pr else f" ({actual_branch})")
                    + " (no changes)"
                )
                continue

            commit_and_push(wt, remote_path, actual_branch, name)

            if not pr:
                existing = get_open_pr(repo, actual_branch)
                pr = existing or create_draft_pr(repo, actual_branch, name)
                if pr:
                    registry["assets"][asset_idx]["mirrors"][m_idx]["pr"] = pr
                    registry_dirty = True

            lines.append(
                f"✅ {name} → {repo}#{pr or '?'} "
                f"(synced {len(copied)} files"
                + (f", {len(redacted)} redacted" if redacted else "")
                + ")"
            )
        except Exception as e:
            lines.append(f"⚠️  {name} → {repo}: {e}")
            log(f"  error: {e}")

    if registry_dirty:
        save_registry(registry)

    return lines


def main() -> int:
    if not REGISTRY.exists():
        return 0

    registry = load_registry()
    assets = registry.get("assets", [])
    if not assets:
        return 0

    if STAMP_FILE.exists() and not any_asset_changed_since(
        STAMP_FILE.stat().st_mtime, assets
    ):
        return 0

    targets = sys.argv[1:]
    all_lines = []
    for i, asset in enumerate(assets):
        if targets and asset["name"] not in targets:
            continue
        all_lines.extend(sync_asset(asset, i, registry))

    for line in all_lines:
        log(line)

    STAMP_FILE.touch()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e}")
        sys.exit(0)
