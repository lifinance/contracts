// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeConfig, DeployParams } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { defaultReceivers } from "test/solidity/VaultWrapper/VaultWrapperTestHelpers.sol";

/// @notice Minimal stand-in for the factory: deploys the instance (so it is the
///         `factory`/initializer the wrapper reads back) and exposes a toggleable global
///         circuit breaker.
contract MockPauseFactory {
    bool public globalPaused;

    function setGlobalPaused(bool _paused) external {
        globalPaused = _paused;
    }

    function deployWrapper(
        address _beacon,
        bytes calldata _initCall
    ) external returns (address) {
        return address(new BeaconProxy(_beacon, _initCall));
    }
}

contract VaultWrapperPauseTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    MockPauseFactory internal factory;
    LiFiVaultWrapper internal wrapper;

    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant DEPOSIT = 1_000e18;

    event PauseSet(bool paused, address indexed by);

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
        factory = new MockPauseFactory();

        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(adapter),
                vaultAdmin,
                [uint16(8000), 8000, 8000, 8000],
                fees,
                defaultReceivers(),
                address(0)
            )
        );
        wrapper = LiFiVaultWrapper(
            factory.deployWrapper(address(beacon), initCall)
        );
    }

    /// Deposit / mint are gated by every pause source ///

    function testRevert_DepositWhenIntegratorPaused() public {
        vm.prank(vaultAdmin);
        wrapper.pause();

        _expectDepositReverts(alice, DEPOSIT);
    }

    function testRevert_DepositWhenGloballyPaused() public {
        factory.setGlobalPaused(true);

        _expectDepositReverts(alice, DEPOSIT);
    }

    function testRevert_MintWhenIntegratorPaused() public {
        vm.prank(vaultAdmin);
        wrapper.pause();

        _expectMintReverts(alice, DEPOSIT);
    }

    function testRevert_MintWhenGloballyPaused() public {
        factory.setGlobalPaused(true);

        _expectMintReverts(alice, DEPOSIT);
    }

    // The entrypoint guard is unconditional: even a zero-amount deposit (which would clear
    // OZ's `assets > maxDeposit` check, 0 > 0 being false) reverts DepositsPaused.
    function testRevert_ZeroDepositRejectedWhilePaused() public {
        vm.prank(vaultAdmin);
        wrapper.pause();

        vm.prank(alice);
        vm.expectRevert(ILiFiVaultWrapper.DepositsPaused.selector);

        wrapper.deposit(0, alice);
    }

    /// Withdrawals stay open under every pause combination ///

    function test_WithdrawOpenUnderIntegratorPause() public {
        _seedDeposit(alice, DEPOSIT);
        vm.prank(vaultAdmin);
        wrapper.pause();

        vm.prank(alice);
        wrapper.withdraw(DEPOSIT, alice, alice);

        assertApproxEqAbs(asset.balanceOf(alice), DEPOSIT, 1);
    }

    function test_WithdrawOpenUnderGlobalPause() public {
        _seedDeposit(alice, DEPOSIT);
        factory.setGlobalPaused(true);

        vm.prank(alice);
        wrapper.withdraw(DEPOSIT, alice, alice);

        assertApproxEqAbs(asset.balanceOf(alice), DEPOSIT, 1);
    }

    function test_RedeemOpenUnderAllPausesCombined() public {
        _seedDeposit(alice, DEPOSIT);
        vm.prank(vaultAdmin);
        wrapper.pause();
        factory.setGlobalPaused(true);

        uint256 shares = wrapper.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(shares, alice, alice);

        assertApproxEqAbs(assetsOut, DEPOSIT, 1);
    }

    /// Admin role rotation stays open under pause ///

    function test_OwnershipTransferOpenUnderPause() public {
        address newAdmin = makeAddr("newAdmin");

        vm.prank(vaultAdmin);
        wrapper.pause();
        factory.setGlobalPaused(true);

        vm.prank(vaultAdmin);
        wrapper.transferOwnership(newAdmin);
        vm.prank(newAdmin);
        wrapper.acceptOwnership();

        assertEq(wrapper.owner(), newAdmin);
    }

    /// Authority separation ///

    function test_IntegratorUnpauseCannotClearGlobalPause() public {
        factory.setGlobalPaused(true);

        // The integrator lifting its own (unset) pause must not clear the global breaker.
        vm.prank(vaultAdmin);
        wrapper.unpause();

        assertTrue(wrapper.depositsPaused());
        _expectDepositReverts(alice, DEPOSIT);
    }

    function testRevert_StrangerCannotPause() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );

        wrapper.pause();
    }

    function testRevert_StrangerCannotUnpause() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );

        wrapper.unpause();
    }

    /// Unpause resumes deposits ///

    function test_IntegratorUnpauseResumesDeposits() public {
        vm.startPrank(vaultAdmin);
        wrapper.pause();
        wrapper.unpause();
        vm.stopPrank();

        _seedDeposit(alice, DEPOSIT);
        assertEq(wrapper.balanceOf(alice), DEPOSIT);
    }

    /// Views + events ///

    function test_DepositsPausedReflectsEachSource() public {
        assertFalse(wrapper.depositsPaused());

        factory.setGlobalPaused(true);
        assertTrue(wrapper.depositsPaused());
        factory.setGlobalPaused(false);

        vm.prank(vaultAdmin);
        wrapper.pause();
        assertTrue(wrapper.depositsPaused());
    }

    function test_PauseSettersEmitEvents() public {
        vm.expectEmit(true, true, true, true, address(wrapper));
        emit PauseSet(true, vaultAdmin);

        vm.prank(vaultAdmin);
        wrapper.pause();
    }

    /// EIP-4626 deposit limits report closed while paused ///

    function test_MaxDepositAndMaxMintZeroWhenIntegratorPaused() public {
        assertEq(wrapper.maxDeposit(alice), type(uint256).max);
        assertEq(wrapper.maxMint(alice), type(uint256).max);

        vm.prank(vaultAdmin);
        wrapper.pause();

        assertEq(wrapper.maxDeposit(alice), 0);
        assertEq(wrapper.maxMint(alice), 0);
    }

    function test_MaxDepositAndMaxMintZeroWhenGloballyPaused() public {
        factory.setGlobalPaused(true);

        assertEq(wrapper.maxDeposit(alice), 0);
        assertEq(wrapper.maxMint(alice), 0);
    }

    function test_MaxDepositAndMaxMintRestoredAfterUnpause() public {
        vm.startPrank(vaultAdmin);
        wrapper.pause();
        wrapper.unpause();
        vm.stopPrank();

        assertEq(wrapper.maxDeposit(alice), type(uint256).max);
        assertEq(wrapper.maxMint(alice), type(uint256).max);
    }

    /// Helpers ///

    function _seedDeposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }

    // A paused vault rejects deposits/mints at the entrypoint with the named DepositsPaused
    // error (maxDeposit/maxMint also report 0 for EIP-4626 consumers; see their own tests).
    function _expectDepositReverts(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);

        vm.expectRevert(ILiFiVaultWrapper.DepositsPaused.selector);

        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }

    function _expectMintReverts(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);

        vm.expectRevert(ILiFiVaultWrapper.DepositsPaused.selector);

        wrapper.mint(_amount, _from);
        vm.stopPrank();
    }
}

/// @notice End-to-end pause wiring against the real factory: validates the live
///         `factory.globalPaused()`/`globalPause()` read and the documented carve-out that
///         deploys are allowed while globally paused (the new instance is frozen from birth).
contract VaultWrapperGlobalPauseE2ETest is Test {
    LiFiVaultWrapperFactory internal factory;
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal instance;

    address internal owner = makeAddr("owner");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal alice = makeAddr("alice");
    bytes32 internal constant NS = bytes32("Coinbase");

    uint256 internal constant DEPOSIT = 1_000e18;

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            pauser,
            onboarder,
            lifiRecipient
        );

        vm.startPrank(owner);
        factory.setAdapterApproved(address(adapter), true);
        factory.setUnderlyingAllowed(address(underlying), true);
        vm.stopPrank();
        vm.prank(onboarder);
        factory.setApprovedIntegratorDeployer(NS, onboarder);

        instance = LiFiVaultWrapper(_deploy(0));
    }

    function testRevert_GlobalPauseFromFactoryFreezesInstanceDeposits()
        public
    {
        vm.prank(pauser);
        factory.globalPause();

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(instance), DEPOSIT);

        vm.expectRevert(ILiFiVaultWrapper.DepositsPaused.selector);

        instance.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    function test_GlobalUnpauseFromFactoryResumesInstanceDeposits() public {
        vm.prank(pauser);
        factory.globalPause();
        vm.prank(pauser);
        factory.globalUnpause();

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(instance), DEPOSIT);
        instance.deposit(DEPOSIT, alice);
        vm.stopPrank();

        assertEq(instance.balanceOf(alice), DEPOSIT);
    }

    function testRevert_DeployWhileGloballyPausedYieldsFrozenInstance()
        public
    {
        vm.prank(pauser);
        factory.globalPause();

        LiFiVaultWrapper frozen = LiFiVaultWrapper(_deploy(1));

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(frozen), DEPOSIT);

        vm.expectRevert(ILiFiVaultWrapper.DepositsPaused.selector);

        frozen.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    function _deploy(uint256 _nonce) internal returns (address) {
        FeeConfig memory fees;
        DeployParams memory params = DeployParams({
            namespace: NS,
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: _nonce,
            fees: fees,
            integratorShareBps: [
                type(uint16).max,
                type(uint16).max,
                type(uint16).max,
                type(uint16).max
            ],
            accessGate: address(0),
            receivers: defaultReceivers()
        });

        vm.prank(onboarder);
        return factory.deploy(params);
    }
}
