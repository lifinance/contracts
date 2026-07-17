---
name: multisig-rollout
description: Orchestrates a PRODUCTION multisig rollout end-to-end — drives a facet/periphery deployment (by delegating to the `deploy-contract` skill) or a whitelist sync across many chains, then captures the Safe proposals, drafts a PR with the deployed addresses, hands hardware-wallet signing to the user, verifies signatures in MongoDB, and posts the #dev-sc-multisig-proposals Slack thread. Use whenever the user wants Safe multisig proposals produced and shepherded to signing: "roll out <Facet> vX.Y.Z to all chains", "upgrade <Contract> in production", "re-deploy <Contract> to every chain where it is running", "create the diamond cut proposals", or "sync the whitelist for PR <N> and propose". For a staging/test deploy with no proposal lifecycle, use `deploy-contract` directly instead. Requires VPN (MongoDB), gh, and the Slack MCP server.
usage: /multisig-rollout <ContractName> | /multisig-rollout --whitelist-pr <PR number or URL>
---

# Multisig Rollout (LI.FI Contracts)

Drives the production rollout lifecycle in two modes:

- **deploy mode** — get a facet/periphery contract (version currently in the repo) on-chain across production networks and proposed to each Safe. The deploy itself (preflight, target resolution, the deploy, diamond-called-periphery allowlist sync, explorer verification) is delegated to the **`deploy-contract`** skill; this skill owns the proposal lifecycle around it.
- **whitelist mode** — given a merged whitelist PR, sync `config/whitelist.json` onto the affected chains' diamonds, proposing the changes to each chain's Safe.

Both modes converge on the same tail: capture proposals → (deploy mode only) draft PR with addresses → hand off hardware-wallet signing → verify signatures in MongoDB → post the `#dev-sc-multisig-proposals` Slack thread.

**Signing model** (Safe threshold is 3): a freshly created proposal already carries one signature. The user running this skill adds a second via `confirm-safe-tx.ts`. The Slack thread then recruits the remaining signer(s) to reach the threshold, the last of whom executes. So the verification gate before posting is "the runner has signed" — `signatureCount >= 2` — deliberately short of the threshold; recruiting the rest is the whole point of the Slack ask.

See also: the wallet-rotation orchestrators `rotate-deployer-wallet` and `offboard-sc-dev` drive this skill to propose Safe owner / CANCELLER-role swaps.

## Hard rails

- **Never run `confirm-safe-tx.ts` yourself.** Signing uses the user's hardware wallet; only the human can do it. Your job ends at giving the exact command.
- **Never post to Slack before the signature verification gate passes.** The Slack message asks the team to spend their time signing — it must be accurate.
- **Production double opt-in**: the entry scripts (`deployContractToNetworks.sh` via `deploy-contract`, and `syncWhitelistToNetworks.sh`) require `--production` on the CLI *and* `PRODUCTION=true` in `.env`. Do not edit `.env` to satisfy this — if it mismatches, stop and tell the user.
- `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` must NOT be `true` (it would bypass the Safe). Abort if set.
- Confirm the resolved plan (contract/version/networks or PR/networks) with the user before executing — deployments cost gas and mint Safe proposals on many chains.

## Phase 0 — Preflight

Run from the repo root. Check and report (don't fix silently) the lifecycle prerequisites:

- `.env` exists, `PRODUCTION=true`, `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` not `true`, `MAX_CONCURRENT_JOBS` set.
- `gh auth status` OK; Slack MCP connected (needed in Phase 8 — warn early if missing, posting falls to the user).
- Working tree clean enough to branch later (deploy mode creates a PR from deployment-log changes).
- VPN: verified implicitly later — `list-pending-proposals.ts` exits `2` with a clear message when the VPN is down; relay that to the user when it happens.

In deploy mode, `deploy-contract` re-checks the deploy-side prerequisites (Foundry, deployer balances, the `.env`/`--production` agreement) before touching any network — don't duplicate that here.

## Phase 1 — Resolve targets

**Do not invoke `deploy-contract` yet.** Phase 1 is target-resolution only; the deploy runs in Phase 2 after the user confirms the plan.

### deploy mode

If the user named explicit chains, use those. Otherwise discover every chain where the contract is already live:

```bash
for F in deployments/*.diamond.json; do
  NET=$(basename "$F" .diamond.json)
  V=$(jq -r --arg N "<Contract>" '(.LiFiDiamond.Facets // {}) | to_entries[] | select(.value.Name == $N) | .value.Version' "$F" 2>/dev/null | head -1)
  [ -n "$V" ] && echo "$NET $V"
done
```

Repo version: `grep -m1 "@custom:version" src/Facets/<Contract>.sol` (or `src/Periphery/...`). Report old → new per network. Check if the contract is diamond-called (needs a second allowlist proposal per network):

```bash
jq -e --arg N "<Contract>" '.whitelistPeripheryFunctions | has($N)' config/global.json
```

### whitelist mode — resolve targets

If the user didn't supply a whitelist PR (number or URL), ask for it — don't guess from recent merges or the working tree. The PR defines exactly which whitelist change is being rolled out and is the link the Slack post references.

The input PR must be **merged to main** (whitelist changes are main-only by policy; the sync reads the local file). If it's open, stop and point the user at the merge first. Then, on up-to-date main, derive affected networks from the PR's whitelist diff (verified recipe):

```bash
MERGE=$(gh pr view <N> --repo lifinance/contracts --json mergeCommit --jq '.mergeCommit.oid')
PROG='[ (.DEXS[]? | .contracts | to_entries[] | {k: .key, v: .value}), (.PERIPHERY | to_entries[]? | {k: .key, v: .value}) ] | group_by(.k) | map({key: .[0].k, value: (map(.v) | tojson)}) | from_entries'
git show "${MERGE}~1:config/whitelist.json" | jq -S "$PROG" > /tmp/wl-base.json
git show "${MERGE}:config/whitelist.json"  | jq -S "$PROG" > /tmp/wl-head.json
jq -rn --slurpfile A /tmp/wl-base.json --slurpfile B /tmp/wl-head.json \
  '[($A[0] + $B[0]) | keys[]] | unique | map(select($A[0][.] != $B[0][.])) | .[]'
```

The sync itself is on-chain-diff-driven, so a too-wide network list is harmless (extra networks no-op) — but keep the list tight so the run stays fast and the Slack post stays truthful.

## Phase 2 — Confirm plan, then execute

Present: mode, contract + version (or PR + summary), full network list, and what will be created (one timelock-wrapped Safe proposal per chain — **two** for a diamond-called periphery: registration + whitelist). Wait for explicit go-ahead before proceeding.

After confirmation, in deploy mode invoke `deploy-contract`:

```text
/deploy-contract <Contract> <network...> --production
```

It deploys (CREATE3), verifies on the explorer, and registers in the diamond (`diamondCut` for facets, `diamondUpdatePeriphery` for periphery), plus the allowlist sync for diamond-called periphery. It hands back a per-network table: contract, version, network, chainId, address, registration type, proposal created, verification status.

Carry forward: deployed addresses (for the PR table), succeeded/failed networks, whether the allowlist sync ran. Files changed on disk — `deployments/<net>.json`, plus `config/whitelist.json` / `config/whitelist.staging.json` when the allowlist synced — are committed in Phase 5.

Set the interaction model up front so the user knows the shape: tell them this rollout is **semi-automated** — at one point it will pause and ask them to sign the proposals with their hardware wallet, after which they come back to this chat and the skill finishes the rest (verify signatures + post Slack). Knowing the pause is coming is what stops them from completing those final steps by hand.

## Phase 3 — Execute sync (whitelist mode only)

deploy mode already executed via `deploy-contract` in Phase 2. For whitelist mode, run in the background, monitor output, report per-network results:

```bash
./script/tasks/syncWhitelistToNetworks.sh <network...> --production
```

Ends with a per-network summary and exits `1` if any network failed. Failures don't block survivors: continue with the succeeded networks, report the failed ones, and offer to retry them individually. Each proposal is created already carrying one signature (`signatureCount: 1`). A production sync automatically re-syncs staging on the same networks afterwards (staging sends directly, no proposals) — expected, not an error.

## Phase 3.5 — Deferred-cleanup drain (automatic, deploy mode)

Facet removals are **no longer proposed by hand here.** When
`DRAIN_PARKED_TASKS=true`, every production facet cut's `runPropose` call
automatically drains that network's **parked** facet-removal tasks (the deferred
diamond-cleanup queue) into **one** extra timelock `scheduleBatch` Remove per
network, riding this rollout's signing session. No `cleanUpProdDiamond --auto`
step is needed (design:
[docs/DeferredDiamondCleanupQueue.md](../../docs/DeferredDiamondCleanupQueue.md) §6).

- **Enable it for the rollout**: set `DRAIN_PARKED_TASKS=true` in the environment
  before Phase 2. Default **off** — keep it off for emergency / break-glass
  rollouts so unrelated removals never join an urgent signing set.
- **PR-link surfacing**: each drained removal proposal carries the originating
  deprecation PR(s) (`parkedTaskRefs`), shown at signing in `confirm-safe-tx`, in
  `list-pending-proposals`, and in the Phase 8 Slack post — so the signer sees
  **why** each facet is being removed.
- **Best-effort**: a drain failure never blocks the primary proposal or the exit
  code.
- **Cold networks** (never touched by a rollout) are caught by the standalone
  `reconcile-parked-tasks` job + TTL alert and the `cleanUpProdDiamond --auto
  --all-networks` backstop (spec §8) — not by this skill. That backstop still
  prints a conspicuous `⚠️ IRREVERSIBLE FACET REMOVAL` banner and dry-runs
  without `--yes`; use it only for a deliberate cold-network sweep. See
  [docs/FacetRemovalReconciliation.md](../../docs/FacetRemovalReconciliation.md).

## Phase 4 — Capture proposals

```bash
bunx tsx script/deploy/safe/list-pending-proposals.ts --network <csv> --maxAgeHours 2 --json
```

Expect one `pending` proposal per succeeded network with `signatureCount: 1` (the signature added at creation), plus **one more** when a diamond-called periphery's allowlist synced (registration + whitelist) and **one more** when the Phase 3.5 deferred-cleanup drain proposed a removal (a single per-network `scheduleBatch` Remove carrying the origin-PR links). These are additive, not mutually exclusive: a network that did a periphery allowlist sync **and** a drain removal shows **three** proposals — so expect **two or three** per network when either or both apply. Targets are the chain's `LiFiTimelockController` (proposals wrap in a timelock `scheduleBatch`). Keep `nonce` per network — the PR table needs it. Missing networks here mean the propose step failed even though the deploy succeeded — investigate before continuing; a periphery network showing only one proposal means its allowlist sync didn't land.

## Phase 5 — Draft PR (deploy mode only)

The deploy updated `deployments/<net>.json` (and staging logs if staging was deployed). If a diamond-called periphery's allowlist synced, `updateWhitelistPeriphery.ts` also rewrote `config/whitelist.json` (and `config/whitelist.staging.json`) on disk — that diff must ship in this PR too, or the repo's allowlist won't reflect the on-chain proposal. Model the PR on #1917:

Delegate the branch / commit / template / Linear ticket / push / create mechanic to `/create-pr` (as **draft**), passing:

- **files to stage**: the deployment-log changes **and** any `config/whitelist.json` / `config/whitelist.staging.json` diff from Phase 2's allowlist sync. (`git status` after the deploy shows exactly what to stage.) The whitelist diff is allowed here because this PR targets `main` (rule 502).
- **body** (the "Why"): staging bullet list (if any) + production table `| Chain | Contract address | Safe nonce |` from Phases 2 and 4, plus the note that production `<chain>.diamond.json` registries update only when the cuts execute. For a periphery rollout, note the whitelist proposal and the `whitelist.json` update too.

Don't reimplement branching/commit/PR plumbing here; `/create-pr` owns it (including the EXSC Linear-ticket requirement).

Whitelist mode changes no files — skip this phase; the input PR plays the PR role in the Slack post.

## Phase 6 — Hand off signing (then wait for the user to come back)

This is the one step the skill cannot run itself: `confirm-safe-tx.ts` is an interactive program that drives the user's Ledger over USB, so it must run in *their* terminal. Give them (VPN required; Ledger is the default signer):

```bash
bunx tsx script/deploy/safe/confirm-safe-tx.ts
```

Variants if they ask: `--network <name>` (one chain), `--ledgerLive --accountIndex <i>` (Ledger Live derivation).

Then make the hand-back contract explicit — tell the user, in these words:

> Run the command above and approve each proposal on your Ledger. **When you're done, come back to this chat and tell me "signed" (or "done").** I'll then verify the signatures and post the Slack thread for you. **Please don't post to Slack or check the signatures yourself** — those are my remaining steps (Phases 7–8); doing them by hand means I can't confirm the rollout actually completed.

Each proposal already carries one signature, so theirs makes 2 of the 3 required (the remaining signer comes from the Slack thread). Then **stop and wait** — do not proceed to Phase 7 until the user says they've signed. If they go quiet here, the rollout is **unfinished**: proposals sit at the runner's signature with no Slack ask. If the conversation resumes later with no signal either way, re-confirm by re-running Phase 7's check rather than assuming.

## Phase 7 — Verify signatures

```bash
bunx tsx script/deploy/safe/list-pending-proposals.ts --network <csv> --status all --maxAgeHours 24 --json
```

Gate, per target network: a matching proposal that is `pending` with `signatureCount >= 2` (the runner has added their signature on top of the one from creation — ready to recruit the remaining signer), or already `submitted`/`executed` (a fast signer beat the Slack post — fine, post anyway as a record). A network still at `signatureCount: 1` (or with no row) means the runner's signature didn't land — go back to Phase 6 for those. Only proceed when every network passes.

## Phase 8 — Slack thread

Channel `#dev-sc-multisig-proposals` = `C09DKGYQ1GC`. Post as two messages (format verified against the live channel):

Top-level:

```text
<N>x <Contract> v<version> deployment
```

(whitelist mode: `<N>x whitelist sync — <short PR title>`)

Thread reply (capture `ts` from the top-level; `@smartcontract_core` MUST be the subteam syntax — plain text does not notify):

```text
<!subteam^S096X6MCB0C> please sign/execute :pray:

PR with deployed addresses: <PR URL>

Safe proposals live on:
• <network 1>
• <network 2>
…
```

(whitelist mode: label the link `Whitelist PR:` instead.)

## Phase 9 — Report

Summarize: networks rolled out (+ failures and their state), proposal nonces, PR URL, Slack thread link, and what remains (team signatures/execution; timelock ops execute via the scheduled pipeline after the delay — once they have, finish with `/finish-rollout <thread link>`).

## Failure modes

- `list-pending-proposals.ts` exits `2` → VPN down or `SC_MONGODB_URI` missing — tell the user, retry after they fix it.
- Deploy succeeded but no proposal row → propose step failed; check the deploy log for the network, re-run that single network via `deploy-contract`.
- Stale/future nonce warnings during signing → `confirm-safe-tx.ts` explains them inline; relay its guidance (usually: delete + re-propose, or execute the blocking nonce first).
- Slack MCP missing → give the user both message texts verbatim to post manually; do not fall back to webhooks (wrong identity).
