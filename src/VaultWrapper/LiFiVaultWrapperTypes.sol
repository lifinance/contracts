// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @custom:version 1.0.0

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
    address adapter; // Approved yield adapter; validates `underlying` and derives its asset.
    address underlying; // Protocol-specific yield source (e.g. an ERC-4626 vault).
    uint256 chainLockId;
    uint256 nonce;
    FeeConfig fees;
    bytes initData;
}
