// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Minimal valid integrator receiver set: a single wallet holding 100% of the
///         fan-out. Shared by the VaultWrapper test suites that don't exercise distribution,
///         so the construction isn't re-implemented per file.
/// @return r The single-wallet receiver set (wallet `0xFEE1`, 10_000 bps).
function defaultReceivers() pure returns (FeeReceiver[] memory r) {
    r = new FeeReceiver[](1);
    r[0] = FeeReceiver({ wallet: address(0xFEE1), bps: 10_000 });
}
