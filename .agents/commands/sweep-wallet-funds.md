---
name: sweep-wallet-funds
description: Sweeps all native gas from a rotated-OUT SC wallet to the new wallet across every active EVM chain, via `script/tasks/moveNativeFundsToNewWallet.ts` — this is how every wallet rotation funds its replacement. Previews per-network balances first (read-only via `cast balance` — the script itself has no dry-run flag), derives the sender from the private key (never `config/global.json`), shows a human-confirmed pre-sweep report, and reports per-network moved/skipped/failed. Use when the user says "sweep the old wallet", "move the native funds to the new wallet", "drain the rotated-out deployer/dev/pauser to its replacement", or when a `rotate-*` skill needs to fund a new wallet. NOT for funding a brand-new wallet from scratch (out of scope) and NOT for sending gas to an arbitrary recipient — that is `send-deployer-funds` (single-chain, arbitrary address). Only rotates SC-owned wallets (deployer / dev / pauser); never refund / feeCollector / withdraw. Requires Foundry (`cast`), `bun`, and `jq`. EVM sweep only — Tron native is a documented manual step.
usage: /sweep-wallet-funds --new-address 0xNEW [--old-key-env PRIVATE_KEY_PRODUCTION] [--production] [--check]
---

# Sweep Wallet Funds (LI.FI Contracts)

Multi-chain native-gas sweep from a **rotated-out** SC wallet to its **new** replacement, run as the funding step of a wallet rotation. Wraps `script/tasks/moveNativeFundsToNewWallet.ts`, which iterates every active EVM chain and moves the native balance (minus a gas reserve) from the wallet the private key controls into the new address. This skill is the funding primitive that `rotate-dev-wallet`, `rotate-deployer-wallet`, and `rotate-pauser-wallet` call — it does not itself change any on-chain role or config; it only moves gas so the new wallet can operate.

## When to use / when NOT

Use when:

- "sweep the old \<role\> wallet to the new one" / "move the native funds across all chains to 0xNEW"
- A `rotate-*` skill reaches its funding step (old wallet drained → new wallet bootstrapped).
- "/sweep-wallet-funds --new-address 0xNEW"

Do NOT use when:

- The user wants to **fund a brand-new wallet from scratch** (no old wallet to drain) → out of scope; use `request-dev-funds` (PR to the automate-wallet) or a single `send-deployer-funds`.
- The user wants gas sent to an **arbitrary recipient** on a **single chain** → that is `send-deployer-funds` (explicit-request-gated, one network/recipient).
- The target role is **refund / feeCollector / withdraw** → CTO-owned, never rotated by SC tooling (see Guardrails). Stop and say so.
- The only balance to move is **Tron native** → there is no multi-chain Tron script; handle as the documented manual step below, do not fake an EVM sweep of it.

## Inputs

Required:

- **new wallet address** (`--new-address`, EVM `0x…`) — the rotation's replacement wallet; the sweep destination.

Optional:

- **old-key env var** (`--old-key-env`, default `PRIVATE_KEY_PRODUCTION` in prod / `PRIVATE_KEY` staging) — which `.env` key controls the rotated-out wallet. Maps to the script's `--privateKeyEnvKey`.
- **--production** — target production (default staging); mirrors the `.env PRODUCTION=true` double-opt-in rail. Selects the default `--old-key-env` (`PRIVATE_KEY_PRODUCTION` when set, `PRIVATE_KEY` otherwise).
- **--check** — preview-only mode of this skill (NOT a script flag): run Phases 0–2 (balance preview via `cast balance`) and stop before any broadcast. `moveNativeFundsToNewWallet.ts` itself has no dry-run flag — never pass `--check` to it; citty silently ignores unknown flags and the script would broadcast a live sweep.

The **old** (source) wallet is never taken as input — it is derived from the key (see Guardrails). If `--new-address` is missing or not a valid EVM address, ask once and stop.

## Guardrails

- **Custody guard.** Only the SC-owned wallets may be swept as part of a rotation: **deployer, dev, pauser**. NEVER sweep or rotate refund / feeCollector / withdraw (CTO-owned). If the invoking context names one of those, stop and tell the user.
- **Derive the source, never look it up.** The rotated-out (sender) address is derived from the private key via `cast wallet address`, inside a subshell, never echoed — and never read from `config/global.json` (the key and config can diverge mid-rotation; a wrong source makes a funded wallet look empty). Confirm the derived source matches the role's current on-chain address before sweeping.
- **Human-confirmed pre-sweep report.** Inherit the `send-deployer-funds` rails: render the per-network report and require explicit human confirmation before any broadcast. An agent must never self-approve. `--check` needs no confirmation (it moves nothing).
- **Secrets hygiene.** Never print the private key or a full RPC URL; read keys in a subshell; redact URLs to host or env-var name in any output.
- **Native swept LAST.** In a full rotation, native gas is the source wallet's ability to broadcast — so the sweep runs only AFTER all other moves that need the old key to sign (ownership transfers, proposal signatures) are done. Sweeping native first strands the old key with no gas to complete those txs. (`moveNativeFundsToNewWallet.ts` sweeps native last within itself; the ordering rule here is about where this skill sits in a rotation.)
- **Never bypass Safe/timelock.** This skill moves only EOA-held gas; it makes no owner/role/pauser change. Any such on-chain change belongs to `multisig-rollout`.
- **Exit-code convention.** `0` success (all targeted networks swept or cleanly skipped); `1` real error (report stderr, stop, no retry, no fallback); `2` recoverable misconfig (missing `--new-address`, missing key env var — name the var to set). Lets an orchestrator process the rotation deterministically.

## Workflow

### Phase 0 — Preflight

Run from the worktree root. `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"` if `cast`/`bun` are not found. Check and report (don't fix silently):

- `.env` exists and the `--old-key-env` env var (default `PRIVATE_KEY_PRODUCTION` in prod / `PRIVATE_KEY` staging) is present. Missing → exit `2`, name the var.
- Foundry available (`cast --version`), `bun` available.
- Confirm the role being rotated is one of deployer / dev / pauser (custody guard).

### Phase 1 — Derive the source + confirm it is the rotated-out wallet

```bash
# --old-key-env wins; otherwise PRIVATE_KEY_PRODUCTION only with --production, PRIVATE_KEY for staging
FROM_KEY_VAR="${OLD_KEY_ENV:-$([ "$PRODUCTION" = "true" ] && echo PRIVATE_KEY_PRODUCTION || echo PRIVATE_KEY)}"
SOURCE=$(set +x; KEY=$(grep -E "^${FROM_KEY_VAR}=" .env | cut -d= -f2- | tr -d '"'); cast wallet address --private-key "$KEY")
```

Report the derived `SOURCE`. Cross-check it equals the role's **current** on-chain / config address (the wallet being rotated out) — if it instead matches `--new-address`, the key has already been rotated and there is nothing to sweep; stop and say so. Do not read the source from `config/global.json`.

### Phase 2 — Balance preview (always, before any broadcast)

`moveNativeFundsToNewWallet.ts` has **no dry-run / preview flag** (its only citty args are `--newWalletAddress`, `--privateKey`, `--privateKeyEnvKey`; unknown flags are silently ignored and the script broadcasts immediately). Never invoke it to "preview" — the preview is read-only `cast balance` per active EVM chain:

```bash
# same selection as the mover's getAllActiveNetworks(), minus Tron (cast is EVM-only)
for NET in $(jq -r 'to_entries[] | select(.value.status == "active") | .key | select(startswith("tron") | not)' config/networks.json); do
  RPC=$(jq -r --arg n "$NET" '.[$n].rpcUrl' config/networks.json)
  BAL=$(cast balance "$SOURCE" --rpc-url "$RPC" 2>/dev/null) || BAL="RPC unreachable"
  echo "$NET: $BAL"
done
```

Render a per-network table: chain, source balance, destination (`$NEW`). The mover's `getAllActiveNetworks()` does NOT exclude Tron — `tron`/`tronshasta` are in its target set and it will attempt (and fail on) them; list them in the table as explicit rows marked "not previewable with `cast`; expected to fail in the sweep; handled manually per Phase 5" so the preview covers exactly the set the script will touch. This preview reports **raw balances only** — the gas reserve kept and exact amount-to-move come from the mover's internal reserve logic and are not available without broadcasting; say so explicitly in the report. Flag chains with a dust/zero balance (the script will skip them) and any chain whose RPC is unreachable (surface, don't silently drop). Never broadcast to preview.

### Phase 3 — Human confirmation

Present the pre-sweep report and require explicit confirmation (`yes`/`proceed`/`confirm`, case-insensitive; reject bare `y`). Skip only in `--check` mode. An agent/sub-agent must never answer this itself.

### Phase 4 — Sweep

Runs long (one broadcast per chain, native moved last within the script). Run in the background and monitor:

```bash
bunx tsx script/tasks/moveNativeFundsToNewWallet.ts \
  --newWalletAddress "$NEW" \
  --privateKeyEnvKey "$FROM_KEY_VAR"
```

`--privateKey 0x…` is an alternative to `--privateKeyEnvKey`; omitting both drops the script into an interactive key prompt — prefer the env-key form so no key is ever on the command line. Pipe output through a filter that strips any line mentioning the key and redacts RPC URLs before display. Let per-network failures continue the run: capture the failed networks and their errors, keep the succeeded ones, and offer to retry the failures individually.

### Phase 5 — Tron native (manual step — no multi-chain script)

`moveNativeFundsToNewWallet.ts` can only sweep EVM chains — it does not filter Tron out of its active-network set, so expect `tron`/`tronshasta` to show up as failed rows in its output (don't retry them). Tron native (TRX) has no multi-chain sweep in this repo, so it is a single manual `troncast send` from the old Tron address to the new one. Derive both Tron base58 addresses from the EVM addresses (see `update-wallet-config` / `troncast address to-base58`), then hand the operator the single-transfer command to run — do not attempt to loop or automate it here. Note explicitly in the report that Tron native was handled (or is pending) manually.

## Verification

- Re-read each swept chain's source and destination balance the same way the preview read them; report source-before → source-after (≈ gas reserve) and destination-before → destination-after per network.
- Confirm every non-dust chain moved (source drained to ≈ the reserve). List skipped (dust/zero) and failed (with error) chains separately.
- The natural completeness gate for the whole rotation is `check-rotation-status`; this skill verifies only that the gas moved, not that roles were reassigned.

## Reuse map

- `script/tasks/moveNativeFundsToNewWallet.ts` — the multi-chain EVM native mover this skill wraps (citty camelCase flags: `--newWalletAddress`, `--privateKeyEnvKey`/`--privateKey`; no dry-run flag).
- `send-deployer-funds` — the single-chain / arbitrary-recipient sibling whose secrets-hygiene, derive-sender, and human-confirm rails this skill inherits. Use it, not this skill, for a one-off top-up.
- `troncast address to-base58` / `troncast send` — Tron address derivation + the manual single-transfer for Tron native (Phase 5).
- `update-wallet-config` — records the new wallet in `config/global.json` after the rotation (separate PR step).
- `check-rotation-status` — read-only completeness gate for the overall rotation.
