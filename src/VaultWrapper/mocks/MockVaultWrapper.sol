// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFiVaultWrapper } from "../interfaces/ILiFiVaultWrapper.sol";
import { FeeConfig } from "../LiFiVaultWrapperTypes.sol";

/// @title MockVaultWrapper
/// @author LI.FI (https://li.fi)
/// @notice Temporary beacon implementation used until S1 (CWIA core) lands.
///         Records init args so factory tests can assert vault wrapper wiring.
/// @custom:version 1.0.0
contract MockVaultWrapper is ILiFiVaultWrapper {
    error AlreadyInitialized();

    bool public initialized;
    address public asset;
    address public underlying;
    address public adapter;
    address public integrator;
    uint256 public chainLockId;
    bytes public initData;

    FeeConfig internal _feeConfig;

    /// @inheritdoc ILiFiVaultWrapper
    function initialize(
        address _asset,
        address _underlying,
        address _adapter,
        address _integrator,
        uint256 _chainLockId,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        asset = _asset;
        underlying = _underlying;
        adapter = _adapter;
        integrator = _integrator;
        chainLockId = _chainLockId;
        _feeConfig = _fees;
        initData = _initData;
    }

    /// @notice Returns the recorded rate (bps) for a fee type.
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return The fee rate in basis points.
    function feeRate(uint8 _feeType) external view returns (uint16) {
        return _feeConfig.rateBps[_feeType];
    }

    /// @notice Returns whether a fee type was recorded as enabled.
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return True if the fee type is enabled.
    function feeEnabled(uint8 _feeType) external view returns (bool) {
        return _feeConfig.enabled[_feeType];
    }
}
