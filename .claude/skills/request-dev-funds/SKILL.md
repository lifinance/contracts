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
- If user supplied a raw `0x…` address, use it verbatim (lowercase + checksum-validate length 42).
- If user named another wallet (e.g. "to refund wallet"), look up the matching `config/global.json` key. Known keys: `deployerWallet`, `refundWallet`, `withdrawWallet`, `pauserWallet`, `feeCollectorOwner`, `devWallet`.
- Never hard-code addresses in the skill — always read from `config/global.json` at runtime so values can't go stale.

### 4. Resolve token

- **Native gas** (`ETH`, `MATIC`, `BNB`, `SOL`, etc.) → **omit the `token` field entirely**. The automate-wallet action treats absence-of-token as "native". (Verified from `lifinance/automate-wallet` README, 2026-05-15.)
- **`0x…` address** → use verbatim.
- **Symbol** → ask the user for the address unless you're 100% sure (chain-specific). For common pairs offer an educated guess and require explicit confirmation, e.g.:
  > USDC on Base is usually `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Use this? (y/n)

  Quick reference (confirm before using — do not hard-encode further):
  | Chain | USDC | USDT |
  |---|---|---|
  | mainnet (1) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
  | arbitrum (42161) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` |
  | base (8453) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | — |
  | optimism (10) | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` |
  | polygon (137) | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` |

  For any chain/token not in this table or anything the user hasn't confirmed: ask. Do not guess.

### 5. Show single-block confirmation

Render a one-block summary and require explicit "yes" before any write:

```
About to open PR against lifinance/automate-wallet-dev-fees:

  Chain:       base (chainId 8453)
  Recipient:   deployerWallet → 0xb137683965ADC470f140df1a1D05B0D25C14E269
  Token:       USDC → 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
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

For native gas, omit the `token` line from both the summary and the JSON.

If the user's invoking prompt already constitutes consent (e.g. "go ahead and request 100 USDC on Base to the deployer for QA"), still show the summary, but skip the y/n prompt — proceed and report afterwards. When in doubt, ask.

### 6. Open the PR

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

Read the live approver list from `main` so it doesn't go stale:

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
```
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
