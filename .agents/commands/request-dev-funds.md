---
name: request-dev-funds
usage: /request-dev-funds
description: "Opens a PR on `lifinance/automate-wallet-dev-fees` requesting funds on a chain for a LI.FI wallet (default `deployerWallet`) and pings approvers. Use for \"request dev funds\" / \"I need gas on Arbitrum\". EVM + Solana only. Moving funds from a key in `.env` → `manage-wallet-funds`."
---

# Request Dev Funds

Skip when the user only asks about an existing request (just `gh pr view` it), or wants TRON / BTC / SUI (unsupported by the wallet — say so and stop).

## How the funding repo works

`lifinance/automate-wallet-dev-fees` (private; `gh` must be authed as a LI.FI member with push access) is PR-driven:

1. A PR appends an entry to `transfers/requests.json`.
2. `validate.yml` posts a sanity-check comment.
3. `process.yml` runs `lifinance/automate-wallet`, which executes the transfer — immediately if the PR author is in its `allowed-actors`, otherwise after an `allowed-actors` user approves.
4. The action commits the result and squash-merges.

The wallet auto-bridges/swaps via LI.FI, so any token on any supported chain can be requested. The executed transfer is a real, irreversible on-chain spend with no rollback. Stop on any `gh` auth/permission error — never retry with `--force` or fall back to anonymous git.

## Inputs (parsed from the prompt)

- **amount** (required) — decimal string in human token units, not atomic (`"1"` = 1 ETH; `"100.0"` = 100 USDC). Always quoted in JSON; the action applies decimals. If ambiguous (e.g. `1000000000000000000` for ETH), ask.
- **token** (required) — symbol or address.
- **chain** (required) — name or chainId.
- **recipient** — wallet label or raw address; default `deployerWallet`.
- **description** — free-text justification.

Collapse all missing/ambiguous fields into one question.

## Workflow

### 1. Confirm the repo

`test -f config/global.json && test -f config/networks.json` — otherwise ask the user to `cd` into `lifinance/contracts` (defaults come from its config).

### 2. Chain → chainId

```bash
jq -r --arg c "<chain-input>" \
  '(. as $r | $r[$c] // (to_entries | map(select(.value.chainId == ($c|tonumber? // -1))) | .[0].value)) // empty | .chainId' \
  config/networks.json
```

Numeric → verify it exists; else lower-cased key lookup; else fuzzy match (`arb` → `arbitrum`), confirmed with the user. Not found → show closest matches.

### 3. Recipient → address

```bash
jq -r --arg k "<label>" '.[$k] // empty' config/global.json
```

Labels: `deployerWallet`, `refundWallet`, `withdrawWallet`, `pauserWallet`, `feeCollectorOwner`, `devWallet`. Unknown label → list available keys. Always read addresses at runtime; never hard-code.

Raw address by chain family:

- EVM: `^0x[0-9a-fA-F]{40}$`. Mixed case → EIP-55 check (`cast --to-checksum-address`); mismatch → refuse and ask to re-paste. Keep checksummed casing. All-lower/upper → accept as is.
- Solana: must base58-decode to exactly 32 bytes; use verbatim (case-sensitive).

### 4. Token

- Native gas → omit the `token` field entirely. Never write `"token": "0x0000…0000"` — the action reads that differently.
- Raw address → same validation as step 3.
- Symbol → ask for the address. You may suggest one ("USDC on Base is usually `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — use this?"), but the user must confirm. Keep no built-in address table — native vs bridged and migrations make them stale.

For an EVM token address, read `symbol()` and `name()` to catch a wrong paste:

```bash
RPC=$(jq -r --arg c "<chain-key>" '.[$c].rpcUrl // empty' config/networks.json)
SYMBOL=$(cast call "$TOKEN_ADDR" "symbol()(string)" --rpc-url "$RPC" 2>/dev/null || echo "<call failed>")
NAME=$(cast call   "$TOKEN_ADDR" "name()(string)"   --rpc-url "$RPC" 2>/dev/null || echo "<call failed>")
```

On failure show `⚠️ <call failed — token may not be ERC-20 / RPC unreachable>` in the confirmation but don't abort. Skip for native and Solana mints.

### 5. Confirmation

Render one block and wait before any write:

```text
⚠️  About to open a PR that will trigger a REAL on-chain transfer once approved
   (or immediately, if you are in allowed-actors). This is irreversible.

About to open PR against lifinance/automate-wallet-dev-fees:

  Chain:       base (chainId 8453)
  Recipient:   deployerWallet → 0xb05E63458A51731Aad26BdcD6E12246330E6095F
  Token:       USDC → 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
                 ↳ on-chain symbol(): "USDC"
                 ↳ on-chain name():   "USD Coin"
  Amount:      100.0 USDC  (human units — NOT wei / 6-decimals atomic)
  Description: Top-up deployer for upcoming chain onboarding

JSON entry:
{ "chainId": 8453, "to": "0xb05E…095F", "amount": "100.0", "token": "0x8335…2913", "description": "…" }
```

Omit token lines for native, and the `symbol()`/`name()` lines for Solana. Accept only `yes`, `proceed`, or `confirm` (case-insensitive) — reject bare `y`. Render and wait even if the prompt already sounded like consent.

### 6. Open the PR

```bash
TMP="/tmp/awdf-$(date +%s)"
gh repo clone lifinance/automate-wallet-dev-fees "$TMP" -- --depth=1
cd "$TMP"
BRANCH="request/<chain>-<token-or-native>-<short-recipient>-$(date +%y%m%d)"   # e.g. request/base-usdc-deployer-260515
git checkout -b "$BRANCH"

ENTRY=$(jq -n \
  --argjson chainId 8453 --arg to "0x…" --arg amount "100.0" --arg token "0x…" --arg description "…" \
  '{chainId:$chainId, to:$to, amount:$amount, token:$token, description:$description}')
# native gas: ENTRY=$(echo "$ENTRY" | jq 'del(.token)')

jq --argjson e "$ENTRY" '.entries += [$e]' transfers/requests.json > transfers/requests.json.tmp \
  && mv transfers/requests.json.tmp transfers/requests.json

git add transfers/requests.json
git commit -m "chore: request <amount> <token> on <chain> for <recipient-label>"
git push -u origin "$BRANCH"
```

Preserve the `{ "version": 1, "entries": [...] }` wrapper; build JSON only with `jq`. Before `git checkout -b`, if `git ls-remote --exit-code --heads origin "$BRANCH"` finds it, suffix `-2`, `-3`, …. If `transfers/requests.json`'s schema has changed, re-read the upstream README and confirm before editing.

```bash
gh pr create --repo lifinance/automate-wallet-dev-fees \
  --title "Request funds: <amount> <token> on <chain> for <short justification>" \
  --body "<body>" --base main --head "$BRANCH"
```

Body: a `## Request` table (Chain, Recipient label → address, Token or "native", Amount), a `**Justification:**` line, the added JSON entry in a code block, and `Opened via the request-dev-funds Claude Code skill.`

### 7. Ping approvers

Read the live list from `main`:

```bash
ACTORS=$(gh api repos/lifinance/automate-wallet-dev-fees/contents/.github/workflows/process.yml \
  --jq '.content' | base64 -d \
  | grep -E 'allowed-actors:' | sed -E 's/.*"([^"]+)".*/\1/')
MENTIONS=$(echo "$ACTORS" | tr ',' '\n' | sed 's/^/@/' | tr '\n' ' ')
gh pr comment "<PR_URL>" --body "$MENTIONS— please review/approve when you get a chance 🙏"
```

If `gh api user --jq .login` is in `ACTORS`, the PR auto-executes; still post the comment for the audit trail and tell the user.

### 8. Report

PR URL, who was pinged, and status (waiting for approval, or auto-executing). One entry per PR; no Slack post and no tracking of execution — the user owns the wait.
