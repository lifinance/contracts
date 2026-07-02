// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { FeeConfig } from "../LiFiVaultWrapperTypes.sol";

/// @title ILiFiVaultWrapper
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface the factory calls on a freshly deployed vault wrapper.
/// @custom:version 1.0.0
interface ILiFiVaultWrapper {
    /// @notice One-time setup of a vault wrapper immediately after deployment.
    /// @dev The asset is resolved from `_underlying` via `_adapter` rather than passed in,
    ///      so it cannot disagree with what the adapter actually reports.
    /// @param _underlying The protocol-specific yield source (e.g. an ERC-4626 vault).
    /// @param _adapter The approved yield adapter the vault wrapper routes through at runtime.
    /// @param _vaultWrapperAdmin The per-vault controller granted the instance admin role.
    /// @param _integratorShareBps The integrator's fee share (bps), resolved and bounded by the factory.
    /// @param _fees The per-fee-type rates and enabled flags (already validated by the factory).
    /// @param _initData Opaque vault-wrapper-side config (access mode, receivers, ToS hash, oracle).
    function initialize(
        address _underlying,
        address _adapter,
        address _vaultWrapperAdmin,
        uint16 _integratorShareBps,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external;
}
