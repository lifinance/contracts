---
name: send-deployer-funds
usage: /send-deployer-funds
description: Send native gas funds directly from one of our own wallets (deployer keys in `.env`) to a specified recipient on a specified network via `cast send`. Parses a natural-language request with an absolute amount ("send 0.1 ETH to 0xabc… on base") or a relative amount ("send 10% of our holdings on outlaw to 0xf79…"), resolves the network RPC from `config/networks.json` with an `ETH_NODE_URI_<NETWORK>` fallback, derives the sender address from the private key (never from `config/global.json`), verifies chain-id, shows a pre-send report, and verifies balances after sending. Use when the user says "send funds", "send gas", "transfer ETH from the deployer", "/send-deployer-funds …", or otherwise asks to move native funds FROM our own wallet. NOT for requesting funds INTO our wallets — that is `request-dev-funds` (PR-based, from the automate-wallet). Requires `cast` (Foundry) and `jq`. EVM only.
---

# Send Deployer Funds

## When to trigger

User says any of:

- "send 0.1 ETH to 0xabc… on base" / "send gas to 0xf79… on outlaw"
- "send 10% of our holdings on \<network\> to \<address\>"
- "transfer funds from the deployer wallet to …"
- "/send-deployer-funds [free-form description]"

Skip when:

- The user wants funds sent **TO** one of our wallets (deployer top-up, refill, "I need gas on …") → that is the `request-dev-funds` skill (PR against `lifinance/automate-wallet-dev-fees`). This skill is the opposite direction: a direct `cast send` **FROM** our own keys.
- The user wants to send an ERC-20 token → out of scope (v1 is native gas only). Say so and stop.
- The target chain is non-EVM (Solana / TRON / BTC / SUI) → unsupported. Say so and stop.

## Side effects and required permissions

This skill signs and broadcasts a **real, irreversible on-chain transfer** from a real production (or staging) wallet, using private keys read from the local `.env`. There is no PR, no reviewer, no rollback — the only gate is the explicit confirmation step below. Treat every run as spending real money.

- **Local reads**: `.env` (private key + RPC env vars), `config/networks.json`.
- **Network**: `cast` RPC calls (chain-id, balances, gas price) and one `cast send` broadcast.
- **No writes** to the repo, no remote git/`gh` operations.

## Secrets hygiene (non-negotiable)

- **Never print, echo, or log the private key** — not in command output, not in error messages, not in the pre-send report. Read it inside a subshell and pass it via a shell variable; never interpolate it into anything the user (or the transcript) sees.
- **Never print full RPC URLs** — they may embed API keys. When reporting which RPC was used, show only the host (`https://rpc.example.com/…`) or the env var name (`ETH_NODE_URI_OUTLAW`).
- Pipe `cast send` output through a filter that strips both before display (see Step 6).

## Inputs (parsed from the user's prompt)

Required:

- **amount** — either absolute in human-readable native units ("0.1 ETH", "0.05") or relative ("10% of our holdings", "half the balance").
- **recipient** — raw `0x…` address (no `config/global.json` label lookup — this skill sends to arbitrary external recipients).
- **network** — name as used in `config/networks.json` keys, or an in-flight network only present on a `deploy-network-<name>` branch.

Optional:

- **environment** — `production` (default) or `staging`. Selects which private key is used (see Step 2).

If anything required is missing or ambiguous, ask **once**, concisely — collapse multiple missing fields into one question.

## Workflow

### 1. Resolve the network → RPC URL + expected chainId

```bash
NETWORK="<network-lowercase>"
RPC=$(jq -r --arg n "$NETWORK" '.[$n].rpcUrl // empty' config/networks.json)
EXPECTED_CHAIN_ID=$(jq -r --arg n "$NETWORK" '.[$n].chainId // empty' config/networks.json)
```

If the key is missing from `config/networks.json` (e.g. a chain still on an in-flight `deploy-network-<name>` branch), fall back to the RPC env var convention:

```bash
RPC_VAR="ETH_NODE_URI_$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')"
RPC=$(grep -E "^${RPC_VAR}=" .env | cut -d= -f2- | tr -d '"')
```

In the fallback case there is no chainId in `networks.json` — get the expected chainId from the user or from the in-flight branch's `networks.json` before proceeding. **Never send without a chainId expectation.**

Then verify the RPC actually serves that chain:

```bash
ACTUAL_CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
[[ "$ACTUAL_CHAIN_ID" == "$EXPECTED_CHAIN_ID" ]] || { echo "chain-id mismatch: expected $EXPECTED_CHAIN_ID, got $ACTUAL_CHAIN_ID"; exit 1; }
```

On mismatch, stop and surface both values — do not proceed.

### 2. Resolve the sender from `.env` (derive, never look up)

Key selection follows the same convention as `getPrivateKey()` in `script/helperFunctions.sh`:

- `production` (default) → `PRIVATE_KEY_PRODUCTION`
- `staging` → `PRIVATE_KEY`

**Always derive the sender address from the key itself** — inside a subshell, without echoing the key:

```bash
if [[ "$ENVIRONMENT" == "staging" ]]; then KEY_VAR="PRIVATE_KEY"; else KEY_VAR="PRIVATE_KEY_PRODUCTION"; fi
SENDER=$(set +x; KEY=$(grep -E "^${KEY_VAR}=" .env | cut -d= -f2- | tr -d '"'); cast wallet address --private-key "$KEY")
```

Do **NOT** use `config/global.json`'s `deployerWallet` for the sender address or for balance checks. The key and the config can diverge: on `outlaw` (2026-06-11) the key derived to `0x492E267321E863fA45Bc9d97c9f64Fa9Df70d4c4` while `global.json` listed `0xb137683965ADC470f140df1a1D05B0D25C14E269` — an address with zero balance and nonce 0 on that chain. Checking the wrong address makes a funded wallet look empty (or vice versa).

If the env var is missing from `.env`, stop and tell the user which variable is missing — never fall back to another key silently.

### 3. Validate the recipient address

- Must match `^0x[0-9a-fA-F]{40}$`.
- If mixed-case, run EIP-55 checksum validation (`cast to-check-sum-address "$RECIPIENT"` and compare); **refuse on mismatch** and ask the user to re-paste. If all-lowercase or all-uppercase, accept as-is and skip the checksum comparison.
- Sanity flag (warn, don't block): recipient equal to the sender, or to the zero address — surface it and ask.

### 4. Compute the amount in wei

Read the sender balance first:

```bash
BALANCE_WEI=$(cast balance "$SENDER" --rpc-url "$RPC")
```

- **Absolute** ("0.1 ETH"): `AMOUNT_WEI=$(cast to-wei "0.1" ether)`.
- **Relative** ("10% of holdings"): compute in wei with integer arithmetic — `AMOUNT_WEI=$(echo "$BALANCE_WEI * 10 / 100" | bc)`. Never do the percentage math in floating-point ETH units.
- **Gas headroom**: the send must leave enough for its own gas. Estimate `GAS_COST ≈ 21000 × gas price` (`cast gas-price --rpc-url "$RPC"`) with a safety margin (e.g. 2×). If `AMOUNT_WEI + GAS_COST > BALANCE_WEI`, reduce a relative amount accordingly, or refuse an absolute amount and report the shortfall. "100% of holdings" means balance minus the gas headroom, not the literal balance.

### 5. Pre-send report + explicit confirmation

Render a one-block summary and require explicit confirmation before broadcasting:

```text
⚠️  About to broadcast a REAL native transfer. This is irreversible.

  Network:            outlaw  (chainId 4663 — verified via cast chain-id)
  RPC source:         ETH_NODE_URI_OUTLAW            (URL not shown — may embed API key)
  Sender:             0x492E267321E863fA45Bc9d97c9f64Fa9Df70d4c4  (derived from PRIVATE_KEY_PRODUCTION)
  Sender balance:     980845853615340000 wei  (0.98084585… ETH)
  Recipient:          0xf79…                        (current balance: 0 wei)
  Amount:             98084585361534000 wei  (0.09808458… ETH — 10% of holdings)
  Est. gas headroom:  ~42000000000000 wei reserved

Proceed? (yes/no)
```

Accept only `yes`, `proceed`, or `confirm` (case-insensitive); reject bare `y` and re-ask. Even if the invoking prompt sounds like consent ("go ahead and send 0.1 ETH…"), still render the report and still wait for the explicit acknowledgement.

### 6. Send

```bash
(set +x; KEY=$(grep -E '^PRIVATE_KEY_PRODUCTION=' .env | cut -d= -f2- | tr -d '"'); \
  cast send "$RECIPIENT" --value "$AMOUNT_WEI" --private-key "$KEY" --rpc-url "$RPC") \
  2>&1 | grep -vE 'private|PRIVATE|key' | sed "s|$RPC|<rpc>|g"
```

The subshell keeps the key out of the calling shell's state; the filter strips any line mentioning the key and redacts the RPC URL from the printed output. Capture the transaction hash and receipt status from the output.

### 7. Post-send verification

- Confirm the receipt has `status 1` (`cast receipt <txhash> status --rpc-url "$RPC"` if not already shown by `cast send`).
- Re-read both balances and report the deltas:

```bash
cast balance "$SENDER" --rpc-url "$RPC"
cast balance "$RECIPIENT" --rpc-url "$RPC"
```

Report to the user: tx hash, status, sender balance before → after, recipient balance before → after.

## Failure modes

- **`cast` missing** → tell the user to install Foundry (`foundryup`); do not substitute another tool.
- **Env var (key or RPC) missing from `.env`** → name the missing variable and stop. Never guess or fall back silently.
- **Chain-id mismatch** → stop, show expected vs. actual. The RPC is pointing at the wrong chain.
- **Checksum mismatch on recipient** → refuse, ask for a re-paste.
- **Insufficient balance for amount + gas** → report balance, requested amount, and estimated gas; ask whether to reduce.
- **`cast send` reverts or receipt status 0** → report the tx hash and status; do not retry automatically.
- **RPC flaky/unreachable** → surface the error (with the URL redacted) and stop.

## Out of scope (v1)

- ERC-20 transfers (native gas only).
- Non-EVM chains.
- Batch sends / multiple recipients.
- Sending from any key other than the `.env` deployer keys (`PRIVATE_KEY_PRODUCTION` / `PRIVATE_KEY`).

## Design notes

- Direction matters: `request-dev-funds` moves funds **into** our wallets via a reviewed PR pipeline; this skill moves funds **out** of our own keys with no reviewer — hence the mandatory chain-id verification, derived-sender rule, and explicit confirmation gate.
- All resolutions (RPC, chainId, sender address, balances) happen at runtime from canonical sources (`config/networks.json`, `.env`, the chain itself). The skill body holds zero addresses and zero secrets.
- The sender address is always derived from the private key because `config/global.json` describes the *intended* deployer, not necessarily the key in the local `.env` — and on fresh networks they have diverged in practice.
