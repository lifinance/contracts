# Vault Wrapper Timelock

## Description

The vault wrapper subsystem is governed by a **dedicated 48h timelock**: a vanilla
OpenZeppelin `TimelockController` deployed by
`script/deploy/facets/DeployVaultWrapperTimelock.s.sol`. It owns the
`LiFiVaultWrapperFactory` and the wrapper `UpgradeableBeacon`, so every slow-path
configuration change and every implementation upgrade is delayed 48h before it can
take effect.

This is a separate instance from `LiFiTimelockController` (the 3h, Diamond-coupled
controller used for production diamond governance). The wrapper does not need the
Diamond-specific features (`unpauseDiamond`, `setDiamondAddress`), so a vanilla OZ
`TimelockController` is used with no custom code.

## Roles

`TimelockController` constructor grants both `PROPOSER_ROLE` and `CANCELLER_ROLE` to
each proposer.

- **PROPOSER_ROLE / CANCELLER_ROLE**: the LI.FI multisig. Schedules and cancels
  operations.
- **EXECUTOR_ROLE**: open (`address(0)`). Anyone may execute a queued operation once
  the 48h delay elapses.
- **TIMELOCK_ADMIN_ROLE**: held only by the timelock itself (the optional admin is
  renounced by passing `address(0)` at deploy). Role changes therefore go through the
  timelock.

## What is gated

Making the timelock the factory owner puts every `onlyOwner` factory function behind
the 48h delay:

- `setUnderlyingAllowed`
- `setAdapterApproved`
- `setFeeBounds`
- `setDefaultSplit`
- `setLifiFeeRecipient`
- `setEmergencyPauser`
- `setOnboardingManager`
- `transferOwnership`

Making the timelock the beacon owner gates `UpgradeableBeacon.upgradeTo`, so a wrapper
implementation upgrade also waits 48h.

### Out of scope of the timelock

The factory's global circuit breaker (`globalPause` / `globalUnpause`) is held by a
separate `emergencyPauser` role and fires **without** the timelock delay — an
emergency pause must be immediate. Only the *rotation* of the pauser
(`setEmergencyPauser`) is a slow-path action behind the timelock.

## Deploy and wiring order

1. Deploy the timelock: run `DeployVaultWrapperTimelock` with `MULTISIG` set to the
   LI.FI Safe. Delay is fixed at 48h; executor is open; admin is renounced.
2. Deploy the factory: run `DeployLiFiVaultWrapperFactory` with `OWNER` set to the
   timelock address from step 1. That sets the factory owner to the timelock and
   transfers the beacon ownership to the timelock in the same script.
3. Bootstrap configuration (approve the first adapter, allowlist the first underlying)
   is itself a slow-path action: schedule it through the timelock and execute after
   48h.

## Configuration

- **MIN_DELAY**: `48 hours` (fixed in the deploy script).
- **proposers**: `[MULTISIG]` — the LI.FI Safe (also canceller).
- **executors**: `[address(0)]` — open.
- **admin**: `address(0)` — renounced; timelock is self-administered.

> Full `DeployScriptBase` / CREATE3 / deployment-log integration for the vault wrapper
> deploy scripts is tracked in S14 (EXSC-420).
