// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC4626 } from "solady/tokens/ERC4626.sol";
import { ILiFiVaultWrapper } from "../interfaces/ILiFiVaultWrapper.sol";
import { FeeConfig } from "../LiFiVaultWrapperTypes.sol";

/// @title MockVaultWrapper
/// @author LI.FI (https://li.fi)
/// @notice Temporary beacon implementation used until S1 (CWIA core) lands. Built
///         on Solady's ERC-4626 so the stand-in behind the beacon is a real vault
///         share token (constructor-free, so it works through the beacon proxy),
///         and records its init args so factory tests can assert clone wiring.
/// @custom:version 1.0.0
contract MockVaultWrapper is ERC4626, ILiFiVaultWrapper {
    /// @notice Thrown when initialize is called more than once on an instance.
    error AlreadyInitialized();

    bool public initialized;
    address internal _vaultAsset;
    address public underlying;
    address public adapter;
    address public vaultWrapperAdmin;
    uint16 public integratorShareBps;
    bytes public initData;

    FeeConfig internal _feeConfig;

    /// @inheritdoc ILiFiVaultWrapper
    function initialize(
        address _asset,
        address _underlying,
        address _adapter,
        address _vaultWrapperAdmin,
        uint16 _integratorShareBps,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        _vaultAsset = _asset;
        underlying = _underlying;
        adapter = _adapter;
        vaultWrapperAdmin = _vaultWrapperAdmin;
        integratorShareBps = _integratorShareBps;
        _feeConfig = _fees;
        initData = _initData;
    }

    /// @notice The ERC20 asset the vault is denominated in (set at initialize).
    function asset() public view override returns (address) {
        return _vaultAsset;
    }

    /// @notice ERC20 name of the vault share token.
    function name() public pure override returns (string memory) {
        return "Mock Vault Wrapper";
    }

    /// @notice ERC20 symbol of the vault share token.
    function symbol() public pure override returns (string memory) {
        return "mVW";
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
