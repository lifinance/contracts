// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";

/// @title MockVaultWrapperV2
/// @author LI.FI (https://li.fi)
/// @notice Upgrade target used only by BeaconUpgrade.t.sol to prove a beacon
///         upgrade propagates to every existing clone. Inherits MockVaultWrapper
///         (identical storage + initialize/asset interface) and adds a version()
///         marker absent from V1, so the swap is observable through clones.
contract MockVaultWrapperV2 is MockVaultWrapper {
    function version() external pure returns (uint256) {
        return 2;
    }
}
