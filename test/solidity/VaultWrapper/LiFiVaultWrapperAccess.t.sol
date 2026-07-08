// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeConfig, FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { defaultReceivers } from "test/solidity/VaultWrapper/VaultWrapperTestHelpers.sol";
import { MockAccessGate, RevertingAccessGate } from "test/solidity/VaultWrapper/mocks/MockAccessGate.sol";

/// @notice ERC-4626 underlying with its own caller allowlist, standing in for a
///         permissioned third-party vault: the wrapper (the underlying's direct holder)
///         can be de-listed at any time, and the underlying's revert must bubble through
///         the wrapper verbatim — the wrapper can never bypass the underlying's perimeter.
contract GatedUnderlying is MockERC4626 {
    error NotOnUnderlyingAllowlist(address account);

    mapping(address => bool) public allowlisted;

    constructor(ERC20 _asset) MockERC4626(_asset, "Gated Yield", "gTKN") {}

    function setAllowlisted(address _account, bool _value) external {
        allowlisted[_account] = _value;
    }

    function deposit(
        uint256 _assets,
        address _to
    ) public override returns (uint256) {
        if (!allowlisted[msg.sender])
            revert NotOnUnderlyingAllowlist(msg.sender);

        return super.deposit(_assets, _to);
    }

    function withdraw(
        uint256 _assets,
        address _to,
        address _owner
    ) public override returns (uint256) {
        if (!allowlisted[msg.sender])
            revert NotOnUnderlyingAllowlist(msg.sender);

        return super.withdraw(_assets, _to, _owner);
    }
}

contract LiFiVaultWrapperAccessTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;
    MockAccessGate internal gate;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal integratorWallet = address(0xFEE1); // defaultReceivers() wallet

    uint256 internal constant DEPOSIT = 1_000e18;
    uint16 internal constant MGMT_RATE = 200; // 2% / year

    event AccessGateUpdated(address indexed accessGate);

    /// @dev This test contract is the `factory` (it deploys the beacon proxies), so the
    ///      wrapper reads the global circuit breaker and the LI.FI fee recipient back
    ///      from here.
    function globalPaused() external pure returns (bool) {
        return false;
    }

    function lifiFeeRecipient() external view returns (address) {
        return lifiRecipient;
    }

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
        gate = new MockAccessGate();
        wrapper = _newWrapper(address(underlying), address(gate), 0);
        gate.setAllowed(alice, true);
        gate.setAllowed(bob, true);
    }

    /// Gate wiring ///

    function test_ZeroGateIsFullyPermissionless() public {
        LiFiVaultWrapper open = _newWrapper(
            address(underlying),
            address(0),
            0
        );
        assertEq(open.accessGate(), address(0));

        // No party is on any list; deposit, transfer, and withdraw all pass.
        asset.mint(carol, DEPOSIT);
        vm.startPrank(carol);
        asset.approve(address(open), DEPOSIT);
        open.deposit(DEPOSIT, carol);
        open.transfer(bob, 1e18);
        open.withdraw(1e18, carol, carol);
        vm.stopPrank();

        assertGt(open.balanceOf(carol), 0);
        assertEq(open.balanceOf(bob), 1e18);
    }

    function test_InitializeStoresGateAndEmits() public {
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(adapter),
                vaultAdmin,
                _splits8000(),
                fees,
                defaultReceivers(),
                address(gate)
            )
        );

        vm.expectEmit(true, true, true, true);
        emit AccessGateUpdated(address(gate));

        LiFiVaultWrapper w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );

        assertEq(w.accessGate(), address(gate));
    }

    function test_SetAccessGateSwapsAndClears() public {
        MockAccessGate newGate = new MockAccessGate();

        vm.expectEmit(true, true, true, true, address(wrapper));
        emit AccessGateUpdated(address(newGate));

        vm.prank(vaultAdmin);
        wrapper.setAccessGate(address(newGate));

        assertEq(wrapper.accessGate(), address(newGate));

        vm.expectEmit(true, true, true, true, address(wrapper));
        emit AccessGateUpdated(address(0));

        vm.prank(vaultAdmin);
        wrapper.setAccessGate(address(0));

        assertEq(wrapper.accessGate(), address(0));
    }

    function testRevert_SetAccessGateOnlyOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                carol
            )
        );

        vm.prank(carol);
        wrapper.setAccessGate(address(0));
    }

    /// Entry: deposit/mint gate the share receiver ///

    function testRevert_DepositBlocksDisallowedReceiver() public {
        asset.mint(carol, DEPOSIT);
        vm.startPrank(carol);
        asset.approve(address(wrapper), DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.AccountNotAllowed.selector,
                carol
            )
        );
        wrapper.deposit(DEPOSIT, carol);

        vm.stopPrank();
    }

    function testRevert_MintBlocksDisallowedReceiver() public {
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.AccountNotAllowed.selector,
                carol
            )
        );
        wrapper.mint(1e18, carol);

        vm.stopPrank();
    }

    function test_DepositScreensReceiverNotSender() public {
        // carol (NOT allowed) deposits on behalf of alice (allowed): the proxied flow —
        // e.g. Composer as msg.sender — must pass on the end user's standing alone.
        asset.mint(carol, DEPOSIT);
        vm.startPrank(carol);
        asset.approve(address(wrapper), DEPOSIT);
        uint256 shares = wrapper.deposit(DEPOSIT, alice);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(wrapper.balanceOf(alice), shares);
        assertEq(wrapper.balanceOf(carol), 0);
    }

    /// Share transfers: gated on isTransferable(from, to) ///

    function testRevert_TransferBlocksDisallowedRecipient() public {
        _deposit(alice, DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.TransferNotAllowed.selector,
                alice,
                carol
            )
        );

        vm.prank(alice);
        wrapper.transfer(carol, 1e18);
    }

    function test_TransferAllowedBetweenAllowedHolders() public {
        _deposit(alice, DEPOSIT);

        vm.prank(alice);
        wrapper.transfer(bob, 1e18);

        assertEq(wrapper.balanceOf(bob), 1e18);
    }

    function testRevert_TransferFromEnforcesGate() public {
        _deposit(alice, DEPOSIT);

        vm.prank(alice);
        wrapper.approve(bob, 1e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.TransferNotAllowed.selector,
                alice,
                carol
            )
        );

        vm.prank(bob);
        wrapper.transferFrom(alice, carol, 1e18);
    }

    function testRevert_SoulboundGateBlocksAllTransfers() public {
        _deposit(alice, DEPOSIT);
        gate.setTransfersAllowed(false);

        // Both endpoints allowed, policy says no transfers at all.
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.TransferNotAllowed.selector,
                alice,
                bob
            )
        );

        vm.prank(alice);
        wrapper.transfer(bob, 1e18);
    }

    /// Exit: sanctions-only, owner AND asset receiver ///

    function testRevert_WithdrawBlocksSanctionedOwner() public {
        _deposit(alice, DEPOSIT);
        gate.setSanctioned(alice, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.AccountSanctioned.selector,
                alice
            )
        );

        vm.prank(alice);
        wrapper.withdraw(1e18, alice, alice);
    }

    function testRevert_RedeemBlocksSanctionedOwner() public {
        _deposit(alice, DEPOSIT);
        gate.setSanctioned(alice, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.AccountSanctioned.selector,
                alice
            )
        );

        vm.prank(alice);
        wrapper.redeem(1e18, alice, alice);
    }

    function testRevert_WithdrawBlocksSanctionedAssetReceiver() public {
        _deposit(alice, DEPOSIT);
        gate.setSanctioned(bob, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.AccountSanctioned.selector,
                bob
            )
        );

        vm.prank(alice);
        wrapper.withdraw(1e18, bob, alice);
    }

    function test_ExitOpenAfterFallingOffAllowlist() public {
        _deposit(alice, DEPOSIT);
        // Alice loses entry standing AND the gate turns soulbound; only sanctions can
        // freeze an exit, so she still withdraws (the burn never consults the gate).
        gate.setAllowed(alice, false);
        gate.setTransfersAllowed(false);

        vm.prank(alice);
        wrapper.withdraw(1e18, alice, alice);

        assertEq(asset.balanceOf(alice), 1e18);
    }

    /// Fee machinery: structurally exempt from the gate ///

    function test_AccrualAndSweepUnaffectedByDenyAllGate() public {
        // Management fee accrues real fee-shares to the wrapper.
        wrapper = _newWrapper(address(underlying), address(gate), MGMT_RATE);

        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + 30 days);

        // Slam the perimeter fully shut: nobody allowed, nothing transferable. The
        // accrual mint (from == 0) and the sweep payout (from == wrapper) must not care.
        gate.setAllowed(alice, false);
        gate.setAllowed(bob, false);
        gate.setTransfersAllowed(false);

        wrapper.sweep();

        assertGt(
            wrapper.balanceOf(integratorWallet) +
                wrapper.balanceOf(lifiRecipient),
            0
        );
        assertEq(wrapper.lifiFeeShares(), 0);
        assertEq(wrapper.integratorFeeShares(), 0);
    }

    /// Fail-closed: a broken gate blocks every guarded path, error bubbles verbatim ///

    function testRevert_BrokenGateBlocksDeposits() public {
        RevertingAccessGate broken = new RevertingAccessGate();
        vm.prank(vaultAdmin);
        wrapper.setAccessGate(address(broken));

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);

        vm.expectRevert(RevertingAccessGate.GateBroken.selector);
        wrapper.deposit(DEPOSIT, alice);

        vm.stopPrank();
    }

    function testRevert_BrokenGateBlocksExitsUntilSwapped() public {
        _deposit(alice, DEPOSIT);

        RevertingAccessGate broken = new RevertingAccessGate();
        vm.prank(vaultAdmin);
        wrapper.setAccessGate(address(broken));

        vm.expectRevert(RevertingAccessGate.GateBroken.selector);

        vm.prank(alice);
        wrapper.withdraw(1e18, alice, alice);

        // The accepted recovery path: the owner swaps the gate out, exits reopen.
        vm.prank(vaultAdmin);
        wrapper.setAccessGate(address(0));

        vm.prank(alice);
        wrapper.withdraw(1e18, alice, alice);

        assertEq(asset.balanceOf(alice), 1e18);
    }

    function testRevert_BrokenGateBlocksTransfers() public {
        _deposit(alice, DEPOSIT);

        RevertingAccessGate broken = new RevertingAccessGate();
        vm.prank(vaultAdmin);
        wrapper.setAccessGate(address(broken));

        vm.expectRevert(RevertingAccessGate.GateBroken.selector);

        vm.prank(alice);
        wrapper.transfer(bob, 1e18);
    }

    /// EIP-4626 limit views mirror the gate ///

    function test_MaxDepositAndMintReflectGate() public {
        assertGt(wrapper.maxDeposit(alice), 0);
        assertGt(wrapper.maxMint(alice), 0);
        assertEq(wrapper.maxDeposit(carol), 0);
        assertEq(wrapper.maxMint(carol), 0);
    }

    function test_MaxWithdrawAndRedeemReflectSanctions() public {
        _deposit(alice, DEPOSIT);
        assertGt(wrapper.maxWithdraw(alice), 0);
        assertGt(wrapper.maxRedeem(alice), 0);

        gate.setSanctioned(alice, true);

        assertEq(wrapper.maxWithdraw(alice), 0);
        assertEq(wrapper.maxRedeem(alice), 0);
    }

    function test_PreviewsStayGateBlind() public {
        // Per EIP-4626, previews must not reflect limits — a disallowed receiver still
        // gets a positive estimate (the matching deposit reverts AccountNotAllowed).
        assertGt(wrapper.previewDeposit(DEPOSIT), 0);
        assertGt(wrapper.previewMint(1e18), 0);
    }

    /// Underlying perimeter: never bypassed, reverts bubble verbatim ///

    function test_GatedUnderlyingRevertBubblesOnDepositAndWithdraw() public {
        GatedUnderlying gated = new GatedUnderlying(asset);
        LiFiVaultWrapper w = _newWrapper(address(gated), address(0), 0);

        // Wrapper not on the underlying's allowlist: deposit bubbles the gated error.
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                GatedUnderlying.NotOnUnderlyingAllowlist.selector,
                address(w)
            )
        );
        w.deposit(DEPOSIT, alice);

        vm.stopPrank();

        // Allowlist the wrapper, enter, then de-list it: the exit bubbles the same way.
        gated.setAllowlisted(address(w), true);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);
        w.deposit(DEPOSIT, alice);
        vm.stopPrank();

        gated.setAllowlisted(address(w), false);

        vm.expectRevert(
            abi.encodeWithSelector(
                GatedUnderlying.NotOnUnderlyingAllowlist.selector,
                address(w)
            )
        );

        vm.prank(alice);
        w.withdraw(1e18, alice, alice);
    }

    /// Helpers ///

    function _newWrapper(
        address _underlying,
        address _accessGate,
        uint16 _mgmtRateBps
    ) internal returns (LiFiVaultWrapper w) {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Management)] = _mgmtRateBps;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                _underlying,
                address(adapter),
                vaultAdmin,
                _splits8000(),
                fees,
                defaultReceivers(),
                _accessGate
            )
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

    function _splits8000() internal pure returns (uint16[4] memory) {
        return [uint16(8000), 8000, 8000, 8000];
    }
}
