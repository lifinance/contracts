---
name: eip7702-atomic-batch
usage: /eip7702-atomic-batch --config <path.json> [--broadcast]
description: Run one or more contract calls atomically from an EOA via an EIP-7702 sponsored transaction — the EOA ("authority") only signs an off-chain authorization while a separate "sponsor" account pays for and sends a single type-4 tx that executes the calls with `msg.sender == authority`, all-or-nothing. Use whenever you need to (a) batch several actions that must succeed or fail together as one EOA (e.g. approve+call, transfer+register, migrate+verify), or (b) get a transaction out of an EOA that CANNOT hold gas — a gas-starved key, or a COMPROMISED key being drained by a sweeper bot — because the authority never needs a native balance and there is no funding tx for a bot to front-run. Concretely: "transfer ownership from the compromised old deployer without the sweeper stealing the gas", "the sweeper keeps taking the gas before my tx lands", "batch these calls atomically as this wallet", "sponsor a gasless tx for this EOA", "run approve then deposit in one atomic tx". EVM chains with EIP-7702 live only (Ethereum + most L2s post-Pectra: arbitrum, polygon, bsc, base, optimism, …). NOT for Tron (use `interact-tron`), and NOT a way to bypass Safe/timelock governance flows.
---

# EIP-7702 Atomic Batch (sponsored EOA execution)

Run a batch of calls **as an EOA**, atomically, with the gas paid by a **different**
account. The engine is `script/tasks/atomicBatch7702.ts`; this document is the policy
around it.

## The core idea

EIP-7702 lets an EOA temporarily adopt a contract's code via a signed authorization. We
delegate the EOA to the canonical **Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`,
deployed at that address on every EVM chain) and call its `aggregate3` — which issues each
inner call with `msg.sender == the EOA`, reverting the whole tx if any call fails.

Because the **sponsor** signs and pays for the transaction while the **authority** (the
EOA) only signs an off-chain authorization tuple:

- the authority **never needs a native balance**, and
- there is **no separate funding transaction** for anyone to observe or front-run.

That second property is what makes this the reliable way to extract a transaction from a
**compromised, actively-swept EOA**: a sweeper bot only fires when the key receives native
gas. With 7702 sponsorship no gas ever lands on the key, the bot stays idle, and the
authority's nonce stays stable so the authorization can't be invalidated underneath you.

## When to reach for this

- **Rescue / act as a key that can't hold gas.** A compromised EOA whose native is swept
  on arrival, or a key that's simply out of gas on a chain, needs to make exactly one
  privileged call (e.g. `transferOwnership`, `renounceRole`, `approve`). Sponsor it.
- **Atomic multi-step from one EOA.** Several calls that must all land in one transaction
  or not at all (approve-then-pull, transfer-then-register, migrate-then-verify).
- **Gasless UX for an EOA we control.** Sponsor pays; the EOA just signs.

## When to skip

- **Tron** → `interact-tron` (no EIP-7702; different VM/address model).
- **Chain without EIP-7702 live** → the type-4 tx won't be accepted. The engine's dry-run
  estimateGas surfaces this. Fall back to a normal tx (fund the EOA) or an MEV-protected
  bundle if a sweeper is the problem.
- **Governance actions** that must go through the Safe + Timelock — never route those
  through a private 7702 tx to dodge the flow. This skill is for keys we hold directly.
- **A single call from a well-funded, uncompromised EOA** — just send a normal tx.

## Usage

```bash
# DRY-RUN (default): simulates every call, signs the auth, estimates the type-4 tx, sends nothing
NODE_PATH=./node_modules bunx tsx script/tasks/atomicBatch7702.ts --config ./batch.json

# execute
NODE_PATH=./node_modules bunx tsx script/tasks/atomicBatch7702.ts --config ./batch.json --broadcast
```

Requires `bun`, the relevant keys in `.env`, and an RPC (resolves
`ETH_NODE_URI_<NETWORK>` first, else `networks.json` `rpcUrl`).

Flags: `--broadcast` (send; otherwise dry-run), `--config <path>`, and
`--keep-delegation` (skip the automatic undelegate — see the delegate section below).

## Config JSON

```json
{
  "network": "arbitrum",
  "sponsorKeyEnv": "PRIVATE_KEY_PRODUCTION",
  "authorityKeyEnv": "PRIVATE_KEY_PRODUCTION_OLD_V1",
  "delegate": "0xcA11bde05977b3631167028862bE2a173976CA11",
  "calls": [
    { "target": "0x5741A7FfE7c39Ca175546a54985fA79211290b51", "function": "transferOwnership(address)", "args": ["0x156CeBba59DEB2cB23742F70dCb0a11cC775591F"] }
  ]
}
```

- `network` — key in `config/networks.json`.
- `sponsorKeyEnv` — env var of the key that **pays** (default `PRIVATE_KEY_PRODUCTION`).
- `authorityKeyEnv` — env var of the EOA whose behalf the calls run on. **Omit it (or set
  it equal to `sponsorKeyEnv`) for a self-batch** where one EOA batches its own calls; the
  engine then signs with `executor: 'self'`.
- `delegate` — optional; defaults to the canonical **Multicall3**
  (`0xcA11bde05977b3631167028862bE2a173976CA11`, hardcoded in the engine). Only override
  with an audited delegate — see "Choosing the delegate" below.
- `calls[]` — each is `{ target, function, args }` (human-readable signature) **or**
  `{ target, data }` (raw calldata). Executed atomically in order.

**Self-batch example** (one wallet runs approve + deposit atomically — omit
`authorityKeyEnv`, so the sponsor *is* the authority and signs with `executor: 'self'`):

```json
{
  "network": "base",
  "sponsorKeyEnv": "PRIVATE_KEY_PRODUCTION",
  "calls": [
    { "target": "0xUSDC", "function": "approve(address,uint256)", "args": ["0xVault", "1000000"] },
    { "target": "0xVault", "function": "deposit(uint256)", "args": ["1000000"] }
  ]
}
```

## Choosing the delegate: Multicall3 vs a custom executor (decide with the user)

**Always raise this before broadcasting** — it's a security decision, not a default to
assume. `aggregate3` on Multicall3 has **no access control**: while an EOA is delegated to
it, *anyone* can call the EOA's `aggregate3` and execute arbitrary calls as that EOA. That
is acceptable **only** for an account with nothing left to lose during the delegation
window; it is dangerous for a funded/privileged one.

| | **Multicall3 (default)** | **Custom restricted executor** |
|---|---|---|
| Setup | none — deployed at the same address on every chain | must write + **audit** + deploy a contract |
| Access control | none (open) | caller-checked (`msg.sender == sponsor`) or signature-verifying |
| Safe to leave delegated? | **No** | Yes |
| Best for | empty / throwaway / already-compromised keys, **with auto-undelegate** | funded/privileged accounts, or a delegation meant to persist |

Rule of thumb to confirm with the user:

- **Account is empty / compromised / throwaway, one-shot batch** → Multicall3 + the default
  auto-undelegate is sufficient (this was the EXSC-660 case).
- **Account holds funds or privileges, or the delegation should persist** → do **not** use
  Multicall3. Use a restricted executor (flag this as a follow-up: it's a new Solidity
  contract needing its own audit gate before use on production).

If the account is funded and a restricted executor isn't available yet, **stop** and
surface the tradeoff rather than delegating it to open Multicall3.

## What the engine does

1. Resolves the chain/RPC and the sponsor + authority accounts.
2. Builds a Multicall3 `aggregate3` batch with `allowFailure: false` (atomic).
3. Signs the 7702 authorization (with `executor: 'self'` only in the self-batch shape).
4. **Simulates the whole authorized `aggregate3`** as one call, with the delegation applied
   — aborts before spending if it reverts. Simulating each call separately against
   pre-batch state would wrongly fail dependent batches (e.g. approve→deposit), which only
   succeed once `aggregate3` runs them together.
5. Estimates the type-4 tx — this is the live check that the chain accepts EIP-7702.
6. On `--broadcast`: sends the single sponsor-paid type-4 tx, waits for the receipt, and
   reports `success`/revert. Re-running re-simulates first, but is **not idempotent** — a
   successful state-changing batch repeats its effects if you run it again.
7. **Auto-undelegates** by default on any *mined* batch (success or revert — a 7702
   delegation is applied before execution and is not rolled back on revert): sends a second
   sponsored tx with the authorization pointing at the zero address, resetting the
   authority's code to empty, and verifies `getCode == 0x`. Pass `--keep-delegation` to skip
   (only when using a restricted delegate you intend to persist).

## Safety notes

- **Irreversibility is per-call.** The 7702 mechanism is safe, but the *calls* may not be
  (e.g. OZ single-step `transferOwnership` is final). Review the batch; rely on the dry-run
  simulation.
- **Public-mempool front-running of the authorization (Critical for funded authorities).**
  A signed 7702 authorization binds the authority, delegate, nonce, and signature — but
  **not the sponsor**. If you `--broadcast` into a public mempool, another actor can lift the
  authorization from your pending tx and land their own higher-fee sponsored tx first,
  applying the delegation and — with the open Multicall3 delegate — executing *arbitrary*
  calls as the authority before your batch runs. For an **empty** authority (the EXSC-660
  case) there's nothing to steal, so it's safe. For a **funded or privileged** authority,
  do **not** `--broadcast` to a public mempool: use protected orderflow / a private bundle,
  and/or a restricted executor instead of open `aggregate3` (see "Choosing the delegate").
- **Lingering delegation is auto-cleared.** By default the engine undelegates the authority
  (authorization → zero address) after any *mined* batch — success or revert, since the
  delegation isn't rolled back on revert — so no open delegate is left behind. Only pass
  `--keep-delegation` when the delegate is access-restricted and meant to persist. Note the
  brief window *between* the batch tx and the undelegate tx where an open Multicall3
  delegation is drivable by anyone — another reason Multicall3 is only for accounts that
  hold nothing during that window.
- **Compromised keys stay compromised.** Undelegating does not make a leaked-key EOA safe —
  whoever holds the key can re-delegate it. The durable protection is that the account no
  longer owns/holds anything (e.g. ownership moved to a safe wallet).
- **Never** point `delegate` at an unaudited or attacker-controlled contract.
- **Keys** are read from `.env` and never printed. The authority key for a compromised
  wallet is used only to sign the off-chain authorization.

## Worked example — the EXSC-660 sweeper case

The production `ERC20Proxy` on arbitrum/bsc/polygon was owned by a compromised legacy
deployer (`_OLD_V1`) whose native gas is swept by a bot on arrival, so the normal
fund-then-`transferOwnership` flow lost the race every time (even on Arbitrum, whose
sequencer feed lets the bot react). The sponsored 7702 batch above transfers ownership to
`refundWallet` in one deployer-paid tx with no fundable balance on `_OLD_V1` — the sweeper
never fires. See `EXSC-660`.

## References

- viem: [sending 7702 txs](https://viem.sh/docs/eip7702/sending-transactions),
  [signAuthorization](https://viem.sh/docs/eip7702/signAuthorization).
- Multicall3 is deployed at `0xcA11bde05977b3631167028862bE2a173976CA11` on all supported
  chains (verify with `cast code` before use on an unfamiliar chain).
- Related skills: `manage-wallet-funds` (fund/rebalance a wallet the normal way),
  `interact-tron` (Tron equivalent), `sweep-wallet-funds` (native sweep on rotation).
