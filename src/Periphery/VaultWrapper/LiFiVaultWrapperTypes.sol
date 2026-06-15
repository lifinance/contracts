// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @notice Fee categories charged by a wrapper instance.
enum FeeType {
    Performance,
    Management,
    Deposit,
    Withdrawal
}

/// @notice Per-instance fee selection: rate (bps) and on/off flag, indexed by FeeType.
struct FeeConfig {
    // Both arrays are indexed by FeeType ordinal.
    uint16[4] rateBps;
    bool[4] enabled;
}

/// @notice Factory-level adjustable bounds for a single fee type (bps).
struct FeeBounds {
    uint16 minBps;
    uint16 maxBps;
}

/// @notice Parameters for a single wrapper deployment.
struct DeployParams {
    address integrator;
    address underlying; // The ERC4626 vault to wrap; its asset() is derived by the factory.
    uint256 chainLockId;
    uint256 nonce;
    FeeConfig fees;
    bytes initData;
}
