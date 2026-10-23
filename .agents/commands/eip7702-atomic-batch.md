---
name: eip7702-atomic-batch
usage: /eip7702-atomic-batch --config <path.json> [--broadcast]
description: "Runs contract calls atomically as an EOA via an EIP-7702 sponsored tx: a sponsor pays, the EOA only signs an authorization, which also rescues gas-starved or sweeper-drained keys. Use for \"atomic EOA batch\" / \"tx from a compromised key\". Not for Tron (`interact-tron`) or Safe/timelock flows."
---

# EIP-7702 Atomic Batch (sponsored EOA execution)

Engine: `script/tasks/atomicBatch7702.ts`; this document is the policy around it.

The EOA (authority) is delegated to canonical Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) and its `aggregate3` runs each call with `msg.sender == authority`, reverting all on any failure. The sponsor signs and pays; a separate authority signs only an off-chain authorization, so it needs no native balance and there is no funding tx to front-run. That is why it works for a compromised key whose gas is swept on arrival: no gas lands, the sweeper bot stays idle, and the authority sends no tx of its own, so its nonce doesn't move before the sponsored tx is mined and the authorization stays valid (applying it then increments the nonce).

## When to use / skip

Use for: one privileged call from a key that can't hold gas (`transferOwnership`, `renounceRole`, `approve`); several calls that must land together from one EOA (approve→pull, transfer→register, migrate→verify); gasless execution for an EOA we control.

Skip for:

- Tron → `interact-tron`.
- Chains without EIP-7702 live (it is live on Ethereum and most L2s post-Pectra: arbitrum, polygon, bsc, base, optimism, …). The dry-run's estimate surfaces this; fall back to funding the EOA, or an MEV-protected bundle if a sweeper is the problem.
- Governance actions — never route Safe + Timelock work through a private 7702 tx. Keys we hold directly only.
- A single call from a funded, uncompromised EOA — send a normal tx.

## Usage

```bash
# dry-run (default): simulates, signs the auth, estimates the type-4 tx, sends nothing
NODE_PATH=./node_modules bunx tsx script/tasks/atomicBatch7702.ts --config ./batch.json

NODE_PATH=./node_modules bunx tsx script/tasks/atomicBatch7702.ts --config ./batch.json --broadcast
```

RPC: `ETH_NODE_URI_<NETWORK>` first, else `networks.json` `rpcUrl`. `--keep-delegation` skips the automatic undelegate — only with an access-restricted delegate meant to persist, never Multicall3.

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
- `sponsorKeyEnv` — key that pays (default `PRIVATE_KEY_PRODUCTION`).
- `authorityKeyEnv` — EOA the calls run as. Omit it (or set it equal to `sponsorKeyEnv`) for a self-batch; the engine then signs with `executor: 'self'`.
- `delegate` — optional, defaults to Multicall3 (hardcoded in the engine). Override only with an audited delegate.
- `calls[]` — `{ target, function, args }` or `{ target, data }`, executed atomically in order.

## Choosing the delegate (decide with the user before broadcasting)

Multicall3's `aggregate3` has no access control: while an EOA is delegated to it, anyone can execute arbitrary calls as that EOA.

| | Multicall3 (default) | Custom restricted executor |
|---|---|---|
| Setup | none, same address on every chain | write + audit + deploy |
| Access control | none | `msg.sender == sponsor` or signature check |
| Safe to leave delegated? | No | Yes |
| Best for | empty / throwaway / already-compromised keys, with auto-undelegate | funded or privileged accounts, persistent delegation |

- Empty / compromised / throwaway account, one-shot batch → Multicall3 + auto-undelegate (the EXSC-660 case).
- Account holds funds or privileges, or delegation should persist → not Multicall3. A restricted executor is a new Solidity contract needing its own audit gate — flag as follow-up. If none exists yet, stop and surface the tradeoff.

## Engine behaviour

1. Resolves chain/RPC, sponsor, and authority.
2. Builds `aggregate3` with `allowFailure: false`.
3. Signs the 7702 authorization (`executor: 'self'` only for self-batch).
4. Simulates the whole authorized `aggregate3` as one call with the delegation applied — per-call simulation against pre-batch state would wrongly fail dependent batches like approve→deposit. Aborts before spending on revert; any other simulation error (e.g. an RPC that can't `eth_call` a 7702 tx) only warns.
5. Estimates the type-4 tx — the live check that the chain accepts EIP-7702. A failed estimate only warns and does not block `--broadcast`, so a clean dry-run needs both ✓ lines.
6. `--broadcast`: sends one sponsor-paid type-4 tx and reports success/revert. Re-running re-simulates but is not idempotent — a successful batch repeats its effects.
7. Auto-undelegates after any mined batch, success or revert (the delegation is applied before execution and not rolled back): a second sponsored tx authorizes the zero address, then verifies `getCode == 0x`.

## Safety

- The calls themselves may be irreversible (OZ single-step `transferOwnership`). Review the batch; rely on the dry-run.
- Public-mempool front-running (critical for funded authorities): the authorization binds authority, delegate, nonce, and signature, not the sponsor. Anyone can lift it from a pending tx and land their own sponsored tx first — with open Multicall3, executing arbitrary calls as the authority. Safe for an empty authority; for a funded or privileged one, don't `--broadcast` publicly — use protected orderflow / a private bundle and/or a restricted executor.
- Between the batch tx and the undelegate tx, an open Multicall3 delegation is drivable by anyone — another reason it's only for accounts holding nothing.
- Undelegating doesn't make a leaked key safe; the holder can re-delegate. The durable fix is that the account no longer owns or holds anything.
- Never point `delegate` at an unaudited or attacker-controlled contract. Verify Multicall3 with `cast code` on an unfamiliar chain.
- Keys come from `.env` and are never printed; a compromised authority key only signs the authorization.

## Worked example — EXSC-660

The production `ERC20Proxy` on arbitrum/bsc/polygon was owned by a compromised legacy deployer (`_OLD_V1`) whose gas a bot swept on arrival, so fund-then-`transferOwnership` lost every race (even on Arbitrum, whose sequencer feed lets the bot react). The config above transferred ownership to `refundWallet` in one deployer-paid tx with nothing fundable on `_OLD_V1`.

viem refs: [sending 7702 txs](https://viem.sh/docs/eip7702/sending-transactions), [signAuthorization](https://viem.sh/docs/eip7702/signAuthorization).
