// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { FeeConfig } from "../LiFiVaultWrapperTypes.sol";

/// @title ILiFiVaultWrapper
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @notice Minimal interface the factory calls on a freshly deployed clone.
interface ILiFiVaultWrapper {
    /// @notice One-time setup of a wrapper clone immediately after deployment.
    /// @param _asset The ERC20 asset of the underlying vault.
    /// @param _underlying The wrapped ERC4626 vault.
    /// @param _integrator The address granted the instance admin role.
    /// @param _chainLockId 0 if unlocked, else the only chain id where deposits are allowed.
    /// @param _fees The per-fee-type rates and enabled flags (already validated by the factory).
    /// @param _initData Opaque clone-side config (access mode, receivers, ToS hash, oracle).
    function initialize(
        address _asset,
        address _underlying,
        address _integrator,
        uint256 _chainLockId,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external;
}
