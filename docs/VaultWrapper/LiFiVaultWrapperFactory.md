# LiFiVaultWrapperFactory

## Description

Factory for the LI.FI Earn Vault Wrapper subsystem. It deploys per-integrator
vault wrapper instances as deterministic beacon proxies, gated by a curated
underlying allowlist, per-fee-type bounds, deploy authorization, and a
factory-level global circuit breaker.

The factory is a **standalone** contract — it is not a Diamond facet, is not
called by the Diamond, and does not follow Diamond patterns. It builds on
OpenZeppelin v5. It does not custody user funds; it only deploys and configures
wrapper instances.

## Governance

The factory is owned by a dedicated **48h TimelockController** (the subsystem
governance). Every configuration setter below is `onlyOwner`, so it can only be
called by scheduling a batch through the timelock and executing it after the 48h
delay (see `script/deploy/vaultWrapper/UpdateVaultWrapperConfig.s.sol`). Two
roles sit outside the timelock:

- **emergencyPauser** — trips the global circuit breaker (`globalPause` /
  `globalUnpause`).
- **onboardingManager** — assigns/revokes the deployer bound to each integrator
  namespace, and may deploy any instance.

## Configuration (owner / timelock)

```solidity
/// Add or remove a yield source from the deploy allowlist.
function setUnderlyingAllowed(address _underlying, bool _allowed) external onlyOwner

/// Approve or revoke a yield adapter usable in deployments.
function setAdapterApproved(address _adapter, bool _approved) external onlyOwner

/// Set adjustable min/max bps bounds for a fee type (within the immutable cap).
function setFeeBounds(FeeType _feeType, uint16 _minBps, uint16 _maxBps) external onlyOwner

/// Set the default integrator fee share (bps); must be < 100%.
function setDefaultSplit(uint16 _integratorBps) external onlyOwner

/// Set the recipient of LI.FI's fee share, read live by every wrapper.
function setLifiFeeRecipient(address _recipient) external onlyOwner

/// Rotate the emergency pauser / onboarding manager roles.
function setEmergencyPauser(address _newPauser) external onlyOwner
function setOnboardingManager(address _newManager) external onlyOwner
```

No wrapper can be deployed until the first configuration batch (at least one
approved adapter and one allowed underlying) has been executed after the 48h
delay.

## Fee caps

Each fee type is bounded by an **immutable** bytecode cap; governance can only set
adjustable bounds within it:

| Fee type    | Cap    |
| ----------- | ------ |
| performance | 50%    |
| management  | 10%    |
| deposit     | 20%    |
| withdrawal  | 20%    |

## Integrator onboarding (onboarding manager)

```solidity
/// Assign or revoke the deployer authorized to deploy under a namespace
/// (zero address revokes). The namespace seeds the CREATE2 salt.
function setApprovedIntegratorDeployer(bytes32 _namespace, address _deployer) external onlyOnboardingManager
```

## Deploy

```solidity
/// Deploy a new wrapper instance under an integrator namespace.
function deploy(DeployParams calldata _params) external returns (address instance)

/// The deterministic address a wrapper will have for the given key.
function predictAddress(
    bytes32 _namespace,
    address _adapter,
    address _underlying,
    uint256 _nonce
) external view returns (address)
```

Callers must be the onboarding manager or the deployer approved for
`_params.namespace`. A self-serve deployer may only set an integrator share at or
below `defaultIntegratorShareBps` (it can give LI.FI more than the default cut but
never less); the onboarding manager may set any share below 100%. Deploys are
allowed while `globalPaused` is set — a new instance reads the same live flag and
is frozen from birth.

## Cross-chain address parity

Instances are OZ `BeaconProxy` contracts deployed via `CREATE2`. The salt is
derived from the chain-independent `bytes32 namespace`, so identical inputs yield
the same instance address on every chain — provided the factory and the beacon
sit at identical addresses per chain, which the CREATE3 system deploy
(`DeployLiFiVaultWrapperFactory.s.sol`) provides.

## Related contracts

- [LiFiVaultWrapper](./LiFiVaultWrapper.md) — the per-instance ERC-4626 vault.
- [ERC4626Adapter](./ERC4626Adapter.md) — the first yield adapter.
