// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { MetadataReaderLib } from "solady/utils/MetadataReaderLib.sol";
import { IAccessGate } from "./interfaces/IAccessGate.sol";
import { ILiFiVaultWrapper } from "./interfaces/ILiFiVaultWrapper.sol";
import { ILiFiVaultWrapperFactory } from "./interfaces/ILiFiVaultWrapperFactory.sol";
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { FeeConfig, FeeType, FeeReceiver, FEE_TYPE_COUNT } from "./LiFiVaultWrapperTypes.sol";
import { LibVaultWrapperMath } from "./libraries/LibVaultWrapperMath.sol";

// One over solhint's 15-state default: the 16th declaration is the write-once
// `shareDecimalsOffset` (inflation protection), which packs into the `accessGate`
// slot rather than widening the storage layout.
// solhint-disable max-states-count

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
///      withdrawal. Identity (`underlying`/`adapter`/`owner`) and the initial fee
///      configuration are set write-once in `initialize` (the `FACTORY` is bound at
///      construction). The per-vault admin role is OZ's
///      two-step `owner` (`transferOwnership`/`acceptOwnership`); renouncing it is disabled.
///      All four fee types are charged: management (time-based dilution) and performance
///      (high-water-mark dilution) fee-shares are minted to this contract via `_accrueFees`,
///      and deposit/withdrawal asset fees are kept idle and tracked through `_routeFee`.
///      Every fee is split between LI.FI and the integrator at accrual time using the
///      fee type's own share, into per-recipient counters. A permissionless `distributeFees`
///      pays those tracked entitlements out: LI.FI's parts go to the factory's live
///      `lifiFeeRecipient`, the integrator's parts are fanned across its 1..50 receiver
///      wallets (no re-split happens at distribution). Pause is enforced on the
///      deposit/mint path only (withdrawals stay open). Access control is a single
///      pluggable `IAccessGate` (`accessGate`, zero = fully permissionless): entry checks
///      `isAllowed(receiver)`, holder-to-holder share transfers check
///      `isTransferable(from, to)`, and exits check `isSanctioned` on the share owner and
///      asset receiver — all fail-closed, so a misbehaving gate blocks the guarded
///      operation (including exits) until the owner swaps the gate. Inflation-attack
///      protection is layered: the ERC-4626 virtual-share decimals offset is derived
///      once at `initialize` (`18 - assetDecimals`, floored at a nonzero minimum so even
///      high-decimal assets stay donation-resistant — strongest exactly where a donated
///      wei buys the most), and a deposit-side supply floor keeps depositors out of the
///      dust-denominator regime. EIP-5143 slippage overloads of
///      the four entrypoints bound the realized amount against in-flight share-price
///      or fee-rate changes.
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
    using Math for uint256;

    /// Constants ///

    /// @notice Maximum number of integrator receiver wallets. This is only a sanity cap to
    ///         bound the permissionless `distributeFees` fan-out loop and prevent griefing (an
    ///         oversized receiver set could otherwise make it run out of gas and lock distribution),
    ///         not a product limit.
    uint256 internal constant MAX_FEE_RECEIVERS = 50;

    /// @notice Share-decimals target: `initialize` derives the ERC-4626 virtual-share
    ///         decimals offset as `18 - assetDecimals`, then floors it at
    ///         `MIN_DECIMALS_OFFSET`. Assets with up to 12 decimals get shares normalized
    ///         to exactly 18 decimals; higher-decimal assets take the minimum instead
    ///         (e.g. an 18-decimal asset yields 24-decimal shares) — trading exact-18
    ///         normalization for the donation-griefing bound on `MIN_DECIMALS_OFFSET`.
    uint8 internal constant TARGET_SHARE_DECIMALS = 18;

    /// @notice Lower bound on the derived virtual-share decimals offset, applied even when
    ///         the asset already has >= `TARGET_SHARE_DECIMALS` decimals (where the derived
    ///         offset would otherwise be 0). The offset divides the asset cost of the
    ///         fresh-vault donation grief: to push a deposit below the `MIN_SHARE_SUPPLY`
    ///         floor an attacker must donate ~`MIN_SHARE_SUPPLY / 10 ** offset` times that
    ///         deposit. A minimum of 6 (= log10(`MIN_SHARE_SUPPLY`)) caps that ratio at 1,
    ///         so a donation can never block a deposit larger than itself — and since the
    ///         donation accrues to the first real depositor, the grief is self-defeating.
    ///         With offset 0 a ~1-token donation would block every sub-1M-token first
    ///         deposit into an 18-decimal vault.
    uint8 internal constant MIN_DECIMALS_OFFSET = 6;

    /// @notice Deposit-side total-supply floor, in shares: after any deposit or mint
    ///         the supply must be at least this (exits are exempt — see
    ///         `_enforceSupplyFloor`). With the offset floored at `MIN_DECIMALS_OFFSET`,
    ///         any nonzero first deposit already mints at least this many shares, so the
    ///         floor is a backstop rather than the primary inflation guard: it catches
    ///         the donation-inflated zero-share deposit and the sub-floor dust an exit can
    ///         strand. At >= 18 share decimals it is at most ~1e-12 of one token, so no
    ///         real deposit ever notices it.
    uint256 internal constant MIN_SHARE_SUPPLY = 1e6;

    /// Immutables ///

    /// @notice The factory bound to this implementation at construction: the only address
    ///         allowed to initialize instances, and the source read by later modules for the
    ///         factory-level global circuit breaker, fee bounds, and LI.FI fee recipient.
    ///         Every proxy that reaches `initialize` has therefore passed the factory's
    ///         deploy-time validation (adapter approval, underlying allowlist, fee bounds),
    ///         so a counterfeit proxy pointed at the official beacon can never be initialized
    ///         with unvetted parameters.
    address public immutable FACTORY;

    /// Storage ///

    /// @notice The yield source this wrapper deposits into (e.g. an ERC-4626 vault).
    address public underlying;
    /// @notice The approved yield adapter the wrapper routes deposits/withdrawals through.
    address public adapter;
    /// @notice Whether this clone's deposits are paused by the integrator (the per-vault
    ///         `owner`), the only authority over this flag. LI.FI has no per-instance pause;
    ///         its lever is the factory-level global circuit breaker, a separate source read
    ///         live in `depositsPaused`. Both gate inflows, neither gates exits.
    bool public paused;
    /// @notice The integrator's fee share (bps) per fee type (indexed by FeeType ordinal),
    ///         snapshotted from the factory at deploy. LI.FI receives the remainder of
    ///         each fee.
    uint16[FEE_TYPE_COUNT] public integratorShareBps;
    /// @notice The pluggable access gate governing this instance's perimeter;
    ///         address(0) = fully permissionless (the default posture). Swappable
    ///         instantly by the per-vault `owner` via `setAccessGate`.
    address public accessGate;
    /// @notice The ERC-4626 virtual-share decimals offset for this instance, written
    ///         once at `initialize` (`18 - assetDecimals`, floored at `MIN_DECIMALS_OFFSET`)
    ///         and never changed after — it prices shares, so mutating it would reprice
    ///         every holder. Packs into the `accessGate` slot.
    uint8 public shareDecimalsOffset;

    /// @dev Per-fee-type rates (0 = disabled), validated by the factory.
    FeeConfig internal _feeConfig;

    /// @notice LI.FI's part of the dilution fee-shares minted to this contract and not
    ///         yet paid out. Split at accrual; packed with the integrator counter so one
    ///         accrual touches a single slot. All four fee counters saturate at the
    ///         uint128 max instead of reverting (see `_splitFee`).
    uint128 public lifiFeeShares;
    /// @notice The integrator's part of the dilution fee-shares minted to this contract
    ///         and not yet paid out.
    uint128 public integratorFeeShares;
    /// @notice LI.FI's part of the asset-side (deposit/withdrawal) fees held idle in this
    ///         contract and not yet paid out. Kept out of the yield source so it does not
    ///         move PPS.
    uint128 public lifiFeeAssets;
    /// @notice The integrator's part of the asset-side fees held idle in this contract
    ///         and not yet paid out.
    uint128 public integratorFeeAssets;
    /// @notice Timestamp of the last management-fee crystallization.
    uint64 public lastMgmtAccrual;
    /// @notice Performance-fee high-water mark: the highest post-crystallization price
    ///         per share (scaled by `LibVaultWrapperMath.PPS_SCALE`). Anchored at
    ///         `initialize`, re-anchored upward (never down) when the performance fee
    ///         is enabled from disabled, and ratcheted whenever a performance accrual
    ///         mints shares.
    uint192 public perfHighWaterMarkPps;

    /// @notice Integrator payout wallets (1..50) with their bps split, each packed into one
    ///         slot (address + uint16). Set at `initialize` and mutable by the integrator;
    ///         always non-empty after deploy. Bps sum to 100%.
    FeeReceiver[] public integratorFeeReceivers;

    /// @dev Reserved slots so future versions can append wrapper-level state without
    ///      shifting any storage that inheriting/derived modules occupy. This impl sits
    ///      behind an upgradeable beacon, so storage layout is an upgrade invariant: only
    ///      append (consuming this gap), never reorder fields or the inheritance list.
    uint256[50] private __gap;

    /// Initialization ///

    /// @dev Locks the implementation contract so only beacon proxies (which have their own
    ///      storage) can be initialized — never the implementation itself. Binds the
    ///      implementation to the single factory allowed to initialize proxies; with a
    ///      CREATE3-deployed factory its address is predictable before it exists, so the
    ///      implementation can be deployed first and the beacon/factory wired after.
    /// @param _expectedFactory The factory whose deploys may initialize instances.
    constructor(address _expectedFactory) {
        if (_expectedFactory == address(0)) revert ZeroAddress();
        FACTORY = _expectedFactory;
        _disableInitializers();
    }

    /// @inheritdoc ILiFiVaultWrapper
    /// @dev Factory-only and single-shot: the bound factory deploys and initializes in one
    ///      transaction, and OpenZeppelin's `initializer` guard blocks any later call. All
    ///      arguments are validated by the factory before this is reached. Share name/symbol
    ///      derive from the asset symbol (e.g. "LI.FI Earn USDC" / "lfUSDC"), falling back to
    ///      "VW" when the asset exposes none.
    function initialize(
        address _underlying,
        address _adapter,
        address _vaultWrapperAdmin,
        uint16[FEE_TYPE_COUNT] calldata _integratorShareBps,
        FeeConfig calldata _fees,
        FeeReceiver[] calldata _receivers,
        address _accessGate
    ) external initializer {
        if (msg.sender != FACTORY) revert NotFactory();
        if (
            _underlying == address(0) ||
            _adapter == address(0) ||
            _vaultWrapperAdmin == address(0)
        ) revert ZeroAddress();
        for (uint256 i; i < FEE_TYPE_COUNT; ++i) {
            if (_integratorShareBps[i] >= 10_000)
                revert InvalidIntegratorShareBps(_integratorShareBps[i]);
        }

        // Persist all calldata inputs before resolving the asset, so none of the calldata
        // parameters stay live across that external call. `initialize` would otherwise
        // exceed the stack limit without via_ir (the receiver set is a two-slot calldata
        // array; see the subsystem OZ-v5 stack-pressure note).
        _setIntegratorFeeReceivers(_receivers);
        __Ownable_init(_vaultWrapperAdmin);
        underlying = _underlying;
        adapter = _adapter;
        integratorShareBps = _integratorShareBps;
        _feeConfig = _fees;
        if (_accessGate != address(0)) {
            accessGate = _accessGate;
            emit AccessGateUpdated(_accessGate);
        }
        lastMgmtAccrual = uint64(block.timestamp);

        // Resolve the asset only after every calldata input is persisted, reading
        // adapter/underlying from storage rather than the deep calldata params, to keep
        // this external call shallow on the stack.
        address asset = IYieldAdapter(adapter).resolveAsset(underlying);
        if (asset == address(0)) revert ZeroAddress();

        _initErc4626Metadata(asset);
        // Read the asset's decimals directly, not through decimals(): OZ's ERC-4626 init
        // silently substitutes 18 when the token's decimals() is unreadable, and sizing
        // the offset off that fallback would quietly weaken inflation protection for a
        // low-decimal asset. The offset must be written before anything consumes
        // _decimalsOffset() — the watermark anchor below prices through it.
        uint8 assetDecimals = _readAssetDecimals(asset);
        uint8 derivedOffset = assetDecimals < TARGET_SHARE_DECIMALS
            ? TARGET_SHARE_DECIMALS - assetDecimals
            : 0;
        shareDecimalsOffset = derivedOffset < MIN_DECIMALS_OFFSET
            ? MIN_DECIMALS_OFFSET
            : derivedOffset;

        // Anchor the performance watermark at the empty-vault share price, computed pure
        // (supply and position are always 0 on a fresh single-shot-initialized proxy).
        // Deliberately NOT read through the adapter: an underlying whose empty-position
        // query reverts must not brick deployment. Assets donated to the predicted
        // address before deployment therefore count as gain at the first accrual —
        // charging a donation is harmless and disarms watermark-seeding games.
        perfHighWaterMarkPps = SafeCast.toUint192(
            LibVaultWrapperMath.pricePerShare(0, 0, _decimalsOffset())
        );

        emit VaultWrapperConfigured(asset, underlying, adapter, owner());
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

    /// @dev Reads the asset's ERC-20 decimals via an explicit staticcall and reverts if the
    ///      token does not expose a well-formed `decimals()`. Mirrors OZ's own detection
    ///      (`success && length >= 32 && value <= type(uint8).max`) but rejects the asset
    ///      instead of falling back to 18, so the virtual-share offset is never sized off a
    ///      fabricated decimals value.
    function _readAssetDecimals(address _asset) private view returns (uint8) {
        (bool ok, bytes memory data) = _asset.staticcall(
            abi.encodeCall(IERC20Metadata.decimals, ())
        );
        if (!ok || data.length < 32) revert AssetDecimalsUnavailable();

        uint256 decoded = abi.decode(data, (uint256));
        if (decoded > type(uint8).max) revert AssetDecimalsUnavailable();

        return uint8(decoded);
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

    /// @dev The per-instance offset derived at `initialize` (see `shareDecimalsOffset`);
    ///      OZ's default is a constant 0.
    function _decimalsOffset() internal view override returns (uint8) {
        return shareDecimalsOffset;
    }

    /// @dev Values shares against an effective supply that already includes the management
    ///      fee-shares pending since the last accrual, so previews match what a user gets
    ///      after `_accrueFees` crystallizes them at the top of the operation.
    function _convertToShares(
        uint256 _assets,
        Math.Rounding _rounding
    ) internal view override returns (uint256) {
        uint256 supply = totalSupply();
        uint256 assets = totalAssets();

        return
            LibVaultWrapperMath.convertToShares({
                _assets: _assets,
                _totalSupply: supply,
                _pendingFeeShares: _pendingFeeShares(supply, assets),
                _totalAssets: assets,
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
        uint256 supply = totalSupply();
        uint256 assets = totalAssets();

        return
            LibVaultWrapperMath.convertToAssets({
                _shares: _shares,
                _totalSupply: supply,
                _pendingFeeShares: _pendingFeeShares(supply, assets),
                _totalAssets: assets,
                _decimalsOffset: _decimalsOffset(),
                _rounding: _rounding
            });
    }

    /// Fee config getters ///

    /// @notice Returns the configured rate (bps) for a fee type.
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return The fee rate in basis points.
    function feeRate(uint8 _feeType) external view returns (uint16) {
        if (_feeType >= FEE_TYPE_COUNT) revert InvalidFeeType(_feeType);
        return _feeConfig.rateBps[_feeType];
    }

    /// @notice Returns whether a fee type is enabled (a non-zero rate is the enabled flag).
    /// @param _feeType The FeeType ordinal (0-3).
    /// @return True if the fee type is enabled.
    function feeEnabled(uint8 _feeType) external view returns (bool) {
        if (_feeType >= FEE_TYPE_COUNT) revert InvalidFeeType(_feeType);
        return _feeConfig.rateBps[_feeType] != 0;
    }

    /// ERC-4626 entrypoints (reentrancy-guarded) ///

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reverts `DepositsPaused` while any pause source is engaged, so the named reason
    ///      surfaces to callers rather than OZ's `ERC4626ExceededMaxDeposit` from the
    ///      `maxDeposit == 0` view (which stays 0 for EIP-4626 consumers). The shared
    ///      `_deposit` seam enforces the post-operation supply floor (see
    ///      `_enforceSupplyFloor`).
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant returns (uint256 shares) {
        if (depositsPaused()) revert DepositsPaused();
        _checkDepositAccess(receiver);
        _accrueFees();

        shares = super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reverts `DepositsPaused` while any pause source is engaged, so the named reason
    ///      surfaces to callers rather than OZ's `ERC4626ExceededMaxMint` from the
    ///      `maxMint == 0` view (which stays 0 for EIP-4626 consumers). The shared
    ///      `_deposit` seam enforces the post-operation supply floor (see
    ///      `_enforceSupplyFloor`).
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant returns (uint256 assets) {
        if (depositsPaused()) revert DepositsPaused();
        _checkDepositAccess(receiver);
        _accrueFees();

        assets = super.mint(shares, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Deliberately NOT floor-checked (see `_enforceSupplyFloor` for why exits
    ///      are exempt): an exit must always be able to empty the caller's position.
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        _checkExitAccess(owner, receiver);
        _accrueFees();

        return super.withdraw(assets, receiver, owner);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Deliberately NOT floor-checked (see `_enforceSupplyFloor` for why exits
    ///      are exempt): an exit must always be able to empty the caller's position.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        _checkExitAccess(owner, receiver);
        _accrueFees();

        return super.redeem(shares, receiver, owner);
    }

    /// EIP-5143 slippage-guarded entrypoints ///
    /// @dev Thin overloads of the four ERC-4626 entrypoints that bound the realized
    ///      amount, per EIP-5143. Each routes through its standard entrypoint (an
    ///      internal call, so msg.sender semantics and the pause/access/accrual/
    ///      reentrancy guards apply identically) and reverts `SlippageExceeded` when
    ///      the result crosses the caller's bound. The bound is checked on the amount
    ///      the standard entrypoint actually returns, so it also catches an integrator
    ///      fee-rate change landing between the caller's quote and execution.

    /// @notice Deposits exactly `_assets` for `_receiver`, reverting if fewer than
    ///         `_minShares` shares are minted.
    /// @param _assets The exact asset amount to deposit.
    /// @param _receiver The share receiver.
    /// @param _minShares The minimum acceptable amount of shares minted.
    /// @return shares The shares actually minted.
    function deposit(
        uint256 _assets,
        address _receiver,
        uint256 _minShares
    ) external override returns (uint256 shares) {
        shares = deposit(_assets, _receiver);
        if (shares < _minShares) revert SlippageExceeded(shares, _minShares);
    }

    /// @notice Mints exactly `_shares` for `_receiver`, reverting if more than
    ///         `_maxAssets` assets are pulled.
    /// @param _shares The exact share amount to mint.
    /// @param _receiver The share receiver.
    /// @param _maxAssets The maximum acceptable amount of assets pulled.
    /// @return assets The assets actually pulled.
    function mint(
        uint256 _shares,
        address _receiver,
        uint256 _maxAssets
    ) external override returns (uint256 assets) {
        assets = mint(_shares, _receiver);
        if (assets > _maxAssets) revert SlippageExceeded(assets, _maxAssets);
    }

    /// @notice Withdraws exactly `_assets` to `_receiver`, reverting if more than
    ///         `_maxShares` shares are burned.
    /// @param _assets The exact asset amount to withdraw.
    /// @param _receiver The asset receiver.
    /// @param _owner The share owner being exited.
    /// @param _maxShares The maximum acceptable amount of shares burned.
    /// @return shares The shares actually burned.
    function withdraw(
        uint256 _assets,
        address _receiver,
        address _owner,
        uint256 _maxShares
    ) external override returns (uint256 shares) {
        shares = withdraw(_assets, _receiver, _owner);
        if (shares > _maxShares) revert SlippageExceeded(shares, _maxShares);
    }

    /// @notice Redeems exactly `_shares` to `_receiver`, reverting if fewer than
    ///         `_minAssets` assets are paid out.
    /// @param _shares The exact share amount to redeem.
    /// @param _receiver The asset receiver.
    /// @param _owner The share owner being exited.
    /// @param _minAssets The minimum acceptable amount of assets paid out.
    /// @return assets The assets actually paid out.
    function redeem(
        uint256 _shares,
        address _receiver,
        address _owner,
        uint256 _minAssets
    ) external override returns (uint256 assets) {
        assets = redeem(_shares, _receiver, _owner);
        if (assets < _minAssets) revert SlippageExceeded(assets, _minAssets);
    }

    /// ERC-4626 fee-adjusted previews and limits ///
    /// @dev Per EIP-4626, previews MUST NOT account for deposit limits, so `previewDeposit`/
    ///      `previewMint` intentionally ignore pause and return a positive estimate even while
    ///      `depositsPaused()` is true (when the matching `deposit`/`mint` would revert
    ///      `DepositsPaused`). `maxDeposit`/`maxMint` below are the pause-aware limit views.

    /// @inheritdoc ERC4626Upgradeable
    function previewDeposit(
        uint256 assets
    ) public view override returns (uint256) {
        uint256 depositFee = LibVaultWrapperMath.feeOnTotal({
            _assets: assets,
            _feeBps: _rate(FeeType.Deposit)
        });

        return super.previewDeposit(assets - depositFee);
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
        uint256 withdrawalFee = LibVaultWrapperMath.feeOnRaw({
            _assets: assets,
            _feeBps: _rate(FeeType.Withdrawal)
        });

        return super.previewWithdraw(assets + withdrawalFee);
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

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while any pause source is engaged, or while the access gate rejects
    ///      the receiver, so EIP-4626 consumers see the vault as closed to deposits and do
    ///      not build deposits that would revert. Mirrors `deposit`'s guards; a reverting
    ///      gate reverts this view too (fail-closed, like the entrypoint).
    function maxDeposit(
        address receiver
    ) public view override returns (uint256) {
        if (depositsPaused() || !_depositAllowed(receiver)) return 0;

        return super.maxDeposit(receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while any pause source is engaged, or while the access gate rejects
    ///      the receiver, so EIP-4626 consumers see the vault as closed to mints and do
    ///      not build mints that would revert. Mirrors `mint`'s guards; a reverting gate
    ///      reverts this view too (fail-closed, like the entrypoint).
    function maxMint(address receiver) public view override returns (uint256) {
        if (depositsPaused() || !_depositAllowed(receiver)) return 0;

        return super.maxMint(receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while the access gate flags the owner as sanctioned, mirroring
    ///      `withdraw`'s exit freeze (the asset receiver is unknowable in this view and
    ///      is checked in the entrypoint only).
    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        if (_sanctioned(owner)) return 0;

        return super.maxWithdraw(owner);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while the access gate flags the owner as sanctioned, mirroring
    ///      `redeem`'s exit freeze (the asset receiver is unknowable in this view and
    ///      is checked in the entrypoint only).
    function maxRedeem(address owner) public view override returns (uint256) {
        if (_sanctioned(owner)) return 0;

        return super.maxRedeem(owner);
    }

    /// Internal ///

    /// @dev Deposit-side supply floor: after a non-zero deposit/mint the total supply must
    ///      be at least `MIN_SHARE_SUPPLY`, so no depositor ever transacts against a
    ///      dust-sized share denominator (the first-depositor inflation attack's
    ///      precondition) — the existing supply plus the deposit's own mint always sum
    ///      to the floor, capping a donation-griefer's damage at ~`1/MIN_SHARE_SUPPLY`
    ///      of the donation. A post-operation supply of exactly zero is rejected too:
    ///      that is only reachable when a non-zero deposit mints zero shares (its assets
    ///      rounded away against a donation-inflated, zero-supply vault), which would
    ///      forward the caller's assets into the yield source for no shares — a 100% loss.
    ///      A zero-amount `deposit(0)`/`mint(0)` moves nothing and mints nothing, so the
    ///      caller skips this check entirely: the no-op stays a no-op even in a sub-floor
    ///      state. Exits are also deliberately exempt (they never call this): `_accrueFees`
    ///      mints fee shares to this contract, so an exit-side check could revert the last
    ///      holder's full exit against sub-floor fee-share residue — and exits must always
    ///      work. An exit may therefore strand a sub-floor supply, but any non-zero deposit
    ///      into that state is still protected by this check. Not reflected in the max*
    ///      limit views (a documented EIP-4626 deviation): with the offset floored at
    ///      `MIN_DECIMALS_OFFSET`, an ordinary deposit into a clean vault always clears the
    ///      floor, so the only amounts `<= maxDeposit` that still revert are non-zero
    ///      deposits into a donation-inflated empty vault or an exit-stranded sub-floor
    ///      vault — edge states not worth modeling in the limit views.
    function _enforceSupplyFloor() private view {
        uint256 supply = totalSupply();
        if (supply < MIN_SHARE_SUPPLY)
            revert SupplyBelowMinimum(supply, MIN_SHARE_SUPPLY);
    }

    /// @dev Skims the entry fee and forwards the remaining deposited assets into the yield
    ///      source via the adapter. OZ's `_deposit` has already pulled the asset in and minted
    ///      shares. Reverts if the adapter reports the source accepted less than the net
    ///      deposit (a short-accepting source), so assets cannot be left stranded in the
    ///      wrapper against already-minted shares. A zero net amount (deposit fee consumed the
    ///      whole — sub-fee-denominator dust — input, or a bare zero deposit) skips the adapter
    ///      call entirely: there is nothing to invest, the fee is already routed, and a standard
    ///      ERC-4626 source reverts on a zero-asset forward, so short-circuiting keeps `deposit`
    ///      non-reverting in exactly the cases where `previewDeposit` returns 0. Pause is
    ///      enforced upstream in `deposit`/`mint`. Both `deposit` and `mint` route through
    ///      this seam, so the post-operation supply floor is enforced here once for every
    ///      inflow entrypoint (a zero-amount call mints nothing and skips it); exits go
    ///      through `_withdraw` and are structurally exempt (see `_enforceSupplyFloor`).
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        super._deposit(caller, receiver, assets, shares);
        if (assets != 0) _enforceSupplyFloor();

        uint256 depositFee = LibVaultWrapperMath.feeOnTotal({
            _assets: assets,
            _feeBps: _rate(FeeType.Deposit)
        });
        _routeFee(FeeType.Deposit, depositFee);
        uint256 invested = assets - depositFee;
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
    ///      rolls back and the owner keeps their shares), skims the fee (plus any excess a
    ///      round-up source paid beyond the owed amount, so no idle asset is left unattributed),
    ///      then transfers exactly `_assets` to the receiver. A zero withdrawal (a dust redeem
    ///      whose `previewRedeem` is 0, or a bare `withdraw(0)`) short-circuits before the
    ///      adapter call — mirroring `_deposit` — so sources that reject zero-amount
    ///      withdrawals cannot block exits that preview as 0.
    function _transferOut(address _to, uint256 _assets) internal override {
        if (_assets == 0) return;

        address assetToken = asset();
        uint256 withdrawalFee = LibVaultWrapperMath.feeOnRaw({
            _assets: _assets,
            _feeBps: _rate(FeeType.Withdrawal)
        });
        uint256 owed = _assets + withdrawalFee;
        uint256 withdrawn = _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.withdraw,
                (assetToken, underlying, owed)
            )
        );
        if (withdrawn < owed) revert AdapterWithdrawShortfall(owed, withdrawn);
        // A round-up source may pay more than owed; book the excess with the fee so
        // every idle asset stays attributed for payout instead of stranding as
        // untracked dust that silently left AUM.
        _routeFee(FeeType.Withdrawal, withdrawalFee + (withdrawn - owed));
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

    /// Fee config ///

    /// @notice Sets the rate for any fee type.
    /// @dev Only the owner may call. A zero rate disables the fee and skips
    ///      bounds validation (turning a fee off is always allowed); a non-zero rate must
    ///      sit within the factory's live bounds for the type. Accrues at the OLD rate
    ///      first so elapsed time (management) and gains above the watermark
    ///      (performance) are priced before the change. Enabling the performance fee
    ///      from disabled re-anchors the watermark UP to the current share price when
    ///      that is higher, so gains made while it was disabled are never charged
    ///      retroactively; it never moves the watermark down, so toggling the fee off
    ///      and on after a drawdown cannot re-charge the recovery to the old peak.
    /// @param _feeType The fee type to update.
    /// @param _newRateBps The new rate in basis points (0 disables the fee).
    function setFeeRate(
        FeeType _feeType,
        uint16 _newRateBps
    ) external onlyOwner {
        _accrueFees();

        uint8 idx = uint8(_feeType);
        if (_newRateBps != 0) {
            (uint16 minBps, uint16 maxBps) = ILiFiVaultWrapperFactory(FACTORY)
                .feeBounds(_feeType);
            if (_newRateBps < minBps || _newRateBps > maxBps)
                revert FeeRateOutOfBounds(_newRateBps, minBps, maxBps);
            if (
                _feeType == FeeType.Performance && _feeConfig.rateBps[idx] == 0
            ) {
                uint192 currentPps = SafeCast.toUint192(
                    LibVaultWrapperMath.pricePerShare(
                        totalSupply(),
                        totalAssets(),
                        _decimalsOffset()
                    )
                );
                // Up-only: anchoring below the stored watermark would let the owner
                // toggle the fee off/on at a trough and charge the recovery back to
                // the old peak — the double-charge the watermark exists to prevent.
                if (currentPps > perfHighWaterMarkPps) {
                    perfHighWaterMarkPps = currentPps;
                }
            }
        }
        _feeConfig.rateBps[idx] = _newRateBps;

        emit FeeConfigUpdated(_feeType, _newRateBps);
    }

    /// Fee distribution ///

    /// @notice Replace the integrator's payout wallets and their bps split.
    /// @dev Owner-controlled (the per-vault admin). Re-validates the full set, so
    ///      the 1..50 / sum-to-100% invariant set at `initialize` always holds — the receiver
    ///      set can never be emptied. Accrued-but-not-yet-distributed integrator fees are held
    ///      as a single total with no per-wallet bookkeeping, so they will be paid to the NEW
    ///      receiver set at the next `distributeFees`, not the outgoing one. Call `distributeFees`
    ///      before rotating receivers if the outgoing wallets should receive their earned share.
    /// @param _receivers The new payout wallets + bps split (1..50, non-zero, summing to 100%).
    function setIntegratorFeeReceivers(
        FeeReceiver[] calldata _receivers
    ) external onlyOwner {
        _setIntegratorFeeReceivers(_receivers);
    }

    /// @notice Permissionless: crystallize and pay out all tracked fee entitlements.
    /// @dev Accrues pending management/performance fees first (so distribution is complete even
    ///      while deposits are paused, when the deposit/mint accrual cannot run), then pays
    ///      out the four per-recipient counters booked at accrual — the LI.FI/integrator
    ///      split already happened when each fee accrued, so nothing is re-split here.
    ///      LI.FI's parts go to the factory's live `lifiFeeRecipient`; the integrator's
    ///      parts are fanned across its wallets by bps (last absorbs the rounding
    ///      remainder). CEI: all four counters are zeroed before any transfer, and the call
    ///      is `nonReentrant`. A failing transfer on either side (e.g. a blacklisted
    ///      integrator wallet, or a blocked LI.FI recipient) does not revert the
    ///      distribution — its share is left in the wrapper and re-booked as still-owed,
    ///      so the two sides never hold each other's payout hostage. The integrator can
    ///      rotate to a working wallet via `setIntegratorFeeReceivers`, and governance can
    ///      repoint the LI.FI recipient via the factory's `setLifiFeeRecipient`, then call
    ///      this again to claim it. No-op when every counter is empty.
    function distributeFees() external nonReentrant {
        _accrueFees();

        uint256 lifiAssets = lifiFeeAssets;
        uint256 integratorAssets = integratorFeeAssets;
        uint256 lifiShares = lifiFeeShares;
        uint256 integratorShares = integratorFeeShares;
        if (
            lifiAssets == 0 &&
            integratorAssets == 0 &&
            lifiShares == 0 &&
            integratorShares == 0
        ) return;

        lifiFeeAssets = 0;
        integratorFeeAssets = 0;
        lifiFeeShares = 0;
        integratorFeeShares = 0;

        address lifiRecipient = ILiFiVaultWrapperFactory(FACTORY)
            .lifiFeeRecipient();

        (
            uint256 assetsIntegratorRetained,
            uint256 assetsLifiRetained
        ) = _distributeFeePool(
                asset(),
                lifiAssets,
                integratorAssets,
                lifiRecipient
            );
        (
            uint256 sharesIntegratorRetained,
            uint256 sharesLifiRetained
        ) = _distributeFeePool(
                address(this),
                lifiShares,
                integratorShares,
                lifiRecipient
            );

        // Fees whose transfer failed stay in the wrapper as still-owed fees, claimable on
        // a later distribution once the recipient is fixed — the integrator by rotating
        // wallets, LI.FI by repointing the factory recipient (nonReentrant guards these
        // post-transfer writes).
        integratorFeeAssets = uint128(assetsIntegratorRetained);
        integratorFeeShares = uint128(sharesIntegratorRetained);
        lifiFeeAssets = uint128(assetsLifiRetained);
        lifiFeeShares = uint128(sharesLifiRetained);
    }

    /// Pause controls ///

    /// @notice Pause this clone's deposits. Withdrawals stay open. Integrator-only (`owner`);
    ///         LI.FI has no per-instance pause.
    function pause() external onlyOwner {
        paused = true;
        emit PauseSet(true, msg.sender);
    }

    /// @notice Resume this clone's deposits. Integrator-only (`owner`). Does not affect the
    ///         factory-level global circuit breaker (LI.FI's only lever over this clone).
    function unpause() external onlyOwner {
        paused = false;
        emit PauseSet(false, msg.sender);
    }

    /// @notice Whether deposits are currently halted by any pause source.
    /// @return True if this clone is paused by the integrator or the factory-level global
    ///         circuit breaker is engaged.
    function depositsPaused() public view returns (bool) {
        return paused || ILiFiVaultWrapperFactory(FACTORY).globalPaused();
    }

    /// Access control ///
    /// @dev Every state-changing entrypoint (deposit/mint/withdraw/redeem) runs its access
    ///      check then `_accrueFees` first, so the operation is authorized and transacts at
    ///      the post-accrual share price. All checks target the END PARTIES (share receiver
    ///      on entry, share owner + asset receiver on exit) and never `msg.sender`, so
    ///      direct ERC-4626 calls and proxied (Composer) flows are gated identically. Every
    ///      gate call is fail-closed with no try/catch: a misbehaving gate blocks the
    ///      guarded operation — including exits — and its own error bubbles verbatim; the
    ///      recovery path is the owner's instant `setAccessGate`. Gas-griefing the gate call
    ///      into a false failure is not a concern: there is no catch to reach, an OOG simply
    ///      reverts the operation.
    ///      TODO(pause): any future inflow entrypoint (e.g. the V2 reward-injection path) must
    ///      gate on `if (depositsPaused()) revert DepositsPaused();` like `deposit`/`mint`.

    /// @notice Sets or clears this instance's access gate.
    /// @dev Owner-only and instant, like every other per-vault setter — the integrator
    ///      brings their own authority model (EOA/multisig/timelock). The gate is not
    ///      probed or validated: a misconfigured gate closes the instance fail-closed
    ///      until this setter repairs it, and only harms the integrator's own product.
    /// @param _accessGate The new gate; address(0) = fully permissionless.
    function setAccessGate(address _accessGate) external onlyOwner {
        accessGate = _accessGate;

        emit AccessGateUpdated(_accessGate);
    }

    /// @dev Entry screen: the share receiver must be allowed by the gate (which is
    ///      expected to fold its own sanctions view into `isAllowed`). No-op when no
    ///      gate is set.
    /// @param _receiver The share receiver of the deposit/mint.
    function _checkDepositAccess(address _receiver) private view {
        address gate = accessGate;
        if (gate == address(0)) return;
        if (!IAccessGate(gate).isAllowed(_receiver))
            revert AccountNotAllowed(_receiver);
    }

    /// @dev Exit screen: sanctions-only, so any non-sanctioned holder can always exit
    ///      (even after falling off an allowlist). Screens the share owner (freezes a
    ///      sanctioned holder's funds) AND the asset receiver (never pays assets out to a
    ///      sanctioned address; a non-sanctioned owner just picks another receiver).
    ///      No-op when no gate is set.
    /// @param _owner The share owner being exited.
    /// @param _receiver The asset receiver of the exit.
    function _checkExitAccess(address _owner, address _receiver) private view {
        address gate = accessGate;
        if (gate == address(0)) return;
        if (IAccessGate(gate).isSanctioned(_owner))
            revert AccountSanctioned(_owner);
        if (_receiver != _owner && IAccessGate(gate).isSanctioned(_receiver))
            revert AccountSanctioned(_receiver);
    }

    /// @dev Whether the gate admits `_receiver` on the deposit path; true when no gate
    ///      is set. Non-reverting only insofar as the gate itself does not revert.
    /// @param _receiver The share receiver to screen.
    /// @return True if deposits/mints for `_receiver` would pass the access check.
    function _depositAllowed(address _receiver) private view returns (bool) {
        address gate = accessGate;

        return gate == address(0) || IAccessGate(gate).isAllowed(_receiver);
    }

    /// @dev Whether the gate flags `_account` as sanctioned; false when no gate is set.
    /// @param _account The account to screen.
    /// @return True if `_account` is sanction-flagged by the gate.
    function _sanctioned(address _account) private view returns (bool) {
        address gate = accessGate;

        return gate != address(0) && IAccessGate(gate).isSanctioned(_account);
    }

    /// @dev Gates holder-to-holder share transfers on `isTransferable`. Structurally
    ///      exempt — never reaching the gate — are mints (`from == 0`; entry is already
    ///      screened in `deposit`/`mint`, and `_accrueFees` mints fee-shares to this
    ///      contract on every operation), burns (`to == 0`; exits are screened in
    ///      `withdraw`/`redeem`), and fee payouts from the wrapper itself
    ///      (`from == address(this)`; `distributeFees` must stay unblockable and the recipients'
    ///      entitlement was booked at accrual). The fee machinery must never depend on
    ///      gate behavior.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from != address(0) && to != address(0) && from != address(this)) {
            address gate = accessGate;
            if (
                gate != address(0) &&
                !IAccessGate(gate).isTransferable(from, to)
            ) revert TransferNotAllowed(from, to);
        }

        super._update(from, to, value);
    }

    /// @dev Crystallizes the management and performance fees by minting dilution shares
    ///      to this contract, splitting each between LI.FI and the integrator as it is
    ///      booked. The management baseline ALWAYS advances to now, whether or not
    ///      anything was minted: elapsed time must never outlive the accrual that priced
    ///      it, or it would be re-priced later against a larger AUM (charging depositors
    ///      for time before they were invested — a dormant dust vault could confiscate
    ///      most of a new deposit) or against a new rate (voiding `setFeeRate`'s
    ///      accrue-at-old-rate-first guarantee). The cost is that elapsed time whose fee
    ///      floors to zero shares is dropped — at most ~one share's worth of assets per
    ///      accrual, favouring holders. The performance fee is charged AFTER the
    ///      management dilution (perf is net of management), and its watermark ratchets
    ///      to the post-crystallization share price only when shares were actually
    ///      minted — an uncharged gain stays chargeable, unlike elapsed time.
    function _accrueFees() private {
        bool mgmtEnabled = _feeConfig.rateBps[uint8(FeeType.Management)] != 0;
        bool perfEnabled = _feeConfig.rateBps[uint8(FeeType.Performance)] != 0;
        if (!mgmtEnabled && !perfEnabled) {
            lastMgmtAccrual = uint64(block.timestamp);
            return;
        }

        uint256 supply = totalSupply();
        uint256 assets = totalAssets();

        uint256 mgmtShares = _pendingManagementFee(supply, assets);
        lastMgmtAccrual = uint64(block.timestamp);
        if (mgmtShares != 0) {
            _mint(address(this), mgmtShares);
            _bookDilution(FeeType.Management, mgmtShares);
            supply += mgmtShares;
        }

        uint256 perfShares = _pendingPerformanceFee(supply, assets);
        if (perfShares != 0) {
            _mint(address(this), perfShares);
            _bookDilution(FeeType.Performance, perfShares);
            supply += perfShares;
            perfHighWaterMarkPps = SafeCast.toUint192(
                LibVaultWrapperMath.pricePerShare(
                    supply,
                    assets,
                    _decimalsOffset()
                )
            );
        }
    }

    /// @dev Single source of the management-fee computation, shared by `_accrueFees` and the
    ///      `_convertTo*` previews so a preview returned before an operation equals what the
    ///      caller gets after accrual (to the wei, modulo rounding direction). Parameterized
    ///      so the conversion overrides, which already hold supply/assets, do not repeat the
    ///      external `totalAssets()` adapter round-trip.
    /// @param _supply The current total supply (pre-accrual).
    /// @param _assets The current total assets.
    /// @return feeShares Dilution shares the pending fee is worth.
    function _pendingManagementFee(
        uint256 _supply,
        uint256 _assets
    ) private view returns (uint256 feeShares) {
        uint16 rateBps = _feeConfig.rateBps[uint8(FeeType.Management)];
        if (
            lastMgmtAccrual == 0 ||
            rateBps == 0 ||
            _supply == 0 ||
            _assets == 0
        ) return 0;

        uint256 elapsed = block.timestamp - lastMgmtAccrual;
        if (elapsed == 0) return 0;

        uint256 mgmtFeeAssets = LibVaultWrapperMath.managementFeeAssets({
            _totalAssets: _assets,
            _rateBps: rateBps,
            _elapsed: elapsed
        });
        feeShares = LibVaultWrapperMath.dilutionShares({
            _feeAssets: mgmtFeeAssets,
            _totalSupply: _supply,
            _totalAssets: _assets,
            _decimalsOffset: _decimalsOffset()
        });
    }

    /// @dev Dilution shares the pending performance fee is worth: the fee on the share-
    ///      price gain above the high-water mark. Called with the management fee-shares
    ///      already included in `_supply` (whether minted or still pending), so the fee
    ///      is charged on gains net of management dilution — the same sequence in
    ///      accrual and previews.
    /// @param _supply The total supply including any management fee-shares.
    /// @param _assets The current total assets.
    /// @return Dilution shares the pending fee is worth.
    function _pendingPerformanceFee(
        uint256 _supply,
        uint256 _assets
    ) private view returns (uint256) {
        uint16 rateBps = _feeConfig.rateBps[uint8(FeeType.Performance)];
        if (rateBps == 0) return 0;

        uint256 hwm = perfHighWaterMarkPps;
        if (hwm == 0) return 0;

        uint256 perfFeeAssets = LibVaultWrapperMath.performanceFeeAssets({
            _totalAssets: _assets,
            _totalSupply: _supply,
            _hwmPps: hwm,
            _rateBps: rateBps,
            _decimalsOffset: _decimalsOffset()
        });

        return
            LibVaultWrapperMath.dilutionShares({
                _feeAssets: perfFeeAssets,
                _totalSupply: _supply,
                _totalAssets: _assets,
                _decimalsOffset: _decimalsOffset()
            });
    }

    /// @dev Fee-shares pending since the last accrual, used by the effective-supply
    ///      conversion overrides. Management first, then performance on the post-
    ///      management effective supply — the exact sequence `_accrueFees` crystallizes
    ///      in, so previews match execution.
    /// @param _supply The current total supply (pre-accrual).
    /// @param _assets The current total assets.
    /// @return The dilution shares pending.
    function _pendingFeeShares(
        uint256 _supply,
        uint256 _assets
    ) private view returns (uint256) {
        uint256 mgmtShares = _pendingManagementFee(_supply, _assets);

        return
            mgmtShares + _pendingPerformanceFee(_supply + mgmtShares, _assets);
    }

    /// @dev Reads the configured rate (bps) for a fee type; 0 means disabled.
    /// @param _feeType The fee type to read.
    /// @return The effective rate in basis points.
    function _rate(FeeType _feeType) private view returns (uint16) {
        return _feeConfig.rateBps[uint8(_feeType)];
    }

    /// @dev Books freshly minted dilution fee-shares, split between LI.FI and the
    ///      integrator using the fee type's own share via `_splitFee`. Payout happens
    ///      elsewhere; here it only tracks the per-recipient totals.
    /// @param _feeType The fee type that accrued (Management or Performance).
    /// @param _feeShares The total shares minted to this contract for the fee.
    function _bookDilution(FeeType _feeType, uint256 _feeShares) private {
        uint256 integratorPart;
        (lifiFeeShares, integratorFeeShares, integratorPart) = _splitFee(
            _feeType,
            _feeShares,
            lifiFeeShares,
            integratorFeeShares
        );

        emit DilutionFeeAccrued(_feeType, _feeShares, integratorPart);
    }

    /// @dev Books an asset-side amount as idle and not-yet-distributed, split between
    ///      LI.FI and the integrator using the fee type's own share via `_splitFee`.
    ///      Payout happens elsewhere; here it only tracks the per-recipient totals.
    ///      No-op on a zero amount.
    /// @param _feeType The fee type charged (Deposit or Withdrawal).
    /// @param _feeAssets The amount, in assets, kept idle in this contract: the fee
    ///        plus, on the withdrawal path, any adapter excess (see `_transferOut`).
    function _routeFee(FeeType _feeType, uint256 _feeAssets) private {
        if (_feeAssets == 0) return;

        uint256 integratorPart;
        (lifiFeeAssets, integratorFeeAssets, integratorPart) = _splitFee(
            _feeType,
            _feeAssets,
            lifiFeeAssets,
            integratorFeeAssets
        );

        emit AssetFeeCharged(_feeType, _feeAssets, integratorPart);
    }

    /// @dev Single source of the LI.FI/integrator split semantics, shared by the
    ///      share-side and asset-side counters. The integrator's part rounds down, so
    ///      split dust (at most 1 wei per accrual) goes to LI.FI. Accumulation
    ///      SATURATES at the uint128 counter max instead of reverting: this runs
    ///      inside `_accrueFees` on every operation including exits, so an
    ///      overflowing counter must under-attribute payout entitlements (unreachable
    ///      for any real asset — it requires a cumulative fee of 2^128 wei) rather
    ///      than permanently brick withdrawals.
    /// @param _feeType The fee type whose share to apply.
    /// @param _feeTotal The total fee amount to split.
    /// @param _lifiAccrued Current LI.FI counter value.
    /// @param _integratorAccrued Current integrator counter value.
    /// @return lifiNew Updated LI.FI counter value.
    /// @return integratorNew Updated integrator counter value.
    /// @return integratorPart The integrator's part of `_feeTotal` (for events).
    function _splitFee(
        FeeType _feeType,
        uint256 _feeTotal,
        uint128 _lifiAccrued,
        uint128 _integratorAccrued
    )
        private
        view
        returns (
            uint128 lifiNew,
            uint128 integratorNew,
            uint256 integratorPart
        )
    {
        // 512-bit mulDiv: a plain `_feeTotal * shareBps` could overflow for extreme
        // fee-share mints and revert the accrual path this function must keep alive.
        integratorPart = Math.mulDiv(
            _feeTotal,
            integratorShareBps[uint8(_feeType)],
            LibVaultWrapperMath.BASIS_POINT_SCALE
        );
        lifiNew = _saturatingAddUint128(
            _lifiAccrued,
            _feeTotal - integratorPart
        );
        integratorNew = _saturatingAddUint128(
            _integratorAccrued,
            integratorPart
        );
    }

    /// @dev Adds `_delta` to a uint128 accumulator, clamping at the type max instead
    ///      of reverting (see `_splitFee` for why the accrual path must never revert).
    ///      Compares before adding: `_delta` is only bounded by the `_mint` supply
    ///      check, so a plain checked add could itself overflow uint256 and revert.
    /// @param _accrued The current accumulator value.
    /// @param _delta The amount to add.
    /// @return The clamped sum.
    function _saturatingAddUint128(
        uint128 _accrued,
        uint256 _delta
    ) private pure returns (uint128) {
        uint256 accrued = uint256(_accrued);
        if (_delta > type(uint128).max - accrued) return type(uint128).max;

        return uint128(accrued + _delta);
    }

    /// @dev Validates and stores the integrator receiver set: 1..50 wallets, no zero address,
    ///      bps summing to exactly 100%. Reverts the whole call (including a deploy, when
    ///      reached from `initialize`) on any violation.
    /// @param _receivers The payout wallets with their bps split.
    function _setIntegratorFeeReceivers(
        FeeReceiver[] calldata _receivers
    ) private {
        uint256 count = _receivers.length;
        if (count == 0 || count > MAX_FEE_RECEIVERS)
            revert InvalidReceiverCount();

        uint256 sum;
        for (uint256 i; i < count; ++i) {
            if (_receivers[i].wallet == address(0)) revert ZeroReceiver();
            sum += _receivers[i].bps;
        }
        if (sum != LibVaultWrapperMath.BASIS_POINT_SCALE)
            revert ReceiverBpsSumNot100();

        delete integratorFeeReceivers;
        for (uint256 i; i < count; ++i) {
            integratorFeeReceivers.push(_receivers[i]);
        }

        emit ReceiversSet(_receivers);
    }

    /// @dev Pays out one fee pool of `_token` from the per-recipient parts booked at
    ///      accrual — no split happens here (see `_splitFee`). The integrator's part is
    ///      fanned across the receiver wallets; LI.FI is paid its booked part. Both sides
    ///      use OZ's non-reverting `trySafeTransfer`: a failed transfer on either side has
    ///      its amount returned to the caller (which re-books it as still-owed) and left in
    ///      the wrapper, so neither a blacklisted integrator wallet nor a blocked LI.FI
    ///      recipient can revert the distribution and hold the other side's payout hostage.
    ///      Caller must zero the counters first (CEI). No-op on an empty fee pool.
    /// @param _token The fee-pool token (the vault asset, or this wrapper's shares).
    /// @param _lifiPart LI.FI's booked part of the fee pool.
    /// @param _integratorPart The integrator's booked part of the fee pool.
    /// @param _lifiRecipient The live LI.FI fee recipient.
    /// @return integratorRetained The integrator amount whose transfer failed, left in the wrapper.
    /// @return lifiRetained The LI.FI amount whose transfer failed, left in the wrapper.
    function _distributeFeePool(
        address _token,
        uint256 _lifiPart,
        uint256 _integratorPart,
        address _lifiRecipient
    ) private returns (uint256 integratorRetained, uint256 lifiRetained) {
        if (_lifiPart == 0 && _integratorPart == 0) return (0, 0);

        // pay integrators; any wallet whose transfer fails leaves its share in the wrapper
        integratorRetained = _payIntegrators(_token, _integratorPart);

        if (
            _lifiPart > 0 &&
            !SafeERC20.trySafeTransfer(
                IERC20(_token),
                _lifiRecipient,
                _lifiPart
            )
        ) {
            lifiRetained = _lifiPart;
            emit LifiPayoutRetained(_lifiRecipient, _token, _lifiPart);
        }

        emit FeePoolDistributed(
            _token,
            _lifiPart - lifiRetained,
            _integratorPart - integratorRetained
        );
    }

    /// @dev Fans `_integratorTotal` of `_token` across the integrator wallets by their bps, the
    ///      last wallet absorbing the integer-division remainder so the portion zeroes exactly.
    ///      Each payout uses OZ's non-reverting `trySafeTransfer`; a failed transfer (e.g. a
    ///      blacklisted wallet) has its share returned as `retained` and left in the wrapper,
    ///      so one hostile wallet can never block the distribution.
    /// @param _token The fee-pool token to distribute.
    /// @param _integratorTotal The integrator's portion of the fee pool.
    /// @return retained The sum of shares whose transfer failed (left in the wrapper).
    function _payIntegrators(
        address _token,
        uint256 _integratorTotal
    ) private returns (uint256 retained) {
        FeeReceiver[] memory receivers = integratorFeeReceivers;
        uint256 count = receivers.length;
        uint256 distributed;

        for (uint256 i; i < count; ++i) {
            uint256 share;
            if (i + 1 == count) {
                // last receiver gets the whole remainder to avoid rounding dust
                share = _integratorTotal - distributed;
            } else {
                // other receivers get their bps share, rounded down
                share = _integratorTotal.mulDiv(
                    receivers[i].bps,
                    LibVaultWrapperMath.BASIS_POINT_SCALE
                );
            }
            distributed += share;
            if (share == 0) continue;

            address wallet = receivers[i].wallet;
            // we use trySafeTransfer here so a failed transfer doesn't block the distribution
            if (SafeERC20.trySafeTransfer(IERC20(_token), wallet, share)) {
                continue;
            }

            // the failed transfer amount stays in the wrapper as still-owed integrator fees
            retained += share;
            emit IntegratorPayoutRetained(wallet, _token, share);
        }
    }
}
