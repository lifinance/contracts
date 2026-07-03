// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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
///      All four fee types are charged: management (time-based dilution) and performance
///      (high-water-mark dilution) fee-shares are minted to this contract via `_accrueFees`,
///      and deposit/withdrawal asset fees are kept idle and tracked through `_routeFee`.
///      Every fee is split between LI.FI and the integrator at accrual time using the
///      fee type's own share, into per-recipient counters. This contract does not
///      distribute the accrued fees. Pause is enforced on the deposit/mint path only
///      (withdrawals stay open);
///      access logic remains a no-op seam (`_checkAccess`) with its body landing in a
///      follow-up ticket. Inflation-attack protection relies on the ERC-4626 virtual-share
///      offset.
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
    /// @notice Whether this clone's deposits are paused by the integrator (the per-vault
    ///         `owner`), the only authority over this flag. LI.FI has no per-instance pause;
    ///         its lever is the factory-level global circuit breaker, a separate source read
    ///         live in `depositsPaused`. Both gate inflows, neither gates exits.
    bool public paused;
    /// @notice The integrator's fee share (bps) per fee type (indexed by FeeType ordinal),
    ///         snapshotted from the factory at deploy. LI.FI receives the remainder of
    ///         each fee.
    uint16[4] public integratorShareBps;
    /// @notice Opaque wrapper-side config (access mode, receivers, ToS hash, oracle),
    ///         stored verbatim for later modules to decode.
    bytes public initData;

    /// @dev Per-fee-type rates and enabled flags, validated by the factory.
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
        uint16[4] calldata _integratorShareBps,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external initializer {
        if (
            _underlying == address(0) ||
            _adapter == address(0) ||
            _vaultWrapperAdmin == address(0)
        ) revert ZeroAddress();
        for (uint256 i; i < 4; ++i) {
            if (_integratorShareBps[i] >= 10_000)
                revert InvalidIntegratorShareBps(_integratorShareBps[i]);
        }

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
        // Anchor the performance watermark at the empty-vault share price, computed pure
        // (supply and position are always 0 on a fresh single-shot-initialized proxy).
        // Deliberately NOT read through the adapter: an underlying whose empty-position
        // query reverts must not brick deployment. Assets donated to the predicted
        // address before deployment therefore count as gain at the first accrual —
        // charging a donation is harmless and disarms watermark-seeding games.
        perfHighWaterMarkPps = SafeCast.toUint192(
            LibVaultWrapperMath.pricePerShare(0, 0, _decimalsOffset())
        );

        emit VaultWrapperConfigured(
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
    /// @dev Reverts `DepositsPaused` while any pause source is engaged, so the named reason
    ///      surfaces to callers rather than OZ's `ERC4626ExceededMaxDeposit` from the
    ///      `maxDeposit == 0` view (which stays 0 for EIP-4626 consumers).
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant returns (uint256) {
        if (depositsPaused()) revert DepositsPaused();
        _beforeOperation();

        return super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reverts `DepositsPaused` while any pause source is engaged, so the named reason
    ///      surfaces to callers rather than OZ's `ERC4626ExceededMaxMint` from the
    ///      `maxMint == 0` view (which stays 0 for EIP-4626 consumers).
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant returns (uint256) {
        if (depositsPaused()) revert DepositsPaused();
        _beforeOperation();

        return super.mint(shares, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while any pause source is engaged so EIP-4626 consumers see the vault
    ///      as closed to deposits and do not build deposits that would revert.
    function maxDeposit(
        address receiver
    ) public view override returns (uint256) {
        if (depositsPaused()) return 0;

        return super.maxDeposit(receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Reports 0 while any pause source is engaged so EIP-4626 consumers see the vault
    ///      as closed to mints and do not build mints that would revert.
    function maxMint(address receiver) public view override returns (uint256) {
        if (depositsPaused()) return 0;

        return super.maxMint(receiver);
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
    /// @dev Per EIP-4626, previews MUST NOT account for deposit limits, so `previewDeposit`/
    ///      `previewMint` intentionally ignore pause and return a positive estimate even while
    ///      `depositsPaused()` is true (when the matching `deposit`/`mint` would revert
    ///      `DepositsPaused`). `maxDeposit`/`maxMint` are the pause-aware limit views.

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

    /// @dev Skims the entry fee and forwards the remaining deposited assets into the yield
    ///      source via the adapter. OZ's `_deposit` has already pulled the asset in and minted
    ///      shares. Reverts if the adapter reports the source accepted less than the net
    ///      deposit (a short-accepting source), so assets cannot be left stranded in the
    ///      wrapper against already-minted shares. A zero net amount (deposit fee consumed the
    ///      whole — sub-fee-denominator dust — input, or a bare zero deposit) skips the adapter
    ///      call entirely: there is nothing to invest, the fee is already routed, and a standard
    ///      ERC-4626 source reverts on a zero-asset forward, so short-circuiting keeps `deposit`
    ///      non-reverting in exactly the cases where `previewDeposit` returns 0. Pause is
    ///      enforced upstream in `deposit`/`mint`.
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
    ///      rolls back and the owner keeps their shares), skims the fee (plus any overage a
    ///      round-up source paid beyond the owed amount, so no idle asset is left unattributed),
    ///      then transfers exactly `_assets` to the receiver. A zero withdrawal (a dust redeem whose `previewRedeem` is
    ///      0, or a bare `withdraw(0)`) short-circuits before the adapter call — mirroring
    ///      `_deposit` — so sources that reject zero-amount withdrawals cannot block exits that
    ///      preview as 0.
    function _transferOut(address _to, uint256 _assets) internal override {
        if (_assets == 0) return;

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
        // A round-up source may pay more than owed; book the overage with the fee so
        // every idle asset stays attributed for payout instead of stranding as
        // untracked dust that silently left AUM.
        _routeFee(FeeType.Withdrawal, fee + (withdrawn - owed));
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
        if (_newRateBps == 0) {
            _feeConfig.enabled[idx] = false;
            _feeConfig.rateBps[idx] = 0;
        } else {
            (uint16 minBps, uint16 maxBps) = ILiFiVaultWrapperFactory(factory)
                .feeBounds(_feeType);
            if (_newRateBps < minBps || _newRateBps > maxBps)
                revert FeeRateOutOfBounds(_newRateBps, minBps, maxBps);
            if (_feeType == FeeType.Performance && !_feeConfig.enabled[idx]) {
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
            _feeConfig.enabled[idx] = true;
            _feeConfig.rateBps[idx] = _newRateBps;
        }

        emit FeeConfigUpdated(_feeType, _newRateBps, _newRateBps != 0);
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
        return paused || ILiFiVaultWrapperFactory(factory).globalPaused();
    }

    /// Fees and access ///
    /// @dev `_checkAccess` below is a no-op seam; its body lands with access control.
    ///      TODO(pause): any future inflow entrypoint (e.g. the V2 reward-injection path) must
    ///      gate on `if (depositsPaused()) revert DepositsPaused();` like `deposit`/`mint`.

    /// @dev Runs on every state-changing entrypoint (deposit/mint/withdraw/redeem): enforces
    ///      the vault's access mode on the caller and accrues time/yield-based fees so the
    ///      operation transacts at the post-accrual share price. Deposit-pause is enforced
    ///      separately and only on inflows, so this is shared by exits too.
    function _beforeOperation() private {
        _checkAccess(msg.sender);
        _accrueFees();
    }

    /// @dev Enforces the vault's access mode (open / allowlist / permissioned) on the caller.
    ///      Widens to `view` once it reads the access mode from initData.
    function _checkAccess(address /* caller */) private pure {
        // TODO(access): decode the access mode from initData and authorize the caller.
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
        bool mgmtEnabled = _feeConfig.enabled[uint8(FeeType.Management)];
        bool perfEnabled = _feeConfig.enabled[uint8(FeeType.Performance)];
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
        if (
            lastMgmtAccrual == 0 ||
            !_feeConfig.enabled[uint8(FeeType.Management)] ||
            _supply == 0 ||
            _assets == 0
        ) return 0;

        uint256 elapsed = block.timestamp - lastMgmtAccrual;
        if (elapsed == 0) return 0;

        uint256 feeAssets = LibVaultWrapperMath.managementFeeAssets({
            _totalAssets: _assets,
            _rateBps: _feeConfig.rateBps[uint8(FeeType.Management)],
            _elapsed: elapsed
        });
        feeShares = LibVaultWrapperMath.dilutionShares({
            _feeAssets: feeAssets,
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
        uint8 idx = uint8(FeeType.Performance);
        if (!_feeConfig.enabled[idx]) return 0;

        uint256 hwm = perfHighWaterMarkPps;
        if (hwm == 0) return 0;

        uint256 feeAssets = LibVaultWrapperMath.performanceFeeAssets({
            _totalAssets: _assets,
            _totalSupply: _supply,
            _hwmPps: hwm,
            _rateBps: _feeConfig.rateBps[idx],
            _decimalsOffset: _decimalsOffset()
        });

        return
            LibVaultWrapperMath.dilutionShares({
                _feeAssets: feeAssets,
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

    /// @dev Reads the configured rate (bps) for a fee type; 0 when the type is disabled.
    /// @param _feeType The fee type to read.
    /// @return The effective rate in basis points.
    function _rate(FeeType _feeType) private view returns (uint16) {
        uint8 idx = uint8(_feeType);
        if (!_feeConfig.enabled[idx]) return 0;
        return _feeConfig.rateBps[idx];
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
    ///        plus, on the withdrawal path, any adapter overage (see `_transferOut`).
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
    /// @param _accrued The current accumulator value.
    /// @param _delta The amount to add.
    /// @return The clamped sum.
    function _saturatingAddUint128(
        uint128 _accrued,
        uint256 _delta
    ) private pure returns (uint128) {
        uint256 sum = uint256(_accrued) + _delta;

        return sum > type(uint128).max ? type(uint128).max : uint128(sum);
    }
}
