---
name: finish-rollout
description: Finishes a production multisig rollout after its timelock ops have executed — verifies execution (MongoDB timelock queue + on-chain isOperationDone), closes the #dev-sc-multisig-proposals Slack thread ("Executed" reply + rocket reaction), syncs the diamond logs for the impacted chains onto the rollout PR, and takes that PR through /pr-ready → ready-for-review → /post-pr-for-review. Use when the user says "finish the rollout", "the timelock executed, wrap it up", "close out the deployment", or supplies a #dev-sc-multisig-proposals thread link with finishing intent. This is the tail of `multisig-rollout` (which ends at "timelock ops execute via the scheduled pipeline"); it never executes or cancels timelock ops itself — for that, the cron workflow (or `execute-pending-timelock-tx.ts`) is the owner. Requires gh and the Slack MCP server. No VPN needed.
usage: /finish-rollout <slack thread link>
---

# Finish Rollout (LI.FI Contracts)

Input: a `#dev-sc-multisig-proposals` thread link, e.g.
`https://lifi-protocol.slack.com/archives/C09DKGYQ1GC/p1783082088092039`.
Channel id is the `C…` path segment; the parent message `ts` comes from the `p<digits>` segment
by inserting a `.` before the last 6 digits (`p1783082088092039` → `1783082088.092039`).

## Hard rails

- **Strict finisher.** Never execute, cancel, or reschedule timelock ops. If something isn't
  executed yet, report where it's stuck and stop — execution belongs to the scheduled
  cron workflow.
- **Nothing outward-facing before the gate passes.** No Slack reply, no reaction, no PR
  mutation until Phase 2 verifies every op of THIS rollout as executed (all-or-nothing).
- **Op-level scope.** The gate covers only ops correlated to this rollout. Unrelated
  queued/unexecuted ops on the same networks are never stoppers (mention as FYI at most).
- **No VPN.** Verification uses the non-gated `MONGODB_URI` timelock queue plus public RPCs.
  Do not call `list-pending-proposals.ts` (VPN-gated `SC_MONGODB_URI`) as part of this skill.
- The thread must live in `#dev-sc-multisig-proposals` (`C09DKGYQ1GC`). Anything else: stop
  and ask.

## Phase 0 — Preflight

- Slack MCP connected (read thread, send reply, add reaction). If missing, stop — the Slack
  closure is half the job.
- `gh auth status` OK (deploy mode edits the rollout PR).
- `MONGODB_URI` present in `.env` (the verification script exits `2` if not).

## Phase 1 — Parse the thread

Read the thread. Extract:

- **Mode** from the top-level message: `<N>x <Contract> v<version> deployment` → deploy mode;
  `<N>x whitelist sync — …` → whitelist mode. Neither → stop and ask.
- **Networks** from the reply's `Safe proposals live on:` bullets (ignore trailing
  `(nonce N)` annotations).
- **PR URL** from the reply (`PR with deployed addresses:` / `Whitelist PR:`).
- **Parent `ts`** for the reaction, thread `ts` for the reply.

## Phase 2 — Verification gate (all-or-nothing, op-level)

Correlate queue rows to this rollout by **deployed address in the scheduled payload**:

1. Per network, get the rollout's contract address:
   - deploy mode: the PR's `| Chain | Contract address | … |` table, or the
     `deployments/<net>.json` diff in the PR.
   - whitelist mode: the added/removed addresses from the whitelist PR's
     `config/whitelist.json` diff.
2. Run:

   ```bash
   bunx tsx script/deploy/safe/list-timelock-queue.ts \
     --network <csv> --payloadContains <address csv> --checkOnChain --json
   ```

   Exit codes: `0` ok, `1` real error (stop, report), `2` `MONGODB_URI` missing/unreachable
   (tell the user, stop).
3. **Gate**: every target network has ≥1 correlated row, and every correlated row is
   `status: "executed"` with `onChainDone: true`. A diamond-called periphery rollout expects
   **two** rows per network (registration + whitelist).
4. On failure, print a per-network stuck-state table and STOP:
   - no correlated row → the Safe tx was never executed on-chain (queue rows are written by
     `confirm-safe-tx.ts` when it mines) → still gathering signatures;
   - row `queued`, `onChainDone: false` → timelock delay still running, or ready and waiting
     for the cron run;
   - row `cancelled`/`failed` → surface `failureReason` and ask the user how to proceed.

## Phase 3 — Slack closure

Reply in the thread with exactly `Executed`, then add the `rocket` reaction to the parent
message. Both via the Slack MCP tools; if unavailable, hand the user the exact reply text and
emoji to post manually — do not use webhooks.

## Phase 4 — Diamond log sync (deploy mode only)

The production `deployments/<net>.diamond.json` registry only updates when the cut executes —
that's now. Regenerate it from on-chain state:

```bash
gh pr checkout <N>
source script/helperFunctions.sh
updateDiamondLogs "production" "<network>"   # once per impacted network
```

The diff MUST show the new contract/version in each impacted `<net>.diamond.json` — this is a
second, independent execution proof. If it doesn't, that contradicts Phase 2: stop, flag,
investigate; commit nothing. Otherwise commit the diamond-log diff to the PR branch and push.

## Phase 5 — PR finish (deploy mode only)

1. `/pr-ready` (mandatory local review gate — resolve findings first).
2. `gh pr ready <N>` (draft → ready for review).
3. `/post-pr-for-review` (posts to `#dev-sc-review`, tags the team, enables auto-merge).

Whitelist mode skips Phases 4–5: its PR was merged before the rollout started.

## Phase 6 — Report

Networks with their `executionTxHash`es, Slack reply + reaction confirmation, PR state
(commit pushed, ready, posted for review), and any FYI (e.g. unrelated ops still queued on the
same networks).

## Failure modes

- `list-timelock-queue.ts` exit `2` → `MONGODB_URI` missing or cluster unreachable — relay,
  stop.
- Thread doesn't parse (format drift, missing PR link) → show what was extracted, ask.
- PR already merged/closed in deploy mode → nothing to finish there; report and continue with
  the Slack closure only if the gate passed.
- Diamond log diff missing the expected version → contradiction with the queue; stop and
  investigate (wrong address correlated, or the cut executed a different payload).
