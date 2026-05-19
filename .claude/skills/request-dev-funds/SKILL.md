---
name: request-dev-funds
description: Request development funds from the LI.FI `lifinance/automate-wallet-dev-fees` PR-based wallet. Parses a natural-language request (amount, token, chain, optional recipient + justification), resolves chain-name → chainId via `config/networks.json` and recipient → address via `config/global.json` (defaulting to `deployerWallet`), opens a PR appending an entry to `transfers/requests.json`, and pings the current approvers in a PR comment. Use when the user says "request dev funds", "refill deployer", "fund the deployer wallet", "/request-dev-funds …", "request 100 USDC on Base", "I need gas on Arbitrum", "top up the refund wallet", or otherwise asks for funds via the automated-wallet flow. Requires `gh` and `jq`. EVM + Solana only (TRON / BTC / SUI unsupported). Skip if the user only asks about an existing fund-request PR (read intent) rather than creating one.
---

# Request Dev Funds

## When to trigger

User says any of:

- "request dev funds" / "request funds for the deployer" / "refill deployer"
- "request 100 USDC on Base" / "I need 0.5 ETH on Arbitrum"
- "top up the refund wallet" / "fund pauserWallet on Polygon"
- "/request-dev-funds [free-form description]"
- Any natural request that implies opening a PR against `lifinance/automate-wallet-dev-fees`

Skip when:

- User is asking about an existing fund request (read intent — just `gh pr view` it).
- User wants TRON, BTC, or SUI funding — those aren't supported by the wallet (see [README](https://github.com/lifinance/automate-wallet-dev-fees)). Tell them and stop.

## Background

The funding wallet repo (`lifinance/automate-wallet-dev-fees`) is PR-driven:

1. A PR appends an entry to `transfers/requests.json`.
2. `validate.yml` posts a confirmation comment (chain/token/address sanity check).
3. `process.yml` runs the `lifinance/automate-wallet` action which executes the transfer.
   - If the PR **author** is in `allowed-actors` (read from `process.yml` at runtime) → executes immediately, no review needed.
   - Otherwise → waits for an `allowed-actors` user to approve the PR, then executes.
4. On success, the action commits the result + auto-merges (squash).

The wallet auto-bridges and auto-swaps via LI.FI, so the user can request any token on any supported chain even if the wallet only holds funds elsewhere.

### Side effects and required permissions

This skill performs writes that are visible to the team and — once the PR is approved / auto-executed — produce **irreversible on-chain transfers**. Be explicit with the user about what will happen before doing it:

- **Local writes**: clones `lifinance/automate-wallet-dev-fees` into `/tmp`, creates a branch, edits `transfers/requests.json`, commits.
- **Remote writes** (require `gh` auth as a LI.FI member with push access to `automate-wallet-dev-fees`):
  - `git push` of the new branch.
  - `gh pr create` against `main` of the funding repo.
  - `gh pr comment` to ping approvers.
- **Remote reads** (require `gh` auth as a LI.FI member): `gh api …/contents/.github/workflows/process.yml` to read the live `allowed-actors` list.
- **Triggered execution**: once the PR merges (or the author is in `allowed-actors`), the `lifinance/automate-wallet` action signs and broadcasts a real transfer from a real wallet on a real chain. There is no rollback.

Stop and surface any auth / permission failure to the user — never paper over it.

## Inputs (parsed from the user's prompt)

Required:

- **amount** — decimal string in **human-readable token units**, **not** atomic units (wei / lamports / smallest-denomination). `"1"` means 1 ETH, not 1 wei. `"100.0"` means 100 USDC, not 100 × 10⁶. Always quoted in JSON — the upstream action parses it as a decimal string and applies the token's `decimals` itself. If the user's prompt is ambiguous (e.g. "send 1000000000000000000" for ETH), **ask for clarification** before proceeding — accidentally requesting 100 ETH instead of 100 USDC equivalent is a real foot-gun.
- **token** — symbol (`USDC`, `USDT`, `ETH`, `SOL`, etc.) or raw `0x…` address.
- **chain** — name (`base`, `arbitrum`, `mainnet`, `solana`, …) or chainId.

Optional:

- **recipient** — wallet label (`deployerWallet`, `refundWallet`, `withdrawWallet`, `pauserWallet`, `feeCollectorOwner`, `devWallet`) or raw `0x…` address. **Default: `deployerWallet`.**
- **description / justification** — free text for the entry's `description` field.

If anything required is missing or ambiguous, ask **once**, concisely. Don't run a wizard — collapse multiple missing fields into one question.

## Workflow

### 1. Confirm we're in `lifinance/contracts`

```bash
test -f config/global.json && test -f config/networks.json
```

If not, ask the user to `cd` into the contracts repo (the skill reads its config for defaults). Don't proceed.

### 2. Resolve chain → chainId

```bash
jq -r --arg c "<chain-input>" \
  '(. as $r | $r[$c] // (to_entries | map(select(.value.chainId == ($c|tonumber? // -1))) | .[0].value)) // empty | .chainId' \
  config/networks.json
```

Practical resolution order:

- If input is numeric, treat as chainId and verify it exists in `networks.json`.
- Else lower-case the input and key-lookup directly.
- Else fuzzy-match against keys (`arb` → `arbitrum`) — but **confirm with user** before using a fuzzy match.

### 3. Resolve recipient → address

```bash
jq -r --arg k "<label>" '.[$k] // empty' config/global.json
```

- Default label: `deployerWallet`.
- Raw address rules — choose by chain family:
  - **EVM**: validate hex format + length 42 (`^0x[0-9a-fA-F]{40}$`). If mixed-case, run EIP-55 checksum validation (`cast --to-checksum-address "$ADDR"` and compare, or use ethers' `getAddress`); on mismatch, refuse and ask the user to re-paste. Preserve the checksummed casing when writing to JSON. If all-lowercase or all-uppercase, accept as-is and skip the checksum check.
  - **Solana**: validate the input decodes from base58 to exactly 32 bytes (Ed25519 public key). Use verbatim — no case normalisation (base58 is case-sensitive).
- If user named another wallet (e.g. "to refund wallet"), look up the matching `config/global.json` key. Known keys: `deployerWallet`, `refundWallet`, `withdrawWallet`, `pauserWallet`, `feeCollectorOwner`, `devWallet`.
- Never hard-code addresses in the skill — always read from `config/global.json` at runtime so values can't go stale.

### 4. Resolve token

- **Native gas** (`ETH`, `MATIC`, `BNB`, `SOL`, etc.) → **omit the `token` field entirely**. The automate-wallet action treats absence-of-token as "native". (Verified from `lifinance/automate-wallet` README, 2026-05-15.)
- **Raw address** — chain-aware:
  - **EVM `0x…`**: validate format + length 42 (same EIP-55 rule as recipient resolution above). Use verbatim.
  - **Solana SPL mint**: validate base58 decodes to 32 bytes. Use verbatim.
- **Symbol** → ask the user for the address. You may suggest a canonical address from training data (e.g. "USDC on Base is usually `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — use this?") but the user must explicitly confirm before the address is written to JSON. **Do not guess silently and do not maintain a built-in address table** — addresses can rotate (native vs. bridged USDC, contract migrations) and stale lookup tables are a foot-gun.

#### EVM token-contract sanity check (after a raw `0x…` address is resolved)

Before showing the Step-5 confirmation block, call `symbol()` and `name()` on the resolved EVM token contract and surface the result. This catches the "user pasted the wrong address" class of mistake on the human's side, where it can still be aborted.

```bash
RPC=$(jq -r --arg c "<chain-key>" '.[$c].rpcUrl // empty' config/networks.json)
SYMBOL=$(cast call "$TOKEN_ADDR" "symbol()(string)" --rpc-url "$RPC" 2>/dev/null || echo "<call failed>")
NAME=$(cast call   "$TOKEN_ADDR" "name()(string)"   --rpc-url "$RPC" 2>/dev/null || echo "<call failed>")
```

- Render both values in the confirmation block (see Step 5).
- If either call fails (revert / non-ERC20 / RPC error): show `<call failed — token may not be ERC-20 / RPC unreachable>` and flag it explicitly. Do **not** auto-abort — the user may legitimately be funding a non-standard contract — but make the failure unmissable.
- Skip this step for native gas (no `token` field) and for Solana SPL mints (different RPC + on-chain layout — out of scope for v1).

### 5. Show single-block confirmation

Render a one-block summary and require explicit "yes" before any write. The summary **must include an irreversibility warning** so the user understands what the PR triggers — a real on-chain transfer that cannot be rolled back:

```text
⚠️  About to open a PR that will trigger a REAL on-chain transfer once approved
   (or immediately, if you are in allowed-actors). This is irreversible —
   confirm chain, recipient, token, and amount carefully before proceeding.

About to open PR against lifinance/automate-wallet-dev-fees:

  Chain:       base (chainId 8453)
  Recipient:   deployerWallet → 0xb137683965ADC470f140df1a1D05B0D25C14E269
  Token:       USDC → 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
                 ↳ on-chain symbol(): "USDC"
                 ↳ on-chain name():   "USD Coin"
  Amount:      100.0 USDC  (human units — NOT wei / 6-decimals atomic)
  Description: Top-up deployer for upcoming chain onboarding

JSON entry:
{
  "chainId": 8453,
  "to": "0xb137683965ADC470f140df1a1D05B0D25C14E269",
  "amount": "100.0",
  "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "description": "Top-up deployer for upcoming chain onboarding"
}

Proceed? (y/n)
```

For native gas, omit the `token` line (and the `symbol()` / `name()` lines) from both the summary and the JSON. For Solana mints, omit the `symbol()` / `name()` lines (v1 doesn't introspect SPL mints).

If the EVM token sanity check failed, surface it loudly inside the same block:

```text
  Token:       0x... → ⚠️ <call failed — token may not be ERC-20 / RPC unreachable>
```

**Always require an explicit, unambiguous confirmation reply before any write** — accept only `yes`, `proceed`, or `confirm` (case-insensitive). Bare `y` is too easy to mis-type or auto-suggest; reject it and re-ask. Even if the invoking prompt sounds like consent (e.g. "go ahead and request 100 USDC on Base"), still render the summary and still wait for the explicit acknowledgement. The PR triggers a real, irreversible on-chain spend — one extra keystroke is cheaper than one wrong transfer.

### 6. Open the PR

This step performs **remote writes** (git push + PR creation) into a private LI.FI repo and is what arms the on-chain transfer pipeline. Run it only after Step 5 has returned an explicit `yes` / `proceed` / `confirm`. Stop on any auth error from `gh` — never retry with `--force` or fall back to anonymous git.

```bash
TMP="/tmp/awdf-$(date +%s)"
gh repo clone lifinance/automate-wallet-dev-fees "$TMP" -- --depth=1
cd "$TMP"

BRANCH="request/<chain>-<token-or-native>-<short-recipient>-$(date +%y%m%d)"
# Example: request/base-usdc-deployer-260515
git checkout -b "$BRANCH"
```

Append the entry preserving the existing `{ "version": 1, "entries": [...] }` wrapper — **never** hand-write JSON via string concatenation:

```bash
# Build the entry (omit "token" key for native gas)
ENTRY=$(jq -n \
  --argjson chainId 8453 \
  --arg to "0xb137..." \
  --arg amount "100.0" \
  --arg token "0x8335..." \
  --arg description "..." \
  '{chainId:$chainId, to:$to, amount:$amount, token:$token, description:$description}')

# For native gas, drop the token field:
# ENTRY=$(echo "$ENTRY" | jq 'del(.token)')

jq --argjson e "$ENTRY" '.entries += [$e]' transfers/requests.json > transfers/requests.json.tmp \
  && mv transfers/requests.json.tmp transfers/requests.json

git add transfers/requests.json
git commit -m "chore: request <amount> <token> on <chain> for <recipient-label>"
git push -u origin "$BRANCH"
```

PR title: `Request funds: <amount> <token> on <chain> for <short justification>`
(e.g. `Request funds: 100 USDC on Base for QA testing`)

PR body:

```markdown
## Request

| Field | Value |
|---|---|
| Chain | base (8453) |
| Recipient | `deployerWallet` → `0xb137...E269` |
| Token | USDC → `0x8335...2913` *(or "native" if no token field)* |
| Amount | 100.0 |

**Justification:** <free-text description>

### Entry added to `transfers/requests.json`

\`\`\`json
{
  "chainId": 8453,
  "to": "0xb137683965ADC470f140df1a1D05B0D25C14E269",
  "amount": "100.0",
  "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "description": "..."
}
\`\`\`

Opened via the `request-dev-funds` Claude Code skill.
```

Create with:

```bash
gh pr create --repo lifinance/automate-wallet-dev-fees \
  --title "<title>" --body "<body>" --base main --head "$BRANCH"
```

### 7. Ping current approvers

This step performs a **remote read** (`gh api …/contents/.github/workflows/process.yml`) and a **remote write** (`gh pr comment`). Both require `gh` auth as a LI.FI org member — fail loudly if either errors. Read the live approver list from `main` so it doesn't go stale:

```bash
ACTORS=$(gh api repos/lifinance/automate-wallet-dev-fees/contents/.github/workflows/process.yml \
  --jq '.content' | base64 -d \
  | grep -E 'allowed-actors:' | sed -E 's/.*"([^"]+)".*/\1/')
# ACTORS is comma-separated, e.g. "maxklenk,0xlindso"

MENTIONS=$(echo "$ACTORS" | tr ',' '\n' | sed 's/^/@/' | tr '\n' ' ')

gh pr comment "<PR_URL>" --body "$MENTIONS— please review/approve when you get a chance 🙏"
```

If the PR author happens to be in `ACTORS` (i.e. the current `gh api user --jq .login` matches an entry), the PR will auto-execute without needing the ping — still post the comment for an audit trail, but mention this in the final user message ("you're authorized — should execute on its own").

### 8. Return to user

Report:

```text
Opened https://github.com/lifinance/automate-wallet-dev-fees/pull/<N>
  Pinged: @maxklenk @0xlindso
  Status: waiting for approval  (or: auto-executing — you're in allowed-actors)
```

## Failure modes

- **`gh` unauthenticated** → ask user to run `gh auth login`; do not proceed.
- **`jq` missing** → tell user to `brew install jq`.
- **Not in `lifinance/contracts`** → ask user to `cd`; defaults (`deployerWallet`, chain map) come from that repo's config.
- **Chain not in `config/networks.json`** → surface the closest matches; ask. Don't guess silently.
- **Wallet label not in `config/global.json`** → surface available wallet keys; ask.
- **`transfers/requests.json` schema changed upstream** → re-read [the upstream README](https://github.com/lifinance/automate-wallet-dev-fees) and confirm before editing.
- **PR creation conflict (branch exists)** → suffix the branch name with `-2`, `-3`, ….

## Out of scope (v1)

- Multiple requests in a single PR. (Trivial to extend later — `entries` is already an array.)
- Tracking PR status post-creation / waiting for execution. The user owns the wait.
- Slack posting. The PR comment is the only notification this skill produces.
- TRON / BTC / SUI. Not supported by the upstream wallet — refuse early.
- Generalisation to other repos / recipients — that lives in `lifi-claude-skills` (TBD).

## Design notes

- All resolutions (chainId, recipient address, approver list, token addresses for confirmation) are **read at runtime** from canonical sources (`config/global.json`, `config/networks.json`, upstream `process.yml`). The skill body holds zero secrets and zero hard-coded addresses that can rot.
- Native gas is signalled by omitting the `token` key. Do not write `"token": "0x0000…0000"` — that is a different (and wrong) semantic in the automate-wallet action.
- The wallet repo is private to LI.FI; PR creation requires `gh` authenticated as a member.
- One entry per PR is intentional for v1: simpler review, simpler rollback, simpler audit trail.
