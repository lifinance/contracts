---
name: sweep-wallet-funds
description: "Sweeps all native gas from a rotated-out SC wallet (deployer/dev/pauser) to its replacement on every active EVM chain via `moveNativeFundsToNewWallet.ts` — the funding step of every rotate-* skill. Use for \"sweep the old wallet to the new one\". One-off single-chain send → `manage-wallet-funds`."
usage: /sweep-wallet-funds --new-address 0xNEW [--old-key-env PRIVATE_KEY_PRODUCTION] [--production] [--check]
---

# Sweep Wallet Funds (LI.FI Contracts)

Wraps `script/tasks/moveNativeFundsToNewWallet.ts`, which moves the native balance (minus a gas reserve) from the wallet the key controls to the new address on every active EVM chain. Changes no role or config. Funding a wallet with no old wallet to drain → `request-dev-funds` or `manage-wallet-funds send`.

## Inputs

- `--new-address` (required) — sweep destination. Missing or invalid → ask once, stop.
- `--old-key-env` — `.env` var holding the rotated-out key; maps to the script's `--privateKeyEnvKey`. Default `PRIVATE_KEY_PRODUCTION` with `--production`, else `PRIVATE_KEY`.
- `--production` — target production (default staging).
- `--check` — this skill's preview mode (Phases 0–2, no broadcast). It is NOT a script flag: the mover has no dry-run, citty silently ignores unknown flags, and the script would broadcast a live sweep.

## Guardrails

- Custody guard: only deployer / dev / pauser. Never refund / feeCollector / withdraw (CTO-owned) — stop and say so.
- Derive the source from the key (`cast wallet address`, in a subshell, never echoed), never from `config/global.json`: key and config diverge mid-rotation, and a wrong source makes a funded wallet look empty.
- Rotation ordering: run the sweep only after every move that needs the old key to sign (ownership transfers, proposal signatures) has landed — sweeping first strands the old key with no gas. (The script itself sweeps native last.)
- Human confirmation before any broadcast; an agent never self-approves.
- Never print the key or a full RPC URL; redact URLs to host or env-var name.
- Exit codes for orchestrators: `0` all targeted networks swept or cleanly skipped; `1` real error (report stderr, stop, no retry); `2` recoverable misconfig (name the missing var).

## Workflow

### Phase 0 — Preflight

From the worktree root (`export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"` if needed): `.env` has the key var (missing → exit `2`), `cast` and `bun` available, role is deployer / dev / pauser.

### Phase 1 — Derive the source

```bash
# --old-key-env wins; otherwise PRIVATE_KEY_PRODUCTION only with --production, PRIVATE_KEY for staging
FROM_KEY_VAR="${OLD_KEY_ENV:-$([ "$PRODUCTION" = "true" ] && echo PRIVATE_KEY_PRODUCTION || echo PRIVATE_KEY)}"
SOURCE=$(set +x; KEY=$(grep -E "^${FROM_KEY_VAR}=" .env | cut -d= -f2- | tr -d '"'); cast wallet address --private-key "$KEY")
```

Cross-check `SOURCE` against the role's current on-chain address. If it equals `--new-address`, the key was already rotated — nothing to sweep; stop.

### Phase 2 — Balance preview (always, before any broadcast)

The mover's only args are `--newWalletAddress`, `--privateKey`, `--privateKeyEnvKey`; never invoke it to preview. Use read-only `cast balance`:

```bash
# same selection as the mover's getAllActiveNetworks(), minus Tron (cast is EVM-only)
for NET in $(jq -r 'to_entries[] | select(.value.status == "active") | .key | select(startswith("tron") | not)' config/networks.json); do
  RPC=$(jq -r --arg n "$NET" '.[$n].rpcUrl' config/networks.json)
  BAL=$(cast balance "$SOURCE" --rpc-url "$RPC" 2>/dev/null) || BAL="RPC unreachable"
  echo "$NET: $BAL"
done
```

Render a per-network table (chain, source balance, destination). The mover's `getAllActiveNetworks()` does not exclude Tron, so list `tron`/`tronshasta` as rows "not previewable with `cast`; expected to fail in the sweep; handled manually (Phase 5)". The preview shows raw balances only — the reserve and exact amount come from the mover's internal logic; say so. Flag dust/zero chains (the script skips them) and unreachable RPCs.

### Phase 3 — Human confirmation

Require `yes` / `proceed` / `confirm` (case-insensitive; reject bare `y`). Skipped only in `--check` mode.

### Phase 4 — Sweep

Long-running (one broadcast per chain); run in the background and monitor:

```bash
bunx tsx script/tasks/moveNativeFundsToNewWallet.ts \
  --newWalletAddress "$NEW" \
  --privateKeyEnvKey "$FROM_KEY_VAR"
```

Omitting both key flags drops into an interactive prompt; use the env-key form so no key is on the command line. Filter output to strip any key line and redact RPC URLs. Per-network failures don't stop the run: collect them and offer individual retries.

### Phase 5 — Tron native (manual)

`tron`/`tronshasta` will show as failed rows in the mover's output — don't retry them. TRX has no multi-chain sweep: derive both base58 addresses (`troncast address to-base58`, see `update-wallet-config`) and hand the operator a single `troncast send` (`interact-tron`). Report Tron native as handled or pending.

## Verification

Re-read balances the same way as the preview: per network, source before → after (≈ reserve) and destination before → after. List skipped (dust) and failed (with error) chains separately. This verifies gas moved, not that roles moved — that is `check-rotation-status`.
