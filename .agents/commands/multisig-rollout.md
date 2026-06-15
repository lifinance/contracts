---
name: multisig-rollout
description: Orchestrates a production multisig rollout end-to-end — facet/periphery re-deployment or whitelist sync across many chains, Safe proposal creation, draft PR with deployed addresses, hardware-wallet signing hand-off, signature verification in MongoDB, and the #dev-sc-multisig-proposals Slack thread. Use whenever the user asks to "re-deploy <Contract> to all chains where it is running", "roll out <Facet> vX.Y.Z", "create diamond cut proposals", "sync the whitelist for PR <N> and propose", or otherwise wants Safe multisig proposals produced and shepherded to signing. Requires VPN (MongoDB), gh, and the Slack MCP server.
usage: /multisig-rollout <ContractName> | /multisig-rollout --whitelist-pr <PR number or URL>
---

# Multisig Rollout (LI.FI Contracts)

Drives the production rollout lifecycle in two modes:

- **deploy mode** — deploy a facet/periphery contract (version currently in the repo) to a set of production chains — either the chains the user names (including a chain it isn't live on yet) or, by default, every chain where it's already live — and propose the diamond cuts to each chain's Safe.
- **whitelist mode** — given a merged whitelist PR, sync `config/whitelist.json` onto the affected chains' diamonds, proposing the changes to each chain's Safe.

Both modes converge on the same tail: capture proposals → (deploy mode only) draft PR with addresses → hand off hardware-wallet signing to the user → verify signatures in MongoDB → post the `#dev-sc-multisig-proposals` Slack thread.

**Signing model** (Safe threshold is 3): a freshly created proposal already carries one signature. The user running this skill adds a second via `confirm-safe-tx.ts`. The Slack thread then recruits the remaining signer(s) to reach the threshold, the last of whom executes. So the verification gate before posting is "the runner has signed" — `signatureCount >= 2` — deliberately short of the threshold; recruiting the rest is the whole point of the Slack ask.

## Hard rails

- **Never run `confirm-safe-tx.ts` yourself.** Signing uses the user's hardware wallet; only the human can do it. Your job ends at giving the exact command.
- **Never post to Slack before the signature verification gate passes.** The Slack message asks the team to spend their time signing — it must be accurate.
- **Production double opt-in**: both entry scripts require `--production` on the CLI *and* `PRODUCTION=true` in `.env`. Do not edit `.env` to satisfy this — if it mismatches, stop and tell the user.
- `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` must NOT be `true` (it would bypass the Safe). Abort if set.
- Confirm the resolved plan (contract/version/networks or PR/networks) with the user before executing — deployments cost gas and mint Safe proposals on many chains.

## Phase 0 — Preflight

Run from the repo root. Check and report (don't fix silently):

- `.env` exists, `PRODUCTION=true`, `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` not `true`, `MAX_CONCURRENT_JOBS` set.
- `gh auth status` OK; Slack MCP connected (needed in Phase 6 — warn early if missing, posting falls to the user).
- Working tree clean enough to branch later (deploy mode creates a PR from deployment-log changes).
- VPN: verified implicitly later — `list-pending-proposals.ts` exits `2` with a clear message when the VPN is down; relay that to the user when it happens.

## Phase 1 — Resolve targets

### deploy mode

The target list comes from one of two sources:

- **Explicit** — the user names the chains ("deploy MayanFacet to arbitrum, base, and sei"). Use exactly those, in the order given. This is how a facet reaches a **new** chain it isn't live on yet — discovery would never surface it. The only requirement is that each named chain already hosts a LiFiDiamond (`deployContractToNetworks.sh` adds the facet to an existing diamond; it does **not** stand up a brand-new network — that's `/add-network` + a full deploy). If a named chain has no diamond, flag it and drop it from the list.
- **Discovery** (default when the user says "all chains where it's running" or names none) — chains where the contract is already live in the production diamond, plus its deployed version (verified recipe):

```bash
for F in deployments/*.diamond.json; do
  NET=$(basename "$F" .diamond.json)
  V=$(jq -r --arg N "<Contract>" '(.LiFiDiamond.Facets // {}) | to_entries[] | select(.value.Name == $N) | .value.Version' "$F" 2>/dev/null | head -1)
  [ -n "$V" ] && echo "$NET $V"
done
```

For periphery contracts check `.LiFiDiamond.Periphery | has($N)` instead. The glob matches only production logs (`*.diamond.staging.json` and `*.diamond.immutable.json` do not end in `.diamond.json`).

Repo version: `grep -m1 "@custom:version" src/Facets/<Contract>.sol` (or `src/Periphery/...`). Report old → new version per chain (a new chain shows no current version — that's expected). Chains already on the repo version are re-deployed only if the user asked — surface them and ask.

### whitelist mode

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

## Phase 2 — Confirm plan

Present: mode, contract + version (or PR + summary), full network list, what will be created (one Safe proposal per chain, timelock-wrapped). Wait for explicit go-ahead.

## Phase 3 — Execute

Run in the background (long-running; deploys retry and verify), monitor output, report per-network results:

```bash
# deploy mode
./script/deploy/deployContractToNetworks.sh <Contract> <network...> --production

# whitelist mode
./script/tasks/syncWhitelistToNetworks.sh <network...> --production
```

Both end with a per-network summary and exit `1` if any network failed. Failures don't block the survivors: continue the flow with the succeeded networks, report the failed ones, and offer to retry them individually with the same command. Each proposal is created already carrying one signature, so every fresh proposal starts at `signatureCount: 1`.

Whitelist note: a production sync automatically re-syncs staging on the same networks afterwards (staging sends directly, no proposals) — expected, not an error.

## Phase 4 — Capture proposals

```bash
bunx tsx script/deploy/safe/list-pending-proposals.ts --network <csv> --maxAgeHours 2 --json
```

Expect one `pending` proposal per succeeded network with `signatureCount: 1` (the signature added at creation). Targets are the chain's `LiFiTimelockController` (proposals wrap in a timelock `scheduleBatch`). Keep `nonce` per network — the PR table needs it. Missing networks here mean the propose step failed even though the deploy succeeded — investigate before continuing.

## Phase 5 — Draft PR (deploy mode only)

The deploy updated `deployments/<net>.json` (and staging logs if staging was deployed). Model the PR on #1917:

1. Branch (never commit to main), commit only deployment-log changes, push.
2. Body from `.github/pull_request_template.md` (see project instructions for the `gh api` PATCH pattern). "Why" section: staging bullet list (if any) + production table `| Chain | Facet address | Safe nonce |` from Phase 4, plus the note that production `<chain>.diamond.json` registries update only when the cuts execute.
3. Run `/pr-ready` before `gh pr create --draft` (the pre-PR gate enforces it).

Whitelist mode changes no files — skip this phase; the input PR plays the PR role in the Slack post.

## Phase 6 — Hand off signing

Give the user (VPN required; Ledger is the default signer):

```bash
bunx tsx script/deploy/safe/confirm-safe-tx.ts
```

Variants if they ask: `--network <name>` (one chain), `--ledgerLive --accountIndex <i>` (Ledger Live derivation). They will sign each proposal — one signature is already on it, so theirs makes 2 of the 3 required (the remaining signer comes from the Slack thread). Then **stop and wait** for the user to say they're done.

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

Summarize: networks rolled out (+ failures and their state), proposal nonces, PR URL, Slack thread link, and what remains (team signatures/execution; timelock ops execute via the scheduled pipeline after the delay).

## Failure modes

- `list-pending-proposals.ts` exits `2` → VPN down or `SC_MONGODB_URI` missing — tell the user, retry after they fix it.
- Deploy succeeded but no proposal row → propose step failed; check the deploy log for the network, re-run that single network.
- Stale/future nonce warnings during signing → `confirm-safe-tx.ts` explains them inline; relay its guidance (usually: delete + re-propose, or execute the blocking nonce first).
- Slack MCP missing → give the user both message texts verbatim to post manually; do not fall back to webhooks (wrong identity).
