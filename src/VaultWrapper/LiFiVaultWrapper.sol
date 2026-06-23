// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC4626 } from "solady/tokens/ERC4626.sol";
import { ReentrancyGuard } from "solady/utils/ReentrancyGuard.sol";
import { AlreadyInitialized } from "../Errors/GenericErrors.sol";
import { ILiFiVaultWrapper } from "./interfaces/ILiFiVaultWrapper.sol";
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { FeeConfig } from "./LiFiVaultWrapperTypes.sol";

/// @title LiFiVaultWrapper
/// @author LI.FI (https://li.fi)
/// @notice Per-integrator ERC-4626 vault that wraps an underlying yield source. Shares
///         represent a claim on the assets the wrapper holds in that source; deposits are
///         forwarded to the source and withdrawals are redeemed from it, both routed
///         through an approved `IYieldAdapter`. Deployed as a beacon proxy and configured
///         once via `initialize`, so it has no constructor.
/// @dev This contract DOES custody funds: it holds the yield-source position (e.g. the
///      underlying vault's shares) on behalf of its depositors, and transiently holds the
///      asset while routing a deposit or withdrawal. Identity (`asset`/`underlying`/
///      `adapter`/`vaultWrapperAdmin`/`factory`) and the fee configuration are set
///      write-once in `initialize`. Fee, access, and pause behaviour are not implemented here — later
///      modules extend the virtual ERC-4626 entrypoints and Solady's deposit/withdraw
///      hooks. Inflation-attack protection relies on Solady virtual shares.
/// @custom:version 1.0.0
contract LiFiVaultWrapper is ERC4626, ReentrancyGuard, ILiFiVaultWrapper {
    /// Storage ///

    /// @notice Whether `initialize` has run; guards against re-initialization.
    bool public initialized;
    /// @notice The yield source this wrapper deposits into (e.g. an ERC-4626 vault).
    address public underlying;
    /// @notice The approved yield adapter the wrapper routes deposits/withdrawals through.
    address public adapter;
    /// @notice The per-vault controller granted the instance admin role.
    address public vaultWrapperAdmin;
    /// @notice The factory that deployed this instance (the initializer); read by later
    ///         modules for the factory-level global circuit breaker.
    address public factory;
    /// @notice The integrator's fee share (bps), snapshotted from the factory at deploy.
    uint16 public integratorShareBps;
    /// @notice Opaque wrapper-side config (access mode, receivers, ToS hash, oracle),
    ///         stored verbatim for later modules to decode.
    bytes public initData;

    /// @dev The ERC20 asset the vault is denominated in.
    address internal _vaultAsset;
    /// @dev Cached decimals of the asset, read once in `initialize`.
    uint8 internal _assetDecimals;
    /// @dev Per-fee-type rates and enabled flags, validated by the factory.
    FeeConfig internal _feeConfig;

    /// Initialization ///

    /// @inheritdoc ILiFiVaultWrapper
    /// @dev Permissionless but single-shot: the factory deploys and initializes in one
    ///      transaction, and the `initialized` guard blocks any later call. All arguments
    ///      are validated by the factory before this is reached.
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

        factory = msg.sender;
        _vaultAsset = _asset;
        underlying = _underlying;
        adapter = _adapter;
        vaultWrapperAdmin = _vaultWrapperAdmin;
        integratorShareBps = _integratorShareBps;
        _feeConfig = _fees;
        initData = _initData;

        (bool ok, uint8 dec) = _tryGetAssetDecimals(_asset);
        _assetDecimals = ok ? dec : 18;
    }

    /// ERC-4626 configuration ///

    /// @notice The ERC20 asset the vault is denominated in.
    function asset() public view override returns (address) {
        return _vaultAsset;
    }

    /// @notice Assets currently redeemable from the yield source, valued by the adapter.
    function totalAssets() public view override returns (uint256) {
        return IYieldAdapter(adapter).totalAssets(underlying, address(this));
    }

    /// @notice ERC20 name of the vault share token.
    function name() public pure override returns (string memory) {
        return "LI.FI Earn Vault Wrapper";
    }

    /// @notice ERC20 symbol of the vault share token.
    function symbol() public pure override returns (string memory) {
        return "lfVW";
    }

    /// @notice Fee config getters ///

    /// @notice Returns the configured rate (bps) for a fee type.
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return The fee rate in basis points.
    function feeRate(uint8 _feeType) external view returns (uint16) {
        return _feeConfig.rateBps[_feeType];
    }

    /// @notice Returns whether a fee type is enabled.
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return True if the fee type is enabled.
    function feeEnabled(uint8 _feeType) external view returns (bool) {
        return _feeConfig.enabled[_feeType];
    }

    /// ERC-4626 entrypoints (reentrancy-guarded) ///

    /// @inheritdoc ERC4626
    function deposit(
        uint256 assets,
        address to
    ) public override nonReentrant returns (uint256 shares) {
        shares = super.deposit(assets, to);
    }

    /// @inheritdoc ERC4626
    function mint(
        uint256 shares,
        address to
    ) public override nonReentrant returns (uint256 assets) {
        assets = super.mint(shares, to);
    }

    /// @inheritdoc ERC4626
    function withdraw(
        uint256 assets,
        address to,
        address owner
    ) public override nonReentrant returns (uint256 shares) {
        shares = super.withdraw(assets, to, owner);
    }

    /// @inheritdoc ERC4626
    function redeem(
        uint256 shares,
        address to,
        address owner
    ) public override nonReentrant returns (uint256 assets) {
        assets = super.redeem(shares, to, owner);
    }

    /// Internal ///

    /// @dev Number of decimals of the underlying asset, cached at initialization.
    function _underlyingDecimals() internal view override returns (uint8) {
        return _assetDecimals;
    }

    /// @dev Pins virtual-share inflation protection on regardless of the library default.
    function _useVirtualShares() internal pure override returns (bool) {
        return true;
    }

    /// @dev Forwards freshly deposited assets into the yield source via the adapter.
    function _afterDeposit(uint256 assets, uint256) internal override {
        _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.deposit,
                (_vaultAsset, underlying, assets)
            )
        );
    }

    /// @dev Redeems assets from the yield source before they are sent to the withdrawer.
    function _beforeWithdraw(uint256 assets, uint256) internal override {
        _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.withdraw,
                (_vaultAsset, underlying, assets)
            )
        );
    }

    /// @dev Delegatecalls the adapter so its deposit/withdraw logic runs in this wrapper's
    ///      context (the wrapper holds the asset and the yield-source position). The
    ///      adapter is governance-approved and stateless, so it cannot touch this
    ///      wrapper's storage.
    /// @param _data The ABI-encoded adapter call.
    function _routeThroughAdapter(bytes memory _data) private {
        (bool success, bytes memory ret) = adapter.delegatecall(_data);
        if (!success) {
            // Re-raise the adapter's own revert data (custom error / reason) unchanged;
            // assembly is the only way to rethrow arbitrary return data verbatim.
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
