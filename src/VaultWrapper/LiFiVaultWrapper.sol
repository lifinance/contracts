// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { MetadataReaderLib } from "solady/utils/MetadataReaderLib.sol";
import { ILiFiVaultWrapper } from "./interfaces/ILiFiVaultWrapper.sol";
import { ILiFiVaultWrapperFactory } from "./interfaces/ILiFiVaultWrapperFactory.sol";
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { FeeConfig, FeeType } from "./LiFiVaultWrapperTypes.sol";
import { LibVaultWrapperMath } from "./libraries/LibVaultWrapperMath.sol";

/// @title LiFiVaultWrapper
/// @author LI.FI (https://li.fi)
/// @notice Per-integrator-product ERC-4626 vault that wraps an underlying yield source. Shares
///         represent a claim on the assets the wrapper holds in that source; deposits are
///         forwarded to the source and withdrawals are redeemed from it, both routed through an
///         approved `IYieldAdapter`. Deployed as a beacon proxy and configured once via
///         `initialize`.
/// @dev Built on OpenZeppelin's upgradeable ERC-4626 so the asset, decimals, and share metadata
///      live in proxy storage (no constructor-set immutables, which a beacon proxy cannot give
///      per instance). This contract DOES custody funds: it holds the yield-source position on
///      behalf of depositors and transiently holds the asset while routing a deposit or
///      withdrawal. Identity (`underlying`/`adapter`/`owner`/`factory`) and the initial fee
///      configuration are set write-once in `initialize`. The per-vault admin role is OZ's
///      two-step `owner` (`transferOwnership`/`acceptOwnership`); renouncing it is disabled.
///      Management (dilution), deposit, and withdrawal fees are charged: management fee-shares
///      are minted to this contract via `_accrueFees`, and deposit/withdrawal asset fees are
///      kept idle and tracked through `_routeFee`. This contract does not distribute the
///      accrued fees. Inflation-attack protection relies on the ERC-4626 virtual-share offset.
/// @custom:version 1.0.0
contract LiFiVaultWrapper is
    ERC4626Upgradeable,
    // OZ v5's Ownable/Ownable2Step keep `_owner`/`_pendingOwner` in fixed ERC-7201
    // namespaced slots, not sequential ones, so they add no slot to this layout and are
    // collision-free behind a beacon proxy. They provide the per-vault admin role: `owner()`
    // is the admin, transferred via the standard two-step `transferOwnership`/`acceptOwnership`.
    Ownable2StepUpgradeable,
    // OZ v5's ReentrancyGuard keeps its status in a fixed ERC-7201 namespaced slot
    // (it is @custom:stateless), not a sequential one, so it occupies no slot in this
    // layout and is collision-free behind a beacon proxy — which is why OZ ships no
    // separate Upgradeable variant. The check treats the proxy's uninitialized status
    // slot as NOT_ENTERED, so the guard is correct from the first call even though the
    // implementation's constructor never ran in the proxy's storage context.
    ReentrancyGuard,
    ILiFiVaultWrapper
{
    using MetadataReaderLib for address;

    /// Storage ///

    /// @notice The yield source this wrapper deposits into (e.g. an ERC-4626 vault).
    address public underlying;
    /// @notice The approved yield adapter the wrapper routes deposits/withdrawals through.
    address public adapter;
    /// @notice The factory that deployed this instance (the initializer); read by later
    ///         modules for the factory-level global circuit breaker.
    address public factory;
    /// @notice The integrator's fee share (bps), snapshotted from the factory at deploy.
    uint16 public integratorShareBps;
    /// @notice Opaque wrapper-side config (access mode, receivers, ToS hash, oracle),
    ///         stored verbatim for later modules to decode.
    bytes public initData;

    /// @dev Per-fee-type rates and enabled flags, validated by the factory.
    FeeConfig internal _feeConfig;

    /// @notice Total dilution fee-shares minted to this contract and not yet paid out.
    ///         The LI.FI/integrator split is applied later at distribution, not here.
    uint256 public accruedFeeShares;
    /// @notice Total asset-side (deposit/withdrawal) fees held idle in this contract and
    ///         not yet paid out. Kept out of the yield source so it does not move PPS.
    uint256 public accruedFeeAssets;
    /// @notice Timestamp of the last management-fee crystallization.
    uint64 public lastMgmtAccrual;

    /// @dev Reserved slots so future versions can append wrapper-level state without
    ///      shifting any storage that inheriting/derived modules occupy. This impl sits
    ///      behind an upgradeable beacon, so storage layout is an upgrade invariant: only
    ///      append (consuming this gap), never reorder fields or the inheritance list.
    uint256[50] private __gap;

    /// Initialization ///

    /// @dev Locks the implementation contract so only beacon proxies (which have their own
    ///      storage) can be initialized — never the implementation itself.
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc ILiFiVaultWrapper
    /// @dev Permissionless but single-shot: the factory deploys and initializes in one
    ///      transaction, and OpenZeppelin's `initializer` guard blocks any later call. All
    ///      arguments are validated by the factory before this is reached. Share name/symbol
    ///      derive from the asset symbol (e.g. "LI.FI Earn USDC" / "lfUSDC"), falling back to
    ///      "VW" when the asset exposes none.
    function initialize(
        address _underlying,
        address _adapter,
        address _vaultWrapperAdmin,
        uint16 _integratorShareBps,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external initializer {
        if (
            _underlying == address(0) ||
            _adapter == address(0) ||
            _vaultWrapperAdmin == address(0)
        ) revert ZeroAddress();
        if (_integratorShareBps >= 10_000)
            revert InvalidIntegratorShareBps(_integratorShareBps);

        address asset = IYieldAdapter(_adapter).resolveAsset(_underlying);
        if (asset == address(0)) revert ZeroAddress();

        _initErc4626Metadata(asset);
        __Ownable_init(_vaultWrapperAdmin);

        factory = msg.sender;
        underlying = _underlying;
        adapter = _adapter;
        integratorShareBps = _integratorShareBps;
        _feeConfig = _fees;
        initData = _initData;
        lastMgmtAccrual = uint64(block.timestamp);

        emit Initialized(
            asset,
            _underlying,
            _adapter,
            _vaultWrapperAdmin,
            msg.sender,
            _integratorShareBps
        );
    }

    /// @dev Derives the share name/symbol from the asset symbol (falling back to "VW") and
    ///      runs the OZ ERC-20/ERC-4626 initializers. Split out of `initialize` to keep its
    ///      stack frame small. Only callable while initializing (the ERC-20/4626 initializers
    ///      carry the `onlyInitializing` guard).
    function _initErc4626Metadata(address _asset) private {
        string memory assetSymbol = _asset.readSymbol();
        if (bytes(assetSymbol).length == 0) assetSymbol = "VW";
        __ERC20_init(
            string.concat("LI.FI Earn ", assetSymbol),
            string.concat("lf", assetSymbol)
        );
        __ERC4626_init(IERC20(_asset));
    }

    /// @notice Whether the instance has been initialized.
    function initialized() external view returns (bool) {
        return _getInitializedVersion() != 0;
    }

    /// Admin role ///

    /// @notice Disabled: the per-vault admin role cannot be renounced.
    /// @dev A custody contract must never be left ownerless. The admin is rotated via OZ's
    ///      two-step `transferOwnership`/`acceptOwnership`; `renounceOwnership` is the only OZ
    ///      path to `owner == address(0)` and is overridden to always revert.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// ERC-4626 configuration ///

    /// @notice Assets currently redeemable from the yield source, valued by the adapter.
    function totalAssets() public view override returns (uint256) {
        return IYieldAdapter(adapter).totalAssets(underlying, address(this));
    }

    /// @dev Values shares against an effective supply that already includes the management
    ///      fee-shares pending since the last accrual, so previews match what a user gets
    ///      after `_accrueFees` crystallizes them at the top of the operation.
    function _convertToShares(
        uint256 _assets,
        Math.Rounding _rounding
    ) internal view override returns (uint256) {
        return
            LibVaultWrapperMath.convertToShares({
                _assets: _assets,
                _totalSupply: totalSupply(),
                _pendingFeeShares: _pendingFeeShares(),
                _totalAssets: totalAssets(),
                _decimalsOffset: _decimalsOffset(),
                _rounding: _rounding
            });
    }

    /// @dev See `_convertToShares`: the effective supply (including pending fee-shares) is
    ///      used so conversions stay consistent with the post-accrual share price.
    function _convertToAssets(
        uint256 _shares,
        Math.Rounding _rounding
    ) internal view override returns (uint256) {
        return
            LibVaultWrapperMath.convertToAssets({
                _shares: _shares,
                _totalSupply: totalSupply(),
                _pendingFeeShares: _pendingFeeShares(),
                _totalAssets: totalAssets(),
                _decimalsOffset: _decimalsOffset(),
                _rounding: _rounding
            });
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

    /// @inheritdoc ERC4626Upgradeable
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant returns (uint256) {
        _beforeOperation();

        return super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant returns (uint256) {
        _beforeOperation();

        return super.mint(shares, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        _beforeOperation();

        return super.withdraw(assets, receiver, owner);
    }

    /// @inheritdoc ERC4626Upgradeable
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        _beforeOperation();

        return super.redeem(shares, receiver, owner);
    }

    /// ERC-4626 fee-adjusted previews ///

    /// @inheritdoc ERC4626Upgradeable
    function previewDeposit(
        uint256 assets
    ) public view override returns (uint256) {
        uint256 fee = LibVaultWrapperMath.feeOnTotal({
            _assets: assets,
            _feeBps: _rate(FeeType.Deposit)
        });

        return super.previewDeposit(assets - fee);
    }

    /// @inheritdoc ERC4626Upgradeable
    function previewMint(
        uint256 shares
    ) public view override returns (uint256) {
        uint256 assets = super.previewMint(shares);

        return
            assets +
            LibVaultWrapperMath.feeOnRaw({
                _assets: assets,
                _feeBps: _rate(FeeType.Deposit)
            });
    }

    /// @inheritdoc ERC4626Upgradeable
    function previewWithdraw(
        uint256 assets
    ) public view override returns (uint256) {
        uint256 fee = LibVaultWrapperMath.feeOnRaw({
            _assets: assets,
            _feeBps: _rate(FeeType.Withdrawal)
        });

        return super.previewWithdraw(assets + fee);
    }

    /// @inheritdoc ERC4626Upgradeable
    function previewRedeem(
        uint256 shares
    ) public view override returns (uint256) {
        uint256 assets = super.previewRedeem(shares);

        return
            assets -
            LibVaultWrapperMath.feeOnTotal({
                _assets: assets,
                _feeBps: _rate(FeeType.Withdrawal)
            });
    }

    /// Internal ///

    /// @dev Skims the entry fee, then forwards the remaining deposited assets into the yield
    ///      source via the adapter. OZ's `_deposit` has already pulled the asset in and minted
    ///      shares. Reverts if the adapter reports the source accepted less than the net
    ///      deposit (a short-accepting source), so assets cannot be left stranded in the
    ///      wrapper against already-minted shares. A zero net amount (deposit fee consumed the
    ///      whole — sub-fee-denominator dust — input, or a bare zero deposit) skips the adapter
    ///      call entirely: there is nothing to invest, the fee is already routed, and a standard
    ///      ERC-4626 source reverts on a zero-asset forward, so short-circuiting keeps `deposit`
    ///      non-reverting in exactly the cases where `previewDeposit` returns 0.
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        super._deposit(caller, receiver, assets, shares);

        uint256 fee = LibVaultWrapperMath.feeOnTotal({
            _assets: assets,
            _feeBps: _rate(FeeType.Deposit)
        });
        _routeFee(FeeType.Deposit, fee);
        uint256 invested = assets - fee;
        if (invested == 0) return;

        uint256 deposited = _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.deposit,
                (asset(), underlying, invested)
            )
        );
        if (deposited < invested)
            revert AdapterDepositShortfall(invested, deposited);
    }

    /// @dev OZ's `_withdraw` keeps ownership of the allowance spend, share burn, and `Withdraw`
    ///      event; this overrides only its `_transferOut` seam to source the assets from the yield
    ///      source instead of an idle balance. Redeems the withdrawal amount plus the exit fee,
    ///      reverts on a short-paying source BEFORE paying the receiver (so OZ's preceding burn
    ///      rolls back and the owner keeps their shares), skims the fee, then transfers exactly
    ///      `_assets` to the receiver. With fees unimplemented the skim is zero, so exactly the
    ///      withdrawal amount is redeemed.
    function _transferOut(address _to, uint256 _assets) internal override {
        address assetToken = asset();
        uint256 fee = LibVaultWrapperMath.feeOnRaw({
            _assets: _assets,
            _feeBps: _rate(FeeType.Withdrawal)
        });
        uint256 owed = _assets + fee;
        uint256 withdrawn = _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.withdraw,
                (assetToken, underlying, owed)
            )
        );
        if (withdrawn < owed) revert AdapterWithdrawShortfall(owed, withdrawn);
        _routeFee(FeeType.Withdrawal, fee);
        SafeERC20.safeTransfer(IERC20(assetToken), _to, _assets);
    }

    /// @dev Delegatecalls the adapter so its deposit/withdraw logic runs in this wrapper's
    ///      context (the wrapper holds the asset and the yield-source position). Because the call
    ///      executes in this wrapper's storage context, the adapter must be governance-approved
    ///      and audited to avoid storage writes/collisions; statelessness is an enforced-by-review
    ///      invariant, not a guarantee of this contract.
    /// @param _data The ABI-encoded adapter call.
    /// @return result The adapter's returned amount (assets actually deposited/withdrawn).
    function _routeThroughAdapter(
        bytes memory _data
    ) private returns (uint256 result) {
        (bool success, bytes memory ret) = adapter.delegatecall(_data);
        if (!success) {
            // Re-raise the adapter's own revert data (custom error / reason) unchanged;
            // assembly is the only way to rethrow arbitrary return data verbatim.
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        result = abi.decode(ret, (uint256));
    }

    /// Fee config, pause, and access ///
    /// @dev `setFeeRate` is live. The pause and access functions below are no-op seams that
    ///      preserve current behaviour.

    /// @notice Sets the rate for a deposit, withdrawal, or management fee.
    /// @dev Only the owner may call. A zero rate disables the fee and skips
    ///      bounds validation (turning a fee off is always allowed); a non-zero rate must
    ///      sit within the factory's live bounds for the type. Accrues at the OLD rate
    ///      first so elapsed time is priced before the change. The performance fee is not
    ///      configurable here.
    /// @param _feeType The fee type to update (Management, Deposit, or Withdrawal).
    /// @param _newRateBps The new rate in basis points (0 disables the fee).
    function setFeeRate(
        FeeType _feeType,
        uint16 _newRateBps
    ) external onlyOwner {
        if (_feeType == FeeType.Performance)
            revert FeeTypeNotConfigurable(_feeType);

        _accrueFees();

        uint8 idx = uint8(_feeType);
        if (_newRateBps == 0) {
            _feeConfig.enabled[idx] = false;
            _feeConfig.rateBps[idx] = 0;
        } else {
            (uint16 minBps, uint16 maxBps) = ILiFiVaultWrapperFactory(factory)
                .feeBounds(_feeType);
            if (_newRateBps < minBps || _newRateBps > maxBps)
                revert FeeRateOutOfBounds(_newRateBps, minBps, maxBps);
            _feeConfig.enabled[idx] = true;
            _feeConfig.rateBps[idx] = _newRateBps;
        }

        emit FeeConfigUpdated(_feeType, _newRateBps, _newRateBps != 0);
    }

    /// @dev Guards every state-changing entrypoint: rejects when the circuit breaker is
    ///      engaged, enforces the vault's access mode on the caller, and accrues
    ///      time/yield-based fees so the operation transacts at the post-accrual share price.
    function _beforeOperation() private {
        _requireNotPaused();
        _checkAccess(msg.sender);
        _accrueFees();
    }

    /// @dev Reverts when the factory-level global pause / circuit breaker is engaged.
    ///      Widens to `view` once it reads the factory pause state.
    function _requireNotPaused() private pure {
        // TODO(pause): revert if the factory circuit breaker is active.
    }

    /// @dev Enforces the vault's access mode (open / allowlist / permissioned) on the caller.
    ///      Widens to `view` once it reads the access mode from initData.
    function _checkAccess(address /* caller */) private pure {
        // TODO(access): decode the access mode from initData and authorize the caller.
    }

    /// @dev Crystallizes the management fee by minting dilution shares to this contract.
    ///      When no fee can accrue — an uninitialized baseline (e.g. an instance upgraded
    ///      into this version), the type disabled, or an empty vault — the baseline is moved
    ///      to now so that dormant time is never charged later at the current rate. Otherwise
    ///      it mints only when the share amount is non-zero, advancing `lastMgmtAccrual` only
    ///      then so sub-threshold elapsed time is preserved.
    function _accrueFees() private {
        if (
            lastMgmtAccrual == 0 ||
            !_feeConfig.enabled[uint8(FeeType.Management)] ||
            totalSupply() == 0 ||
            totalAssets() == 0
        ) {
            lastMgmtAccrual = uint64(block.timestamp);

            return;
        }

        uint256 feeShares = _pendingManagementFee();
        if (feeShares == 0) return;

        _mint(address(this), feeShares);
        accruedFeeShares += feeShares;
        lastMgmtAccrual = uint64(block.timestamp);

        emit DilutionFeeAccrued(FeeType.Management, feeShares);
    }

    /// @dev Single source of the management-fee computation, shared by `_accrueFees` and the
    ///      `_convertTo*` previews so a preview returned before an operation equals what the
    ///      caller gets after accrual (to the wei, modulo rounding direction).
    /// @return feeShares Dilution shares the pending fee is worth.
    function _pendingManagementFee() private view returns (uint256 feeShares) {
        if (
            lastMgmtAccrual == 0 ||
            !_feeConfig.enabled[uint8(FeeType.Management)]
        ) return 0;

        uint256 supply = totalSupply();
        uint256 assets = totalAssets();
        if (supply == 0 || assets == 0) return 0;

        uint256 feeAssets = LibVaultWrapperMath.managementFeeAssets({
            _totalAssets: assets,
            _rateBps: _feeConfig.rateBps[uint8(FeeType.Management)],
            _elapsed: block.timestamp - lastMgmtAccrual
        });
        feeShares = LibVaultWrapperMath.dilutionShares({
            _feeAssets: feeAssets,
            _totalSupply: supply,
            _totalAssets: assets,
            _decimalsOffset: _decimalsOffset()
        });
    }

    /// @dev Fee-shares pending since the last accrual, used by the effective-supply
    ///      conversion overrides. Isolated as a seam so further dilution fees can extend it
    ///      without changing the conversion math.
    /// @return The dilution shares pending.
    function _pendingFeeShares() private view returns (uint256) {
        return _pendingManagementFee();
    }

    /// @dev Reads the configured rate (bps) for a fee type; 0 when the type is disabled.
    /// @param _feeType The fee type to read.
    /// @return The effective rate in basis points.
    function _rate(FeeType _feeType) private view returns (uint16) {
        uint8 idx = uint8(_feeType);
        if (!_feeConfig.enabled[idx]) return 0;
        return _feeConfig.rateBps[idx];
    }

    /// @dev Books an asset-side fee as idle and not-yet-distributed. The LI.FI/integrator
    ///      split and payout happen elsewhere; here it only tracks the total. No-op on a
    ///      zero fee.
    /// @param _feeType The fee type charged (Deposit or Withdrawal).
    /// @param _feeAssets The fee amount, in assets, kept idle in this contract.
    function _routeFee(FeeType _feeType, uint256 _feeAssets) private {
        if (_feeAssets == 0) return;

        accruedFeeAssets += _feeAssets;

        emit AssetFeeCharged(_feeType, _feeAssets);
    }
}
