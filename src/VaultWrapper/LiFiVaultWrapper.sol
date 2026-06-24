// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC4626 } from "solady/tokens/ERC4626.sol";
import { ReentrancyGuard } from "solady/utils/ReentrancyGuard.sol";
import { MetadataReaderLib } from "solady/utils/MetadataReaderLib.sol";
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
///      write-once in `initialize`. Fee, access, and pause logic are scaffolded as no-op
///      seams (`_accrueFees`, `_entryFee`/`_exitFee`, `_routeFee`, `_requireNotPaused`,
///      `_checkAccess`) wired into the entrypoints and the deposit/withdraw flow; their
///      bodies land in follow-up tickets. Inflation-attack protection relies on Solady
///      virtual shares.
/// @custom:version 1.0.0
contract LiFiVaultWrapper is ERC4626, ReentrancyGuard, ILiFiVaultWrapper {
    using MetadataReaderLib for address;

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
    /// @dev Share-token name, derived from the asset symbol in `initialize`.
    string internal _vaultName;
    /// @dev Share-token symbol, derived from the asset symbol in `initialize`.
    string internal _vaultSymbol;
    /// @dev Per-fee-type rates and enabled flags, validated by the factory.
    FeeConfig internal _feeConfig;

    /// Events ///

    /// @notice Emitted once when the instance is configured.
    /// @param asset The ERC20 asset the vault is denominated in.
    /// @param underlying The yield source the wrapper deposits into.
    /// @param adapter The yield adapter the wrapper routes through.
    /// @param vaultWrapperAdmin The per-vault controller granted the instance admin role.
    /// @param factory The factory that deployed and initialized the instance.
    /// @param integratorShareBps The integrator's fee share (bps) snapshotted at deploy.
    event Initialized(
        address indexed asset,
        address indexed underlying,
        address indexed adapter,
        address vaultWrapperAdmin,
        address factory,
        uint16 integratorShareBps
    );

    /// Errors ///

    /// @notice Thrown when a fee type ordinal is outside the valid range (0-3).
    error InvalidFeeType(uint8 feeType);

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

        string memory assetSymbol = _asset.readSymbol();
        if (bytes(assetSymbol).length == 0) assetSymbol = "VW";
        _vaultName = string.concat("LI.FI Earn ", assetSymbol);
        _vaultSymbol = string.concat("lf", assetSymbol);

        emit Initialized(
            _asset,
            _underlying,
            _adapter,
            _vaultWrapperAdmin,
            msg.sender,
            _integratorShareBps
        );
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

    /// @notice ERC20 name of the vault share token, e.g. "LI.FI Earn USDC".
    function name() public view override returns (string memory) {
        return _vaultName;
    }

    /// @notice ERC20 symbol of the vault share token, e.g. "lfUSDC".
    function symbol() public view override returns (string memory) {
        return _vaultSymbol;
    }

    /// @notice Fee config getters ///

    /// @notice Returns the configured rate (bps) for a fee type.
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return The fee rate in basis points.
    function feeRate(uint8 _feeType) external view returns (uint16) {
        if (_feeType > 3) revert InvalidFeeType(_feeType);
        return _feeConfig.rateBps[_feeType];
    }

    /// @notice Returns whether a fee type is enabled.
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return True if the fee type is enabled.
    function feeEnabled(uint8 _feeType) external view returns (bool) {
        if (_feeType > 3) revert InvalidFeeType(_feeType);
        return _feeConfig.enabled[_feeType];
    }

    /// ERC-4626 entrypoints (reentrancy-guarded) ///

    /// @inheritdoc ERC4626
    function deposit(
        uint256 assets,
        address to
    ) public override nonReentrant returns (uint256 shares) {
        _beforeOperation();

        shares = super.deposit(assets, to);
    }

    /// @inheritdoc ERC4626
    function mint(
        uint256 shares,
        address to
    ) public override nonReentrant returns (uint256 assets) {
        _beforeOperation();

        assets = super.mint(shares, to);
    }

    /// @inheritdoc ERC4626
    function withdraw(
        uint256 assets,
        address to,
        address owner
    ) public override nonReentrant returns (uint256 shares) {
        _beforeOperation();

        shares = super.withdraw(assets, to, owner);
    }

    /// @inheritdoc ERC4626
    function redeem(
        uint256 shares,
        address to,
        address owner
    ) public override nonReentrant returns (uint256 assets) {
        _beforeOperation();

        assets = super.redeem(shares, to, owner);
    }

    /// ERC-4626 fee-adjusted previews ///

    /// @inheritdoc ERC4626
    function previewDeposit(
        uint256 assets
    ) public view override returns (uint256) {
        return super.previewDeposit(assets - _entryFee(assets));
    }

    /// @inheritdoc ERC4626
    function previewMint(
        uint256 shares
    ) public view override returns (uint256 assets) {
        assets = super.previewMint(shares);
        return assets + _entryFee(assets);
    }

    /// @inheritdoc ERC4626
    function previewWithdraw(
        uint256 assets
    ) public view override returns (uint256) {
        return super.previewWithdraw(assets + _exitFee(assets));
    }

    /// @inheritdoc ERC4626
    function previewRedeem(
        uint256 shares
    ) public view override returns (uint256 assets) {
        assets = super.previewRedeem(shares);
        return assets - _exitFee(assets);
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

    /// @dev Skims the entry fee, then forwards the remaining deposited assets into the
    ///      yield source via the adapter. With fees unimplemented the skim is zero, so the
    ///      full amount is invested.
    function _afterDeposit(uint256 assets, uint256) internal override {
        uint256 fee = _entryFee(assets);
        _routeFee(fee);
        _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.deposit,
                (_vaultAsset, underlying, assets - fee)
            )
        );
    }

    /// @dev Redeems the withdrawal amount plus the exit fee from the yield source, then skims
    ///      the fee before the remainder is sent to the withdrawer. With fees unimplemented the
    ///      skim is zero, so exactly the withdrawal amount is redeemed.
    function _beforeWithdraw(uint256 assets, uint256) internal override {
        uint256 fee = _exitFee(assets);
        _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.withdraw,
                (_vaultAsset, underlying, assets + fee)
            )
        );
        _routeFee(fee);
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

    /// Fee / pause / access blueprint ///
    /// @dev The functions below are no-op seams wired into the entrypoints and the
    ///      deposit/withdraw flow. Their bodies are implemented in follow-up tickets
    ///      (fees, access control, global pause); today they preserve current behaviour.

    /// @dev Guards every state-changing entrypoint: rejects when the circuit breaker is
    ///      engaged, enforces the vault's access mode on the caller, and accrues
    ///      time/yield-based fees so the operation transacts at the post-accrual share price.
    function _beforeOperation() private {
        _requireNotPaused();
        _checkAccess(msg.sender);
        _accrueFees();
    }

    /// @dev Reverts when the factory-level global pause / circuit breaker is engaged.
    function _requireNotPaused() private view {
        // TODO(pause): revert if the factory circuit breaker is active.
    }

    /// @dev Enforces the vault's access mode (open / allowlist / permissioned) on the caller.
    function _checkAccess(address /* caller */) private view {
        // TODO(access): decode the access mode from initData and authorize the caller.
    }

    /// @dev Accrues management (time-based) and performance (high-water-mark) fees by minting
    ///      fee shares to the integrator/LI.FI recipients, routed via _routeFee. Runs before
    ///      share math so deposits/withdrawals transact post-accrual.
    function _accrueFees() private {
        // TODO(fees): mint management + performance fee shares before share math runs.
    }

    /// @dev Entry-fee portion (in assets) skimmed from a deposit of `assets`. Returns 0 until
    ///      implemented; the gross/net basis must stay consistent with the preview overrides.
    ///      Widens to `view` once it reads the _feeConfig deposit rate.
    function _entryFee(uint256 /* assets */) private pure returns (uint256) {
        // TODO(fees): derive from the _feeConfig deposit rate, bounded by the bytecode cap.
        return 0;
    }

    /// @dev Exit-fee portion (in assets) skimmed from a withdrawal of `assets`. Returns 0 until
    ///      implemented; the gross/net basis must stay consistent with the preview overrides.
    ///      Widens to `view` once it reads the _feeConfig withdrawal rate.
    function _exitFee(uint256 /* assets */) private pure returns (uint256) {
        // TODO(fees): derive from the _feeConfig withdrawal rate, bounded by the bytecode cap.
        return 0;
    }

    /// @dev Splits a collected fee between the integrator (integratorShareBps) and LI.FI
    ///      (remainder, to the factory-governed lifiFeeRecipient read live) and routes each.
    function _routeFee(uint256 /* feeAssets */) private {
        // TODO(fees): transfer the integrator share to its recipient, remainder to LI.FI.
    }
}
