# `script/emergency/` — frozen break-glass emergency pause

This directory holds the **incident-critical** emergency-pause logic. It is deliberately
**isolated** from the rest of the scripting library.

## What's here

- **`emergencyPauseBreakGlass.sh`** — the single source of truth for pausing production (and
  staging) `LiFiDiamond`s from the registered PauserWallet EOA. Run by the emergency-pause
  GitHub workflows and delegated to by the interactive CLI tool's "pause entirely" action.

## The freeze contract (read before editing)

The emergency pause must keep working even as the shared scripting library changes underneath
it. A change to `universalCast` / `helperFunctions.sh` once routed `pauseDiamond()` through the
Safe and broke the pause (EXSC-367). To make that structurally impossible, this script:

- **Does NOT `source`** `script/helperFunctions.sh`, `script/universalCast.sh`, or anything else.
- **Does NOT call** `universalCast` / `universalSend` / `universalSendRaw` / `universalCall` /
  `universalCode` / `sendOrPropose`.
- Vendors near-verbatim **frozen copies** of only the few helpers it needs (key normalization,
  Tron base58 derivation, RPC env-var naming, the EVM `cast send` / Tron `troncast send`
  dispatch, retry/logging).

It still **reads live data** — `config/networks.json`, `deployments/*.json` — so a newly-added
production **EVM** diamond is covered automatically without editing this script
("frozen code, live data").

This isolation is enforced by **Information Security Manager approval**: any change here
requires review (`.github/workflows/protectSecurityRelevantCode.yml` protects `script/emergency/`).

## How to change it safely

- **Do not** "DRY it up" by re-importing the shared library — that coupling is the exact risk
  this directory exists to remove, and a reviewer will reject it.
- Adding a new prod **EVM** chain needs **no change** here (read from deploy logs). Validate by
  pausing that diamond during onboarding, before it is backend-integrated, then unpausing.
- Adding a new **non-EVM ecosystem**, or changing the `troncast` invocation, **does** require a
  change here — update the dispatch branch and run the onboarding live-test on the new diamond.
- After any change, run the offline checks (`bash -n`) and a staging dry-run before relying on
  the script.

## Usage

```bash
PRIVATE_KEY_PAUSER_WALLET=<hex key> \
  [ENVIRONMENT=production|staging] \
  [NETWORK=<name>|all] \
  bash script/emergency/emergencyPauseBreakGlass.sh
```

- `ENVIRONMENT` — `production` (default) or `staging`; selects the deploy-log file and network set.
- `NETWORK` — a single network name to restrict to, or `all` (default). Used by the CLI to pause
  one selected network.
- EVM RPC endpoints come from `ETH_NODE_URI_<NETWORK>` env vars (injected by the workflow's
  MongoDB fetch step, or present in `.env` locally).

Pausing is sent **directly** from the PauserWallet EOA — never proposed to a Safe.
