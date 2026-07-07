// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IntegratorReceivers } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Minimal valid integrator receiver set: a single wallet holding 100% of the
///         fan-out. Shared by the VaultWrapper test suites that don't exercise distribution,
///         so the construction isn't re-implemented per file.
/// @return r The single-wallet receiver set (wallet `0xFEE1`, 10_000 bps).
function defaultReceivers() pure returns (IntegratorReceivers memory r) {
    address[] memory wallets = new address[](1);
    wallets[0] = address(0xFEE1);
    uint16[] memory bps = new uint16[](1);
    bps[0] = 10_000;
    r = IntegratorReceivers({ wallets: wallets, bps: bps });
}
