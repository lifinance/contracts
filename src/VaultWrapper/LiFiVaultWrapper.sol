// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MetadataReaderLib } from "solady/utils/MetadataReaderLib.sol";
import { ILiFiVaultWrapper } from "./interfaces/ILiFiVaultWrapper.sol";
import { ILiFiVaultWrapperFactory } from "./interfaces/ILiFiVaultWrapperFactory.sol";
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { VaultWrapperPausable } from "./VaultWrapperPausable.sol";
import { VaultWrapperFeeDistributor } from "./VaultWrapperFeeDistributor.sol";
import { FeeConfig } from "./LiFiVaultWrapperTypes.sol";

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
///      withdrawal. Identity (`underlying`/`adapter`/`vaultWrapperAdmin`/`factory`) and the fee
///      configuration are set write-once in `initialize`. Pause is enforced via
///      `VaultWrapperPausable` on the deposit/mint path only (withdrawals stay open); fee
///      routing and sweep are provided by `VaultWrapperFeeDistributor`. Fee accrual/amount
///      logic (`_accrueFees`, `_entryFee`/`_exitFee`) and access (`_checkAccess`) remain no-op
///      seams wired into the flow, with bodies landing in follow-up tickets — so `_routeFee`
///      receives zero today. Inflation-attack protection relies on the ERC-4626 virtual-share
///      offset.
/// @custom:version 1.0.0
contract LiFiVaultWrapper is
    ERC4626Upgradeable,
    // OZ v5 ships no ReentrancyGuardUpgradeable, and ReentrancyGuardTransient needs
    // EIP-1153 on every target chain. The plain guard is proxy-safe here: its check
    // treats the proxy's uninitialized slot (0) as NOT_ENTERED, so it works from the
    // first call without a constructor having run in the proxy's context.
    ReentrancyGuard,
    VaultWrapperPausable,
    VaultWrapperFeeDistributor,
    ILiFiVaultWrapper
{
    using MetadataReaderLib for address;

    /// Storage ///

    /// @notice The yield source this wrapper deposits into (e.g. an ERC-4626 vault).
    address public underlying;
    /// @notice The approved yield adapter the wrapper routes deposits/withdrawals through.
    address public adapter;
    /// @notice The per-vault controller granted the instance admin role.
    address public vaultWrapperAdmin;
    /// @notice The proposed next admin, pending acceptance (two-step transfer).
    address public pendingVaultWrapperAdmin;
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

    /// @dev Reserved slots so future versions can append wrapper-level state without
    ///      shifting any storage that inheriting/derived modules occupy. This impl sits
    ///      behind an upgradeable beacon, so storage layout is an upgrade invariant: only
    ///      append (consuming this gap), never reorder fields or the inheritance list.
    uint256[49] private __gap;

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

    /// @notice Emitted when an admin transfer is started (pending acceptance).
    /// @param currentAdmin The admin initiating the transfer.
    /// @param newAdmin The proposed new admin that must accept.
    event VaultWrapperAdminTransferStarted(
        address indexed currentAdmin,
        address indexed newAdmin
    );

    /// @notice Emitted when the admin role is transferred (accepted).
    /// @param previousAdmin The admin being replaced.
    /// @param newAdmin The admin that accepted the role.
    event VaultWrapperAdminTransferred(
        address indexed previousAdmin,
        address indexed newAdmin
    );

    /// Errors ///

    /// @notice Thrown when a fee type ordinal is outside the valid range (0-3).
    error InvalidFeeType(uint8 feeType);
    /// @notice Thrown when a required initialization address is the zero address.
    error ZeroAddress();
    /// @notice Thrown when the integrator share exceeds 100% (10000 bps).
    error InvalidIntegratorShareBps(uint16 integratorShareBps);
    /// @notice Thrown when a caller other than the current admin attempts an admin action.
    error NotVaultWrapperAdmin();
    /// @notice Thrown when a caller other than the pending admin attempts to accept the role.
    error NotPendingVaultWrapperAdmin();
    /// @notice Thrown when the adapter invests less than the net deposit into the yield source.
    error AdapterDepositShortfall(uint256 expected, uint256 actual);
    /// @notice Thrown when the adapter returns less than the requested withdrawal amount.
    error AdapterWithdrawShortfall(uint256 expected, uint256 actual);

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

        factory = msg.sender;
        underlying = _underlying;
        adapter = _adapter;
        vaultWrapperAdmin = _vaultWrapperAdmin;
        integratorShareBps = _integratorShareBps;
        _feeConfig = _fees;
        initData = _initData;

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

    /// Admin transfer (two-step) ///

    /// @notice Propose a new vault-wrapper admin; the proposed admin must accept.
    /// @dev Two-step so a mistyped address can never strand the role. Only the current
    ///      admin may call. Passing `address(0)` clears any pending transfer.
    /// @param _newAdmin The proposed next admin.
    function transferVaultWrapperAdmin(address _newAdmin) external {
        if (msg.sender != vaultWrapperAdmin) revert NotVaultWrapperAdmin();
        pendingVaultWrapperAdmin = _newAdmin;
        emit VaultWrapperAdminTransferStarted(msg.sender, _newAdmin);
    }

    /// @notice Accept a pending vault-wrapper admin transfer.
    /// @dev Only the pending admin may call; promotes the caller and clears the pending slot.
    function acceptVaultWrapperAdmin() external {
        if (msg.sender != pendingVaultWrapperAdmin)
            revert NotPendingVaultWrapperAdmin();
        address previousAdmin = vaultWrapperAdmin;
        vaultWrapperAdmin = msg.sender;
        delete pendingVaultWrapperAdmin;
        emit VaultWrapperAdminTransferred(previousAdmin, msg.sender);
    }

    /// ERC-4626 configuration ///

    /// @notice Assets currently redeemable from the yield source, valued by the adapter.
    function totalAssets() public view override returns (uint256) {
        return IYieldAdapter(adapter).totalAssets(underlying, address(this));
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
        _requireDepositsNotPaused();
        _beforeOperation();

        return super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant returns (uint256) {
        _requireDepositsNotPaused();
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
        return super.previewDeposit(assets - _entryFee(assets));
    }

    /// @inheritdoc ERC4626Upgradeable
    function previewMint(
        uint256 shares
    ) public view override returns (uint256) {
        uint256 assets = super.previewMint(shares);

        return assets + _entryFee(assets);
    }

    /// @inheritdoc ERC4626Upgradeable
    function previewWithdraw(
        uint256 assets
    ) public view override returns (uint256) {
        return super.previewWithdraw(assets + _exitFee(assets));
    }

    /// @inheritdoc ERC4626Upgradeable
    function previewRedeem(
        uint256 shares
    ) public view override returns (uint256) {
        uint256 assets = super.previewRedeem(shares);

        return assets - _exitFee(assets);
    }

    /// Internal ///

    /// @dev Skims the entry fee, then forwards the remaining deposited assets into the yield
    ///      source via the adapter. OZ's `_deposit` has already pulled the asset in and minted
    ///      shares. Reverts if the adapter reports the source accepted less than the net
    ///      deposit (a short-accepting source), so assets cannot be left stranded in the
    ///      wrapper against already-minted shares. With fees unimplemented the skim is zero,
    ///      so the full amount is invested.
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        super._deposit(caller, receiver, assets, shares);

        uint256 fee = _entryFee(assets);
        _routeFee(fee);
        uint256 invested = assets - fee;
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
        uint256 fee = _exitFee(_assets);
        uint256 owed = _assets + fee;
        uint256 withdrawn = _routeThroughAdapter(
            abi.encodeCall(
                IYieldAdapter.withdraw,
                (assetToken, underlying, owed)
            )
        );
        if (withdrawn < owed) revert AdapterWithdrawShortfall(owed, withdrawn);
        _routeFee(fee);
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

    /// Pause authority hooks (VaultWrapperPausable) ///

    /// @inheritdoc VaultWrapperPausable
    /// @dev The LI.FI emergency multisig, read live from the factory so a rotation there
    ///      applies to every instance without touching the clones.
    function _emergencyPauseAuthority()
        internal
        view
        override
        returns (address)
    {
        return ILiFiVaultWrapperFactory(factory).emergencyPauser();
    }

    /// @inheritdoc VaultWrapperPausable
    /// @dev The per-vault controller is the integrator's pause authority.
    function _integratorPauseAuthority()
        internal
        view
        override
        returns (address)
    {
        return vaultWrapperAdmin;
    }

    /// @inheritdoc VaultWrapperPausable
    /// @dev The factory-level global circuit breaker, read live on every deposit.
    function _globalPaused() internal view override returns (bool) {
        return ILiFiVaultWrapperFactory(factory).globalPaused();
    }

    /// Fee / access blueprint ///
    /// @dev The functions below are no-op seams wired into the entrypoints and the
    ///      deposit/withdraw flow. Their bodies are implemented in follow-up tickets
    ///      (fees, access control); today they preserve current behaviour. Pause is already
    ///      enforced via `VaultWrapperPausable` on the deposit/mint path.

    /// @dev Runs on every state-changing entrypoint (deposit/mint/withdraw/redeem): enforces
    ///      the vault's access mode on the caller and accrues time/yield-based fees so the
    ///      operation transacts at the post-accrual share price. Deposit-pause is enforced
    ///      separately and only on inflows, so this is shared by exits too.
    ///      Widens to a state-mutating function once `_accrueFees` is implemented.
    function _beforeOperation() private view {
        _checkAccess(msg.sender);
        _accrueFees();
    }

    /// @dev Enforces the vault's access mode (open / allowlist / permissioned) on the caller.
    ///      Widens to `view` once it reads the access mode from initData.
    function _checkAccess(address /* caller */) private pure {
        // TODO(access): decode the access mode from initData and authorize the caller.
    }

    /// @dev Accrues management (time-based) and performance (high-water-mark) fees by minting
    ///      fee shares to the integrator/LI.FI recipients, routed via _routeFee. Runs before
    ///      share math so deposits/withdrawals transact post-accrual. Widens to state-mutating
    ///      once implemented.
    function _accrueFees() private pure {
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

    /// Fee receivers / sweep (VaultWrapperFeeDistributor) ///

    /// @notice Configure the integrator's 1..5 payout wallets and their bps (sum 100%).
    /// @dev Integrator-controlled, like the integrator pause. Does not affect LI.FI's
    ///      share, which routes to the factory-governed recipient.
    /// @param _receivers The integrator payout wallets.
    /// @param _bps The per-receiver basis points; must sum to 100%.
    function setIntegratorReceivers(
        address[] calldata _receivers,
        uint16[] calldata _bps
    ) external onlyIntegratorAdmin {
        _setIntegratorReceivers(_receivers, _bps);
    }

    /// @notice Permissionlessly distribute accrued fees: the LI.FI pool to the live
    ///         factory recipient, the integrator pool across its wallets by bps.
    /// @dev Reentrancy-guarded and deliberately not pause-gated, so fees can always be
    ///      swept even while deposits are paused. LI.FI is paid first and independently of
    ///      the integrator side; if no integrator receivers are set, that portion is left
    ///      accrued for a later sweep instead of reverting.
    function sweep() external nonReentrant {
        _distributeAccruedFees();
    }

    /// @notice Permissionlessly sweep only the LI.FI fee pool to the live factory recipient.
    /// @dev Escape hatch guaranteeing LI.FI can always collect its share even if an
    ///      integrator-controlled receiver wallet reverts on receipt and so would block the
    ///      combined `sweep`.
    function sweepLifiFees() external nonReentrant {
        _payLifiFees();
    }

    /// @inheritdoc VaultWrapperFeeDistributor
    function _feeAsset() internal view override returns (address) {
        return asset();
    }

    /// @inheritdoc VaultWrapperFeeDistributor
    function _integratorShareBps() internal view override returns (uint16) {
        return integratorShareBps;
    }

    /// @inheritdoc VaultWrapperFeeDistributor
    function _lifiFeeRecipient() internal view override returns (address) {
        return ILiFiVaultWrapperFactory(factory).lifiFeeRecipient();
    }
}
