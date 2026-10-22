---
name: check-rotation-status
description: "Read-only check that a wallet rotation landed on EVM chains (Safe owners, CANCELLER_ROLE, whitelist, staging owner(), funding); final gate of every rotate-* skill. Use for \"is the rotation done\" / \"check offboarding status\". Its script does not exist yet. Performing a rotation → rotate-*."
usage: /check-rotation-status --old-address 0xOLD --new-address 0xNEW [--role deployer|dev|pauser] [--removed-signer 0x] [--network <csv>] [--production]
---

# Check Rotation Status

Confirms on-chain, per active network, that a rotation landed (not just that PRs merged):

- Safe owners — old signer removed, new added.
- Timelock `CANCELLER_ROLE` — old deployer revoked, new granted (deployer).
- Whitelist permission (`AccessManagerFacet.addressCanExecuteMethod`) — old deployer's authority removed, whitelisting moved to the multisig.
- Staging diamond `owner()` — matches the current dev wallet from config.
- Wallet funding — the new wallet has gas on each chain (the CI funding check).

Only `view`/`call` reads; never signs, broadcasts, or edits config. Never assert "rotation complete" on refund / feeCollector / withdraw (CTO-owned, not rotated).

## The missing checker

`script/tasks/checkRotationStatusPerNetwork.ts` does not exist yet. If it is still missing, do not write it during a rotation — an improvised gate is unreviewed code deciding whether governance changes landed. Tell the user it must land as its own reviewed PR (spec below), report every applicable check as "not run", and the calling rotate-* skill treats its gate as open. Do not run the `temp/` file with edited constants either.

Spec: `script/tasks/temp/checkOffboardingStatusPerNetwork.ts` already has the read logic (`getOwners`, `hasRole`, `addressCanExecuteMethod`, staging `owner()`), the parallel fan-out, the `tron`/`tronshasta` exclusion, and the pass/fail table, but hardcodes its addresses (`OLD_DEPLOYER`, `NEW_DEPLOYER`, `MICHAL_SAFE_SIGNER`, `OLD_SC_DEV_WALLET`, `NEW_SC_DEV_WALLET`). The permanent script copies that logic (keep the `temp/` file as reference) and replaces the constants with camelCase citty flags:

- `--oldAddress`, `--newAddress` (required).
- `--role` — `deployer` (default, full column set) | `dev` (staging owner + funding) | `pauser` (funding + config).
- `--removedSigner` — extra departing Safe signer to assert removed (offboarding).
- `--network` — restrict; default all active.
- `--json` — machine-readable output for orchestrators.

Wrap address flags in viem `getAddress()` at parse time: a wrong-but-well-formed address reads as "old already removed" and falsely passes. Keep the Tron exclusion and premium-RPC-first resolution (`getRPCEnvVarName` → `ETH_NODE_URI_<NETWORK>`, fallback `networks.json`). Exit codes: `0` all applicable checks pass on reachable networks; `1` a check failed on a reachable network; `2` recoverable misconfig (name the missing RPC var). Tron exclusions and genuinely absent staging diamonds are not failures.

## Run

```bash
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

bunx tsx script/tasks/checkRotationStatusPerNetwork.ts \
  --oldAddress 0xOLD --newAddress 0xNEW --role deployer
```

Add `--removedSigner`, `--network`, or `--json` as needed. Output: per-network matrix plus `✅ completed / ❌ incomplete / ❓ errors` summary.

## Interpret

- All applicable columns ✅ on every reachable network → complete for that role.
- ❌ → not landed there; name network + column and hand back to the owning rotation step — don't fix it here.
- ❓ → RPC problem, not a failure and never a pass. Re-run with a premium `ETH_NODE_URI_<NETWORK>`; still unreachable → report unverified.
- `-` (`tron`/`tronshasta`) → not covered. Tron completeness comes from `move-tron-delegation` evidence and the Tron ownership read; say so.

Claim "rotation complete" only when every applicable check is ✅ on every reachable network and the Tron side is confirmed separately. Otherwise list what remains and which skill owns it.
