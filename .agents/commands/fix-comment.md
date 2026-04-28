---
name: fix-comment
description: Fix a single specific PR review comment/thread — understand, fix surgically, reply
usage: /fix-comment <PR-NUMBER> <COMMENT-ID>
---

# Fix Single PR Comment (`/fix-comment`)

> **Usage**: `/fix-comment 312 r1234567`
>
> Focused single-thread version of `/review`. Reads exactly one comment, understands
> the full diff context around it, fixes or replies, pushes, marks resolved.
> Does not touch any other thread.

---

## Inputs

`$ARGUMENTS` — PR number and comment ID, space-separated.
- PR number: `312`
- Comment ID: `r1234567` (the `r` prefix is optional; numeric ID also accepted)

Parse both values; abort with a clear message if either is missing.

---

## Phase 0 — UNDERSTAND (before touching any file)

> *"Don't assume. Don't hide confusion. Surface tradeoffs."* — Karpathy

1. **Fetch the comment**:
   ```bash
   gh api repos/{owner}/{repo}/pulls/comments/$COMMENT_ID
   ```
   Extract: body, file path, diff hunk (original_line, line), commit_id.

2. **Resolve the Linear ticket** — extract ticket ID from branch name, PR title, or PR body
   (e.g. `feat/eng-423-*` → `ENG-423`). If found, call `get_issue($ID)` and `list_comments($ID)`
   to understand original intent and AC. Use when replying to QUESTION threads.

3. **Read the diff context** — expand ±20 lines around the referenced line:
   ```bash
   gh api repos/{owner}/{repo}/pulls/$PR/files \
     --jq '.[] | select(.filename == "<file>") | .patch'
   ```
   Also read the current file state from disk.

3. **State exactly what the reviewer is asking** — write it out in one sentence.
   If the intent is ambiguous:
   - Post a reply asking one focused clarifying question
   - Stop — do not guess at the fix

4. **Classify the request**:
   - **BLOCKER** — correctness/security issue; must fix
   - **CHANGE** — explicit edit; clear what to do
   - **QUESTION** — asking why; answer in reply, code change only if "this is wrong"
   - **NITPICK** — optional polish; fix only if unambiguous

---

## Phase 1 — FIX

> *"Touch only what you must. Clean up only your own mess."* — Karpathy

**For BLOCKER / CHANGE**:
- Edit exactly the lines referenced by the comment — no more, no less
- No adjacent cleanup; no unasked renames; match existing style
- If fixing this line requires touching a dependency, note that explicitly before editing

**For QUESTION**:
- Draft the reply text; only edit code if the reply would be "this is wrong"

**For NITPICK**:
- Apply the polish if clear; skip if controversial (note in reply)

Run the relevant verify checks immediately after the change:

| Changed files | Command |
|---|---|
| `src/**/*.sol` | `bunx solhint <file>` + targeted `forge test` |
| `script/**/*.ts` | `bunx tsc-files --noEmit <file>` + `bunx eslint <file>` |
| Formatting | `bun format:fix` |

Do not proceed to Phase 2 if any check fails.

---

## Phase 2 — REPLY

1. **Commit**:
   ```bash
   git commit -m "fix: address comment $COMMENT_ID on PR #$PR"
   ```

2. **Push**:
   ```bash
   git push
   ```

3. **Reply to the thread**:
   ```bash
   gh api repos/{owner}/{repo}/pulls/$PR/comments/$COMMENT_ID/replies \
     -f body="<reply>"
   ```
   Reply format:
   - **Fixed**: "Fixed in `<short-sha>`. <one line: what changed and why>."
   - **Question answered**: "<explanation>. Let me know if you'd like more context."
   - **Nitpick fixed**: "Done."
   - **Skipped**: "Left as-is — <one-sentence reason>. Happy to revisit if you feel strongly."

---

## Abort Conditions

- Comment ID not found → report the exact API error; do not guess another ID
- Intent is ambiguous → post a clarifying question; stop
- Comment references a specific on-chain tx hash → run `/analyze-tx <network> <hash>` first;
  use the trace as source of truth before attempting any fix
- Fix requires Diamond storage layout change → stop, flag to user
- Tests fail after 1 fix attempt → report exact failure; stop
