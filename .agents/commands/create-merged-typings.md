---
name: create-merged-typings
description: Produces a single beta typings package that combines several in-flight PRs, so backend/QA can test a flow that needs changes from more than one open feature branch at once. Builds a disposable "DO NOT MERGE" branch that merges the selected PRs on top of main, opens a labeled PR to fire the Types Bindings workflow, captures the exact published beta tag, and returns the version backend pins. Use when someone says "create a merged typings package", "combine PRs X and Y into a types package", "I need beta types with both <topic A> and <topic B>", "typings for backend that has facet A and facet B", or invokes /create-merged-typings.
usage: /create-merged-typings [PR numbers | topic keywords]
---

# Create Merged Typings Package

> **Usage**: `/create-merged-typings [PR numbers | topic keywords]`

## Why this exists

Each feature branch publishes a `-beta` typings tag generated from **that branch alone**
(`types.yaml` → `lifinance/lifi-contract-types`). The `-beta` version is a single global
counter, so no published beta ever contains two in-flight branches together. When backend/QA
needs to test a flow that spans two unmerged branches, they need one package with **both**.

This command builds a throwaway branch that merges the selected PRs on top of `main`, lets the
existing Types Bindings workflow publish one combined beta tag, hands that tag back, then tears
the throwaway branch down. The tag lives in `lifi-contract-types` independently and keeps
working after the throwaway branch is gone.

## When NOT to use

- A single PR is enough → that PR already publishes its own beta on every push; just give
  backend its tag. This command is only for **combining** two or more.
- You want a permanent release → that is the `push to main` path, not a throwaway branch.

## Phase 1 — Resolve the change set

Goal: end with a confirmed list of open PRs and their head branches.

1. Fetch open PRs once (never loop `gh pr view` per PR):

   ```bash
   gh pr list --repo lifinance/contracts --state open \
     --json number,title,headRefName,isDraft,url --limit 100
   ```

2. Select from that list based on what the user gave you:
   - **PR numbers / URLs** → match directly.
   - **Topic / facet keywords** → case-insensitive match on `title` + `headRefName`; if a
     keyword matches more than one or zero PRs, show the candidates and ask which.
   - **Nothing** → print the list (number · title · branch) and ask the user to pick.

3. Echo the resolved set (number, title, head branch) and get an explicit **confirm** before
   any git operation. Warn — but let the user proceed — if a selected PR `isDraft` (its branch
   may lack the latest work) or resolves to fewer than two PRs (nothing to combine).

## Phase 2 — Build the combined branch (isolated worktree)

Do this in a **dedicated worktree** so the user's working checkout is untouched. Base strictly
on freshly-fetched `origin/main`.

```bash
git fetch origin main
SLUG="<shortA>-<shortB>"                       # e.g. layerswap-allbridge
BRANCH="dnm-typings/${SLUG}"
WT="../contracts-typings-${SLUG}"
git worktree add -b "$BRANCH" "$WT" origin/main
cd "$WT"
```

Merge each selected PR in turn via its PR ref — never `origin/<headRefName>`, which does not
exist for fork PRs and can silently point at the wrong branch when names collide:

```bash
git fetch origin "pull/<PR_NUMBER>/head"
git merge --no-edit FETCH_HEAD
```

**On merge conflict → stop, do not attempt to auto-resolve.** Run `git merge --abort`, then
report exactly which PR and which files collided (`git diff --name-only --diff-filter=U`
before aborting). **Keep the worktree** so the user can resolve manually in it if they choose,
and ask them to either drop one PR from the set and re-run, or resolve the overlap by hand.
Two branches that touch the same contract are the expected cause.

## Phase 3 — Open the labeled throwaway PR (fires Types Bindings)

Push the branch and open a **non-draft** PR against `main`. Non-draft is required — both the
auto-label workflow and `types.yaml` skip draft PRs.

```bash
git push -u origin "$BRANCH"
gh pr create --repo lifinance/contracts --base main --head "$BRANCH" \
  --title "DO NOT MERGE (typings only) — <topic A> + <topic B>" \
  --body "Disposable branch: merges #<A> and #<B> on top of main only to publish a combined beta typings package for backend/QA. **Do not merge.** Auto-deleted once the beta tag is captured. Only the **Types Bindings** check matters here — every other CI check is expected to fail on a merge branch and can be ignored."
```

Explicitly add the label (do not rely on the auto-label race) — this is what triggers
`types.yaml` via the `labeled` event:

```bash
gh pr edit --repo lifinance/contracts <PR_NUMBER> --add-label requires-types
```

The full contracts CI suite (version+audit, smoke, security) will run and mostly **fail** on a
merge branch. That is expected and irrelevant — **ignore every check except `Types Bindings`.**
Do not try to fix them.

## Phase 4 — Await the run and capture the exact tag

The `-beta` counter is global, so "latest tag" is unreliable — a parallel branch may bump it
between our push and read. Read the version **this run** produced from its own log.

1. Find this branch's Types Bindings run and wait for it. The `labeled` event can lag the
   label call, so retry with a bound before watching — and never call `gh run watch` with an
   empty (or literal `null`) run id:

   ```bash
   RUN_ID=""
   for _ in {1..12}; do
     RUN_ID=$(gh run list --repo lifinance/contracts --workflow "Types Bindings" \
       --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
     [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] && break
     sleep 5
   done
   [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] \
     || { echo "No Types Bindings run appeared for $BRANCH — check the label and workflow"; exit 1; }
   gh run watch --repo lifinance/contracts "$RUN_ID" --exit-status
   ```

   `--exit-status` makes the watch exit nonzero when the run fails — treat that as the
   run-failed case below (keep the branch/PR, skip Phase 5). Do the waiting with the Monitor
   tool or a background wait, never a model-turn polling loop.

2. Parse the version the run published (the `Update Version` step logs `New version: X.Y.Z-beta`)
   and fail hard if the line is missing — an empty version must never flow into Phase 5:

   ```bash
   VERSION=$(gh run view --repo lifinance/contracts "$RUN_ID" --log \
     | grep -m1 -oE 'New version: [0-9]+\.[0-9]+\.[0-9]+-beta' | awk '{print $NF}')
   [[ -n "$VERSION" ]] || { echo "No 'New version:' line in run $RUN_ID — inspect its log"; exit 1; }
   TAG="v${VERSION}"
   ```

3. Confirm the tag is actually present before returning it (exact-ref lookup — the `/tags`
   list endpoint is paginated and its ordering is not guaranteed; this exits nonzero on 404):

   ```bash
   gh api "repos/lifinance/lifi-contract-types/git/ref/tags/${TAG}" --jq '.ref'
   ```

If the run **failed** (`gh run watch --exit-status` exits nonzero — not the merge-branch CI
noise; the Types Bindings run itself), stop:
report the run URL and the failing step, and **keep** the branch/PR so it can be re-run or
debugged. Skip Phase 5.

## Phase 5 — Return the package, then clean up

Return to the user:

- the published tag, e.g. `v10.21.8-beta`;
- the backend pin line for `package.json`:

  ```json
  "lifi-contract-typings": "lifinance/lifi-contract-types#v10.21.8-beta"
  ```

  > **Before returning the pin, verify the spec against a real backend `package.json`** —
  > `lifi-contract-types` is consumed as a git tag, not from public npm, so the dependency name
  > and spec shape must match what backend already uses. Do not hand over an unverified spec.

Then tear the throwaway down (the tag is a ref in the other repo and is unaffected):

```bash
gh pr close --repo lifinance/contracts <PR_NUMBER>
cd -                                   # leave the worktree dir
git worktree remove --force "$WT"
git branch -D "$BRANCH" 2>/dev/null || true
git push origin --delete "$BRANCH"
```

(No `gh pr close --delete-branch` — it also tries to delete the *local* branch, which is
still checked out in the worktree at that point and fails noisily; delete the remote ref
explicitly after the worktree is gone.)

## Notes

- **Re-running later** (branch A or B got new commits): just run the command again — it
  recreates the throwaway branch from scratch and publishes a fresh beta.
- **More than two PRs**: supported — merge them all in Phase 2 in the order given.
- **Beta stream is topic-blind**: consecutive `-beta` tags belong to unrelated branches. Always
  hand backend the specific tag this command returns, never "the latest beta".
