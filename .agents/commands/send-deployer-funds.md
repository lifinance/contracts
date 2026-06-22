---
name: send-deployer-funds
usage: /send-deployer-funds
description: Send a chain's gas asset directly from one of our own wallets (deployer keys in `.env`) to a specified recipient on a specified network via `cast send` — native `--value`, or an ERC-20 `transfer()` when the gas asset is an ERC-20 predeploy (e.g. arc, where USDC is gas). Parses a natural-language request with an absolute amount ("send 0.1 ETH to 0xabc… on base") or a relative amount ("send 10% of our holdings on outlaw to 0xf79…"), resolves the network RPC from `config/networks.json` with an `ETH_NODE_URI_<NETWORK>` fallback, derives the sender address from the private key (never from `config/global.json`), verifies chain-id, shows a pre-send report, and verifies balances after sending. Use when the user says "send funds", "send gas", "transfer ETH from the deployer", "/send-deployer-funds …", or otherwise asks to move gas funds FROM our own wallet. NOT for requesting funds INTO our wallets — that is `request-dev-funds` (PR-based, from the automate-wallet). Requires `cast` (Foundry), `jq`, and `bc`. EVM only. Only on an explicit user request — never invoke proactively, and the pre-send report must be confirmed by the human user.
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
- The user wants to send an ERC-20 token that is **not** the chain's gas asset → out of scope (this skill moves gas only). Say so and stop. The chain's gas asset is in scope even when it is an ERC-20 predeploy (e.g. arc) — Step 1 detects that and switches mechanism.
- The target chain is non-EVM (Solana / TRON / BTC / SUI) → unsupported. Say so and stop.
- No explicit user instruction to send funds exists in the current conversation (see Authorization below).

## Authorization (explicit user request + human review, non-negotiable)

This skill moves real funds with no reviewer pipeline behind it, so two hard rules apply on top of the confirmation gate:

- **Explicit user request only.** Run this skill solely when the user has explicitly asked, in the current conversation, to send these funds. Never invoke it proactively as a sub-step of another flow (deployment, network setup, troubleshooting, "the target wallet needs gas") — in those cases, state that funds need to be moved and let the user decide whether to invoke this skill.
- **Human review of every send.** The pre-send report (Step 5) must be reviewed and confirmed by the human user. An agent or sub-agent must never answer the confirmation prompt itself, batch-approve sends, or treat a broad task description ("get the deployment working") as standing permission.

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

- **amount** — either absolute in human-readable gas-asset units ("0.1 ETH", "2 USDC on arc", "0.05") or relative ("10% of our holdings", "half the balance").
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

In the fallback case there is no chainId in the checked-out `networks.json` — obtain the expected chainId before proceeding, in this order:

1. The in-flight branch's config, if the network's `deploy-network-<name>` branch exists locally:

   ```bash
   EXPECTED_CHAIN_ID=$(git show "deploy-network-${NETWORK}:config/networks.json" 2>/dev/null | jq -r --arg n "$NETWORK" '.[$n].chainId // empty')
   ```

2. Otherwise ask the user for the expected chainId (validate it is a positive integer).

**Never send without a chainId expectation** — skipping the verification in the fallback case defeats its purpose, since fresh networks are exactly where a stale or mistyped RPC env var is most likely.

Then verify the RPC actually serves that chain:

```bash
ACTUAL_CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
[[ "$ACTUAL_CHAIN_ID" == "$EXPECTED_CHAIN_ID" ]] || { echo "chain-id mismatch: expected $EXPECTED_CHAIN_ID, got $ACTUAL_CHAIN_ID"; exit 1; }
```

On mismatch, stop and surface both values — do not proceed.

### 1b. Determine the transfer mode (native vs ERC-20-predeploy gas asset)

On most chains the gas asset is the true EVM native balance, moved with `cast send --value`. On a few, the gas asset is an **ERC-20 predeploy** and the native value path is inactive — `--value` would move nothing, so the gas asset must be moved with `transfer(address,uint256)` on the predeploy (e.g. arc / Circle Arc: `nativeCurrency` `USDC`, `nativeAddress` `0x3600000000000000000000000000000000000000`).

Decide the mode from `config/networks.json` `nativeAddress`:

```bash
NATIVE_ADDR=$(jq -r --arg n "$NETWORK" '.[$n].nativeAddress // empty' config/networks.json)
SENTINEL_RE='^0x(0{40}|[eE]{40}|[eE]eee[eE]{35}|0{39}1)$'   # zero / 0xEeee… / wrapped-dummy
if [[ -n "$NATIVE_ADDR" && ! "$NATIVE_ADDR" =~ $SENTINEL_RE ]]; then
  TRANSFER_MODE="erc20-predeploy"; GAS_TOKEN="$NATIVE_ADDR"
else
  TRANSFER_MODE="native"
fi
```

A non-sentinel `nativeAddress` means predeploy mode — **confirm via the network's `devNotes`** (they state the native path is inactive) before treating it as such. In predeploy mode, read the token metadata up front (used for amount math, the report, and verification):

```bash
DECIMALS=$(cast call "$GAS_TOKEN" "decimals()(uint8)" --rpc-url "$RPC")
SYMBOL=$(cast call "$GAS_TOKEN" "symbol()(string)" --rpc-url "$RPC")
```

All later steps branch on `$TRANSFER_MODE`. Native mode is unchanged from earlier versions.

### 2. Resolve the sender from `.env` (derive, never look up)

Key selection follows the same convention as `getPrivateKey()` in `script/helperFunctions.sh`:

- `production` (default) → `PRIVATE_KEY_PRODUCTION`
- `staging` → `PRIVATE_KEY`

**Always derive the sender address from the key itself** — inside a subshell, without echoing the key:

```bash
if [[ "$ENVIRONMENT" == "staging" ]]; then KEY_VAR="PRIVATE_KEY"; else KEY_VAR="PRIVATE_KEY_PRODUCTION"; fi
SENDER=$(set +x; KEY=$(grep -E "^${KEY_VAR}=" .env | cut -d= -f2- | tr -d '"'); cast wallet address --private-key "$KEY")
```

Do **NOT** use `config/global.json`'s `deployerWallet` for the sender address or for balance checks — the key and the config can diverge, and checking the wrong address makes a funded wallet look empty (or vice versa). Don't assume — derive.

If the env var is missing from `.env`, stop and tell the user which variable is missing — never fall back to another key silently.

### 3. Validate the recipient address

- Must match `^0x[0-9a-fA-F]{40}$`.
- If mixed-case, run EIP-55 checksum validation (`cast to-check-sum-address "$RECIPIENT"` and compare); **refuse on mismatch** and ask the user to re-paste. If all-lowercase or all-uppercase, accept as-is and skip the checksum comparison.
- Sanity flag (warn, don't block): recipient equal to the sender, or to the zero address — surface it and ask.

### 4. Compute the amount in base units

Read both pre-send balances first and keep them — the post-send verification (Step 7) reports the deltas. Amounts and balances are always in the gas asset's **base units** (wei for native; `10^DECIMALS` for predeploy). Do all arithmetic via `bc` — values overflow bash's 64-bit integers.

**Native mode:**

```bash
BALANCE=$(cast balance "$SENDER" --rpc-url "$RPC")
RECIPIENT_BALANCE_BEFORE=$(cast balance "$RECIPIENT" --rpc-url "$RPC")
# absolute: AMOUNT=$(cast to-wei "0.1" ether)
# relative: AMOUNT=$(echo "$BALANCE * 10 / 100" | bc)
GAS_PRICE=$(cast gas-price --rpc-url "$RPC")
GAS_COST=$(echo "21000 * $GAS_PRICE * 2" | bc)   # 2x safety margin
```

**ERC-20-predeploy mode:** balances come from `balanceOf`, and the gas asset's own balance pays the gas — so the headroom check applies to `balanceOf`, not a separate native balance.

```bash
BALANCE=$(cast call "$GAS_TOKEN" "balanceOf(address)(uint256)" "$SENDER" --rpc-url "$RPC" | awk '{print $1}')
RECIPIENT_BALANCE_BEFORE=$(cast call "$GAS_TOKEN" "balanceOf(address)(uint256)" "$RECIPIENT" --rpc-url "$RPC" | awk '{print $1}')
# absolute: AMOUNT=$(echo "2 * (10 ^ $DECIMALS)" | bc)            # 2 USDC @ 6dp = 2000000
# relative: AMOUNT=$(echo "$BALANCE * 10 / 100" | bc)
# Gas is charged against the same token balance. Chains that price gas in 18-dp wei but
# settle it in a DECIMALS-dp token (arc) convert 1:1 by value, so scale the wei estimate down:
GAS_PRICE=$(cast gas-price --rpc-url "$RPC")
GAS_LIMIT=$(cast estimate "$GAS_TOKEN" "transfer(address,uint256)" "$RECIPIENT" "$AMOUNT" --from "$SENDER" --rpc-url "$RPC")
GAS_COST=$(echo "$GAS_LIMIT * $GAS_PRICE * 2 / (10 ^ (18 - $DECIMALS))" | bc)   # 2x margin, scaled to token dp
```

Common to both: the send must leave enough for its own gas.

```bash
MAX_SENDABLE=$(echo "$BALANCE - $GAS_COST" | bc)
if [[ $(echo "$AMOUNT > $MAX_SENDABLE" | bc) -eq 1 ]]; then
  # relative amount → cap at MAX_SENDABLE; absolute amount → refuse and report the shortfall
  ...
fi
```

If predeploy gas-cost scaling is uncertain on a new chain, `cast send` pre-flights the balance and fails **without broadcasting** (costing nothing) — so an underestimate is safe, never a silent overspend.

### 5. Pre-send report + explicit confirmation

Render a one-block summary and require explicit confirmation before broadcasting. Always state the **mechanism** so a predeploy send is never mistaken for a native one.

Native mode:

```text
⚠️  About to broadcast a REAL native transfer. This is irreversible.

  Network:            outlaw  (chainId 4663 — verified via cast chain-id)
  Mechanism:          native  (cast send --value)
  RPC source:         ETH_NODE_URI_OUTLAW            (URL not shown — may embed API key)
  Sender:             0x492E267321E863fA45Bc9d97c9f64Fa9Df70d4c4  (derived from PRIVATE_KEY_PRODUCTION)
  Sender balance:     980845853615340000 wei  (0.98084585… ETH)
  Recipient:          0xf79…                        (current balance: 0 wei)
  Amount:             98084585361534000 wei  (0.09808458… ETH — 10% of holdings)
  Est. gas headroom:  ~42000000000000 wei reserved

Proceed? (yes/no)
```

ERC-20-predeploy mode:

```text
⚠️  About to broadcast a REAL ERC-20 gas-asset transfer. This is irreversible.

  Network:            arc  (chainId 5042 — verified via cast chain-id)
  Mechanism:          ERC-20 predeploy  (transfer() on 0x3600…0000, NOT --value)
  RPC source:         ETH_NODE_URI_ARC               (URL not shown — may embed API key)
  Sender:             0xb137…E269                    (derived from PRIVATE_KEY_PRODUCTION)
  Gas asset:          USDC  (6 decimals)
  Sender balance:     27693729  (27.693729 USDC — via balanceOf)
  Recipient:          0xd387…57Ee                    (current balance: 2000 = 0.002 USDC)
  Amount:             2000000  (2 USDC)
  Note:               gas is also paid from this USDC balance

Proceed? (yes/no)
```

Accept only `yes`, `proceed`, or `confirm` (case-insensitive); reject bare `y` and re-ask. Even if the invoking prompt sounds like consent ("go ahead and send 0.1 ETH…"), still render the report and still wait for the explicit acknowledgement.

### 6. Send

**One broadcast per tool call — never loop `cast send`.** Run each transfer as its own separate tool invocation, even when the user asked for several at once. A loop that iterates `cast send` inside a single tool call can land a broadcast mid-iteration if that call is interrupted or rejected — leaving real funds moved with no captured tx hash. One tool call = one signed transfer = one `TX_HASH` recorded and verified before the next.

Build the `cast send` argument list by mode, then broadcast once. Native mode sends `--value`; predeploy mode calls `transfer(address,uint256)` on the gas-token contract.

```bash
if [[ "$TRANSFER_MODE" == "erc20-predeploy" ]]; then
  SEND_ARGS=("$GAS_TOKEN" "transfer(address,uint256)" "$RECIPIENT" "$AMOUNT")
else
  SEND_ARGS=("$RECIPIENT" --value "$AMOUNT")
fi
SEND_OUTPUT=$( (set +x; KEY=$(grep -E "^${KEY_VAR}=" .env | cut -d= -f2- | tr -d '"'); \
  cast send "${SEND_ARGS[@]}" --private-key "$KEY" --rpc-url "$RPC") \
  2>&1 | grep -vE 'private|PRIVATE|key' | sed "s|$RPC|<rpc>|g" )
echo "$SEND_OUTPUT"

TX_HASH=$(echo "$SEND_OUTPUT" | grep -E '^transactionHash' | grep -oE '0x[0-9a-fA-F]{64}' | head -n1)
[[ -n "$TX_HASH" ]] || { echo "could not extract tx hash from cast send output"; exit 1; }
```

Anchor the tx-hash grep to `^transactionHash` (the receipt field). A loose `grep -i transactionHash` also matches the `logs` JSON, whose event topics are 32-byte `0x…` values — `head -n1` then captures a log topic instead of the real hash. This matters most in predeploy mode, where a `Transfer` event is always present.

The subshell keeps the key out of the calling shell's state; the filter strips any line mentioning the key and redacts the RPC URL from the printed output. `cast send` also prints the receipt `status` — check it here and again in Step 7.

### 7. Post-send verification

- Confirm the receipt has `status 1` (`cast receipt "$TX_HASH" status --rpc-url "$RPC"` if not already shown by `cast send`).
- Re-read both balances **the same way Step 4 read them** (native → `cast balance`; predeploy → `balanceOf`) and report the deltas against the saved before-values:

```bash
if [[ "$TRANSFER_MODE" == "erc20-predeploy" ]]; then
  SENDER_AFTER=$(cast call "$GAS_TOKEN" "balanceOf(address)(uint256)" "$SENDER" --rpc-url "$RPC" | awk '{print $1}')
  RECIPIENT_AFTER=$(cast call "$GAS_TOKEN" "balanceOf(address)(uint256)" "$RECIPIENT" --rpc-url "$RPC" | awk '{print $1}')
else
  SENDER_AFTER=$(cast balance "$SENDER" --rpc-url "$RPC")
  RECIPIENT_AFTER=$(cast balance "$RECIPIENT" --rpc-url "$RPC")
fi
```

Report to the user: tx hash, status, sender balance `$BALANCE` → `$SENDER_AFTER`, recipient balance `$RECIPIENT_BALANCE_BEFORE` → `$RECIPIENT_AFTER` (deltas via `bc`). The recipient delta should equal `$AMOUNT` exactly; the sender delta is `$AMOUNT` + gas.

## Failure modes

- **`cast` missing** → tell the user to install Foundry (`foundryup`); do not substitute another tool. **`bc` missing** → tell the user to install it; do not fall back to bash integer arithmetic (overflows on wei values).
- **Env var (key or RPC) missing from `.env`** → name the missing variable and stop. Never guess or fall back silently.
- **Chain-id mismatch** → stop, show expected vs. actual. The RPC is pointing at the wrong chain.
- **Checksum mismatch on recipient** → refuse, ask for a re-paste.
- **Insufficient balance for amount + gas** → report balance, requested amount, and estimated gas; ask whether to reduce.
- **`cast send` reverts or receipt status 0** → report the tx hash and status; do not retry automatically.
- **RPC flaky/unreachable** → surface the error (with the URL redacted) and stop.
- **`nativeAddress` is an ERC-20 predeploy** (native value path inactive, e.g. arc) → switch to predeploy mode (Step 1b): move the gas asset with `transfer()`, never `--value`. Get `DECIMALS` right (`cast call … decimals()`) — a wrong exponent over/under-sends by orders of magnitude.

## Out of scope (v1)

- ERC-20 transfers of any token that is **not** the chain's gas asset (this skill moves gas only). The gas asset itself is in scope even as an ERC-20 predeploy (Step 1b).
- Non-EVM chains.
- Atomic/batched broadcasts (multiple transfers in one tool call or one tx). Multiple sends are allowed but handled **one transfer per tool call**, each individually confirmed — see Step 6.
- Sending from any key other than the `.env` deployer keys (`PRIVATE_KEY_PRODUCTION` / `PRIVATE_KEY`).

## Design notes

- Direction matters: `request-dev-funds` moves funds **into** our wallets via a reviewed PR pipeline; this skill moves funds **out** of our own keys with no reviewer — hence the mandatory chain-id verification, derived-sender rule, and explicit confirmation gate.
- All resolutions (RPC, chainId, sender address, balances) happen at runtime from canonical sources (`config/networks.json`, `.env`, the chain itself). The skill body holds zero addresses and zero secrets.
- The sender address is always derived from the private key because `config/global.json` describes the *intended* deployer, not necessarily the key in the local `.env`.
- "Gas asset", not "native token": on most chains they coincide (`--value`), but on predeploy-gas chains (arc) the gas asset is an ERC-20. The skill moves whatever the chain charges gas in, picking the mechanism from `nativeAddress` — so "send gas to the pauser" works uniformly across both.
