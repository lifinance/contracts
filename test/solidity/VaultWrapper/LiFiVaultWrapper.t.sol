// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { MockZeroAdapter } from "test/solidity/VaultWrapper/mocks/MockZeroAdapter.sol";

/// @notice ERC-4626 underlying that can be armed to revert or re-enter the wrapper on
///         deposit, used to test delegatecall revert bubbling and the reentrancy guard.
contract HostileUnderlying is MockERC4626 {
    enum Mode {
        None,
        Revert,
        Reenter
    }

    error Boom();

    Mode public mode;
    LiFiVaultWrapper public wrapper;

    constructor(ERC20 _asset) MockERC4626(_asset, "Hostile", "HOST") {}

    function arm(Mode _mode, LiFiVaultWrapper _wrapper) external {
        mode = _mode;
        wrapper = _wrapper;
    }

    function deposit(
        uint256 _assets,
        address _to
    ) public override returns (uint256) {
        if (mode == Mode.Revert) revert Boom();
        if (mode == Mode.Reenter)
            wrapper.withdraw(1, address(this), address(this));

        return super.deposit(_assets, _to);
    }
}

/// @notice Minimal ERC-4626-shaped yield source that can be configured to accept fewer
///         assets than requested on deposit, or return fewer on withdraw, to exercise the
///         wrapper's adapter-shortfall guards.
contract LossyVault {
    MockERC20 public immutable ASSET_TOKEN;
    mapping(address => uint256) public balanceOf;
    uint256 public depositPullBps = 10_000;
    uint256 public withdrawSendBps = 10_000;

    constructor(MockERC20 _asset) {
        ASSET_TOKEN = _asset;
    }

    function asset() external view returns (address) {
        return address(ASSET_TOKEN);
    }

    function setDepositPullBps(uint256 _bps) external {
        depositPullBps = _bps;
    }

    function setWithdrawSendBps(uint256 _bps) external {
        withdrawSendBps = _bps;
    }

    function deposit(
        uint256 _assets,
        address _receiver
    ) external returns (uint256 shares) {
        ASSET_TOKEN.transferFrom(
            msg.sender,
            address(this),
            (_assets * depositPullBps) / 10_000
        );
        shares = _assets;
        balanceOf[_receiver] += shares;
    }

    function withdraw(
        uint256 _assets,
        address _receiver,
        address _owner
    ) external returns (uint256 shares) {
        shares = _assets;
        balanceOf[_owner] -= shares;
        ASSET_TOKEN.transfer(_receiver, (_assets * withdrawSendBps) / 10_000);
    }

    function convertToAssets(uint256 _shares) external pure returns (uint256) {
        return _shares;
    }
}

contract LiFiVaultWrapperTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal vaultAdmin = makeAddr("vaultAdmin");

    uint256 internal constant DEPOSIT = 1_000e18;

    event Initialized(
        address indexed asset,
        address indexed underlying,
        address indexed adapter,
        address vaultWrapperAdmin,
        address factory,
        uint16 integratorShareBps
    );

    /// @dev This test contract is the `factory` (it deploys the beacon proxies), so the
    ///      wrapper reads the global circuit breaker and emergency pauser back from here.
    function globalPaused() external pure returns (bool) {
        return false;
    }

    function emergencyPauser() external pure returns (address) {
        return address(0);
    }

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
        wrapper = _newWrapper(address(underlying));
    }

    /// Initialization ///

    function test_InitializeSetsState() public view {
        assertTrue(wrapper.initialized());
        assertEq(wrapper.asset(), address(asset));
        assertEq(wrapper.underlying(), address(underlying));
        assertEq(wrapper.adapter(), address(adapter));
        assertEq(wrapper.owner(), vaultAdmin);
        assertEq(wrapper.factory(), address(this));
        assertEq(wrapper.integratorShareBps(), 8000);
        assertEq(wrapper.decimals(), 18);
        assertEq(wrapper.name(), "LI.FI Earn TKN");
        assertEq(wrapper.symbol(), "lfTKN");
    }

    function test_InitializeEmitsInitialized() public {
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (address(underlying), address(adapter), vaultAdmin, 8000, fees, "")
        );

        vm.expectEmit(true, true, true, true);
        emit Initialized(
            address(asset),
            address(underlying),
            address(adapter),
            vaultAdmin,
            address(this),
            8000
        );

        new BeaconProxy(address(beacon), initCall);
    }

    function testRevert_InitializeTwice() public {
        FeeConfig memory fees;

        vm.expectRevert(Initializable.InvalidInitialization.selector);

        wrapper.initialize(
            address(underlying),
            address(adapter),
            vaultAdmin,
            8000,
            fees,
            ""
        );
    }

    function testRevert_InitializeRejectsZeroAddress() public {
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (address(underlying), address(adapter), address(0), 8000, fees, "")
        );

        vm.expectRevert(LiFiVaultWrapper.ZeroAddress.selector);

        new BeaconProxy(address(beacon), initCall);
    }

    function testRevert_InitializeRejectsZeroAssetFromAdapter() public {
        MockZeroAdapter zeroAdapter = new MockZeroAdapter();
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(zeroAdapter),
                vaultAdmin,
                8000,
                fees,
                ""
            )
        );

        vm.expectRevert(LiFiVaultWrapper.ZeroAddress.selector);

        new BeaconProxy(address(beacon), initCall);
    }

    function testRevert_InitializeRejectsFullIntegratorShare() public {
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(adapter),
                vaultAdmin,
                10_000,
                fees,
                ""
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                LiFiVaultWrapper.InvalidIntegratorShareBps.selector,
                uint16(10_000)
            )
        );

        new BeaconProxy(address(beacon), initCall);
    }

    function testRevert_FeeGettersRejectInvalidFeeType() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LiFiVaultWrapper.InvalidFeeType.selector,
                uint8(4)
            )
        );
        wrapper.feeRate(4);

        vm.expectRevert(
            abi.encodeWithSelector(
                LiFiVaultWrapper.InvalidFeeType.selector,
                uint8(4)
            )
        );
        wrapper.feeEnabled(4);
    }

    function test_NameAndSymbolDeriveFromAssetSymbol() public view {
        assertEq(wrapper.name(), "LI.FI Earn TKN");
        assertEq(wrapper.symbol(), "lfTKN");
    }

    function test_NameAndSymbolFallBackWhenAssetHasNoSymbol() public {
        MockERC20 noSymbolAsset = new MockERC20("No Symbol", "", 18);
        MockERC4626 noSymbolUnderlying = new MockERC4626(
            noSymbolAsset,
            "Yield",
            "yNS"
        );
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(noSymbolUnderlying),
                address(adapter),
                vaultAdmin,
                8000,
                fees,
                ""
            )
        );

        LiFiVaultWrapper w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );

        assertEq(w.name(), "LI.FI Earn VW");
        assertEq(w.symbol(), "lfVW");
    }

    /// Deposit / pass-through ///

    function test_DepositForwardsAssetsToUnderlying() public {
        _deposit(alice, DEPOSIT);

        assertEq(asset.balanceOf(address(wrapper)), 0);
        assertEq(asset.balanceOf(address(underlying)), DEPOSIT);
        assertEq(underlying.balanceOf(address(wrapper)), DEPOSIT);
        assertEq(wrapper.totalAssets(), DEPOSIT);
        assertEq(wrapper.balanceOf(alice), DEPOSIT);
        assertEq(wrapper.totalSupply(), DEPOSIT);
    }

    function test_MintForwardsAssetsToUnderlying() public {
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);
        uint256 assetsIn = wrapper.mint(DEPOSIT, alice);
        vm.stopPrank();

        assertEq(assetsIn, DEPOSIT);
        assertEq(wrapper.balanceOf(alice), DEPOSIT);
        assertEq(wrapper.totalAssets(), DEPOSIT);
        assertEq(asset.balanceOf(address(wrapper)), 0);
    }

    /// Round-trips ///

    function test_RedeemRoundTrip() public {
        _deposit(alice, DEPOSIT);

        uint256 shares = wrapper.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(shares, alice, alice);

        assertApproxEqAbs(assetsOut, DEPOSIT, 1);
        assertApproxEqAbs(asset.balanceOf(alice), DEPOSIT, 1);
        assertEq(wrapper.balanceOf(alice), 0);
    }

    function test_WithdrawRoundTrip() public {
        _deposit(alice, DEPOSIT);

        vm.prank(alice);
        uint256 sharesBurned = wrapper.withdraw(DEPOSIT, alice, alice);

        assertApproxEqAbs(sharesBurned, DEPOSIT, 1);
        assertApproxEqAbs(asset.balanceOf(alice), DEPOSIT, 1);
        assertApproxEqAbs(wrapper.balanceOf(alice), 0, 1);
    }

    /// Accounting ///

    function test_PreviewMatchesActualDepositAndRedeem() public {
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);

        uint256 previewedShares = wrapper.previewDeposit(DEPOSIT);
        uint256 mintedShares = wrapper.deposit(DEPOSIT, alice);
        assertEq(mintedShares, previewedShares);

        uint256 previewedAssets = wrapper.previewRedeem(mintedShares);
        uint256 redeemedAssets = wrapper.redeem(mintedShares, alice, alice);
        vm.stopPrank();

        assertEq(redeemedAssets, previewedAssets);
    }

    function test_YieldAccrualIncreasesRedeemValue() public {
        _deposit(alice, DEPOSIT);

        // Simulate yield: assets appear in the underlying without new shares minted.
        uint256 yield = 100e18;
        asset.mint(address(underlying), yield);

        assertEq(wrapper.totalAssets(), DEPOSIT + yield);

        uint256 shares = wrapper.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(shares, alice, alice);

        assertApproxEqAbs(assetsOut, DEPOSIT + yield, 1);
    }

    function test_TwoDepositorsShareProportionally() public {
        _deposit(alice, DEPOSIT);
        _deposit(bob, DEPOSIT);

        assertApproxEqAbs(wrapper.balanceOf(alice), wrapper.balanceOf(bob), 1);
        assertEq(wrapper.totalAssets(), DEPOSIT * 2);

        uint256 bobShares = wrapper.balanceOf(bob);
        vm.prank(bob);
        uint256 bobAssets = wrapper.redeem(bobShares, bob, bob);

        assertApproxEqAbs(bobAssets, DEPOSIT, 1);
        assertApproxEqAbs(wrapper.totalAssets(), DEPOSIT, 1);
    }

    function test_VirtualSharesGiveSecondDepositorFairShares() public {
        // A 1-wei first deposit must not let virtual-share accounting zero out a
        // normal-sized second deposit (the empty-vault edge the inflation attack targets).
        _deposit(alice, 1);
        _deposit(bob, DEPOSIT);

        uint256 bobShares = wrapper.balanceOf(bob);
        assertGt(bobShares, 0);

        vm.prank(bob);
        uint256 bobAssets = wrapper.redeem(bobShares, bob, bob);

        assertApproxEqAbs(bobAssets, DEPOSIT, 2);
    }

    /// Adapter delegatecall safety ///

    function testRevert_AdapterRevertBubblesUp() public {
        HostileUnderlying hostile = new HostileUnderlying(asset);
        LiFiVaultWrapper w = _newWrapper(address(hostile));
        hostile.arm(HostileUnderlying.Mode.Revert, w);

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);

        vm.expectRevert(HostileUnderlying.Boom.selector);

        w.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    function testRevert_ReentrantCallBlocked() public {
        HostileUnderlying hostile = new HostileUnderlying(asset);
        LiFiVaultWrapper w = _newWrapper(address(hostile));
        hostile.arm(HostileUnderlying.Mode.Reenter, w);

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        w.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    /// Adapter shortfall guards ///

    function testRevert_DepositShortfallFromAdapter() public {
        LossyVault lossy = new LossyVault(asset);
        LiFiVaultWrapper w = _newWrapper(address(lossy));
        lossy.setDepositPullBps(9000); // yield source accepts only 90%

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                LiFiVaultWrapper.AdapterDepositShortfall.selector,
                DEPOSIT,
                (DEPOSIT * 9000) / 10000
            )
        );

        w.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    function testRevert_WithdrawShortfallFromAdapter() public {
        LossyVault lossy = new LossyVault(asset);
        LiFiVaultWrapper w = _newWrapper(address(lossy));

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);
        w.deposit(DEPOSIT, alice);
        vm.stopPrank();

        lossy.setWithdrawSendBps(9000); // yield source returns only 90%

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                LiFiVaultWrapper.AdapterWithdrawShortfall.selector,
                DEPOSIT,
                (DEPOSIT * 9000) / 10000
            )
        );

        w.withdraw(DEPOSIT, alice, alice);
    }

    /// Admin transfer (two-step) ///

    function test_TransferOwnershipTwoStep() public {
        address newAdmin = makeAddr("newAdmin");

        vm.prank(vaultAdmin);
        wrapper.transferOwnership(newAdmin);
        assertEq(wrapper.pendingOwner(), newAdmin);
        assertEq(wrapper.owner(), vaultAdmin);

        vm.prank(newAdmin);
        wrapper.acceptOwnership();
        assertEq(wrapper.owner(), newAdmin);
        assertEq(wrapper.pendingOwner(), address(0));
    }

    function test_TransferOwnershipCanBeCancelled() public {
        address newAdmin = makeAddr("newAdmin");

        vm.startPrank(vaultAdmin);
        wrapper.transferOwnership(newAdmin);
        wrapper.transferOwnership(address(0));
        vm.stopPrank();

        assertEq(wrapper.pendingOwner(), address(0));
    }

    function testRevert_TransferOwnershipNotAdmin() public {
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );
        wrapper.transferOwnership(makeAddr("newAdmin"));
    }

    function testRevert_AcceptOwnershipNotPending() public {
        address newAdmin = makeAddr("newAdmin");

        vm.prank(vaultAdmin);
        wrapper.transferOwnership(newAdmin);

        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );
        wrapper.acceptOwnership();
    }

    function testRevert_RenounceOwnershipDisabled() public {
        vm.prank(vaultAdmin);
        vm.expectRevert(LiFiVaultWrapper.RenounceDisabled.selector);
        wrapper.renounceOwnership();
    }

    /// Helpers ///

    function _newWrapper(
        address _underlying
    ) internal returns (LiFiVaultWrapper w) {
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (_underlying, address(adapter), vaultAdmin, 8000, fees, "")
        );

        w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );
    }

    function _deposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }
}
