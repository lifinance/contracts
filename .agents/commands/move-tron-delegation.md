---
name: move-tron-delegation
description: Move Tron staked-resource (energy/bandwidth) delegation from a rotated-OUT wallet's Tron address to the new wallet's Tron address during a wallet rotation. There is NO repo tooling for this and the delegation is delegator-controlled — the actual undelegate/re-delegate is executed off-repo by the resource-provider wallet holder (Max), not by this skill or any of our keys. This skill derives old+new Tron base58 addresses, drafts the exact move request for the provider, then AFTER the provider executes it verifies on Tronscan (new address shows the energy, old shows 0) and ensures `config/global.json` `tronWallets` is updated. Use when the user says "move the tron energy delegation", "re-delegate tron energy to the new wallet", "hand off the tron staked resources during the rotation", or similar. NOT for moving the Tron DIAMOND ownership to the Timelock — that is `transfer-ownership-to-timelock.ts`, owned by `rotate-deployer-wallet`. NOT an on-chain broadcast from our keys — this skill never signs a delegation tx. Requires `bun` (troncast) and a Tronscan lookup. Reference EXSC-562, which documents this step.
usage: /move-tron-delegation --old-address 0xOLD --new-address 0xNEW [--role dev|deployer]
---

# Move Tron Delegation

## Purpose

During an SC-wallet rotation (dev / deployer), the rotated-OUT wallet's Tron
address is the recipient of staked-resource **delegation** (energy, and
sometimes bandwidth) from a separate resource-provider wallet. Deploying and
operating on Tron consumes energy; without a delegation the new wallet would
have to burn TRX for every transaction. This skill moves that delegation from
the old wallet's Tron address to the new one so the new wallet inherits the
free energy the old one had.

The move itself is **not something this repo or our keys can do.** Tron
resource delegation is controlled by the *delegator* — the wallet that staked
the TRX and delegated the resulting energy. That wallet is held by the
resource provider (Max), off-repo. This skill's job is the parts we own:
derive the correct addresses, draft an unambiguous request, and verify the
result on-chain afterward.

See EXSC-562 for the ticket that documents this delegation-handoff step.

## When to use / when NOT

Use when the user says any of:

- "move the tron energy delegation to the new wallet"
- "re-delegate tron energy / bandwidth to the new <dev|deployer> wallet"
- "hand off the Tron staked resources as part of the rotation"

Called as a phase by `rotate-dev-wallet` and `rotate-deployer-wallet`.

Do NOT use for:

- **Tron diamond ownership → Timelock.** Moving the Tron LiFiDiamond's
  `owner()` to the Timelock is a different, on-chain action performed with
  `bunx tsx script/deploy/tron/transfer-ownership-to-timelock.ts` and is owned
  by `rotate-deployer-wallet` (staging equivalent runs against `tronshasta`).
  Delegation ≠ ownership — do not conflate them.
- **Signing a delegation transaction from our keys.** We are the delegatee,
  not the delegator. If someone asks this skill to broadcast the delegation,
  stop and explain that only the provider wallet can.
- **Non-Tron chains.** EVM native gas is handled by `sweep-wallet-funds`.

## Inputs

Required:

- **--old-address** — `0x…` EVM address of the rotated-OUT wallet (dev or
  deployer). Its Tron base58 is derived below, never trusted from config.
- **--new-address** — `0x…` EVM address of the new wallet.

Optional:

- **--role** — `dev` or `deployer`, for the request text and the
  `update-wallet-config` follow-up. Ask once if unclear.
- **resources** — `energy`, `bandwidth`, or both. Default: energy. Confirm the
  actual delegated amount from Tronscan in Step 3 rather than assuming.

Derive the old wallet's address from the private key or the user-supplied
value — **never** read it from `config/global.json`, which can be
mid-rotation-inconsistent (a documented trap).

## Guardrails

- **Custody guard.** Only the SC-owned wallets are ever rotated: **deployer,
  dev, pauser**. NEVER move delegation associated with refund / feeCollector /
  withdraw wallets — those are CTO-owned. If the old address maps to one of
  those, stop.
- **We never sign the delegation.** The undelegate + re-delegate is executed by
  the provider (Max) with the delegator wallet, off-repo. This skill drafts and
  verifies only. Do not attempt `troncast send` or any broadcast for the move.
- **Never bypass Safe/timelock** for the ownership half of the Tron rotation —
  that stays with `transfer-ownership-to-timelock.ts` / `multisig-rollout`.
- **Secrets hygiene.** troncast address conversion is offline but still needs a
  dummy RPC env (`ETH_NODE_URI_TRON`). Never print a private key or a full RPC
  URL. Derive the old Tron address from the old EVM address, not from config.
- **`--check` / dry-run.** This skill is inherently read-only on our side: it
  produces a request document and a verification report and changes nothing
  on-chain. Address derivation (Step 1) is the dry-run — run it and show the
  base58 pair before drafting anything.

## Workflow

### 1. Derive both Tron base58 addresses (dry-run — verify before drafting)

`troncast address` conversion is offline but aborts without an RPC env, so
prefix a dummy URL. Convert both EVM addresses and cross-check each with the
reverse conversion so a typo can't slip through.

```bash
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

OLD_EVM="<oldWalletEvmAddress>"
NEW_EVM="<newWalletEvmAddress>"

OLD_TRON=$(ETH_NODE_URI_TRON="https://dummy" bun troncast address to-base58 "$OLD_EVM")
NEW_TRON=$(ETH_NODE_URI_TRON="https://dummy" bun troncast address to-base58 "$NEW_EVM")

# reverse-check: to-hex of each base58 must return the original EVM address
ETH_NODE_URI_TRON="https://dummy" bun troncast address to-hex "$OLD_TRON,$NEW_TRON"
```

`troncast address` uses **kebab-case** subcommands (`to-base58`, `to-hex`) and
takes the address as a positional argument; comma-separate to convert several
at once. If the reverse `to-hex` does not return the original EVM address for
either, stop — an input is wrong.

Show the derived pair to the user before proceeding:

```text
Old (rotated-out) : <OLD_EVM>  =  <OLD_TRON>
New               : <NEW_EVM>  =  <NEW_TRON>
```

### 2. Read the current delegation on the old address (evidence, not assumption)

Look up the OLD Tron address on Tronscan and record the actual delegated
resource so the request quotes a real number rather than a guess:

- Tronscan → `https://tronscan.org/#/address/<OLD_TRON>` → **Resources** tab →
  the energy/bandwidth **delegated to this address** (and by which delegator).

Note the delegator address, the resource type(s), and the amount. If nothing is
delegated to the old address, there is nothing to move — report that and stop
(the rotation does not need this step for that role).

### 3. Draft the delegation-move request for the provider

Produce a short, unambiguous message for the resource-provider wallet holder
(Max). It must name both Tron base58 addresses, the resource type, and the
amount observed in Step 2. Template:

```text
Tron resource delegation move (rotation EXSC-<ticket>, role: <dev|deployer>)

Please move the staked-resource delegation from our old wallet to the new one:

  UNDELEGATE  ~<N> <energy|bandwidth>  FROM  <OLD_TRON>
  RE-DELEGATE the same               TO    <NEW_TRON>

Delegator wallet (yours): <delegator T-address from Step 2>
This is delegatee-side only; we cannot execute it from our keys.
Ping here once done and I'll verify on Tronscan.
```

Hand this to the user to relay (or post per the rotation's coordination
channel). This skill does not send it anywhere itself unless the user asks.

### 4. WAIT for the provider to execute — do not proceed on assumption

The move happens off-repo. Pause here until the provider confirms it is done.
Do not fabricate a completion, and do not mark the rotation's Tron step
complete until Step 5 passes on-chain.

### 5. Verify the move on-chain (Tronscan)

After the provider confirms, verify both sides on Tronscan:

- **New address gained the resource:**
  `https://tronscan.org/#/address/<NEW_TRON>` → Resources → shows the expected
  energy/bandwidth delegated in from the provider.
- **Old address is drained:**
  `https://tronscan.org/#/address/<OLD_TRON>` → Resources → shows **0** of that
  delegation remaining.

Both must hold. If the new address shows the energy but the old still shows a
residual, the undelegate half is incomplete — report it and re-request; do not
call the step done.

### 6. Ensure `tronWallets` is updated

The config side of the Tron rotation (updating `config/global.json`
`tronWallets.<role>` to the new base58) is owned by `update-wallet-config`. If
that PR has not already landed as part of the rotation, invoke
`/update-wallet-config` for this role now so the repo's recorded Tron address
matches the wallet that now holds the delegation. Derive the base58 there via
the same `troncast` conversion — do not trust a possibly-stale `global.json`.

## Verification

Report the outcome explicitly — do not claim success without the Step 5
evidence:

- Derived base58 pair (Step 1) with reverse-check passing.
- Delegator, resource type, amount observed on the old address (Step 2).
- Tronscan confirmation that NEW shows the delegation and OLD shows 0 (Step 5).
- Whether `tronWallets.<role>` now reflects the new base58 (Step 6), or that
  the `update-wallet-config` PR is still pending.

If any of these is unmet, state which and that the Tron delegation step of the
rotation is NOT complete.

## Reuse map

- `troncast address to-base58 / to-hex` — offline EVM↔Tron address conversion
  (needs a dummy `ETH_NODE_URI_TRON`; kebab-case). See `script/troncast/README.md`.
- `update-wallet-config` — lands the `tronWallets.<role>` config change (Step 6).
- `transfer-ownership-to-timelock.ts` — the SEPARATE Tron diamond-ownership
  move; owned by `rotate-deployer-wallet`, explicitly not this skill.
- `rotate-dev-wallet` / `rotate-deployer-wallet` — the rotations that invoke
  this skill as their Tron-delegation phase.
