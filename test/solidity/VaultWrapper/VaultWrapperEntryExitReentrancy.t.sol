// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFeeTestBase } from "test/solidity/VaultWrapper/VaultWrapperFeeTestBase.sol";

/// @notice Minimal 1:1 ERC-4626-shaped yield source that hands control back to the wrapper
///         from inside `deposit`/`withdraw`. The wrapper delegatecalls its adapter, so the
///         source is called with the wrapper as `msg.sender` and is the one untrusted
///         contract every entry and exit necessarily routes through.
contract ReenteringSourceVault {
    enum Hook {
        None,
        Mint,
        Withdraw
    }

    MockERC20 private immutable ASSET;
    LiFiVaultWrapper private wrapper;
    Hook private hook;
    bool private entered;

    mapping(address => uint256) public balanceOf;

    constructor(MockERC20 _asset) {
        ASSET = _asset;
    }

    function arm(LiFiVaultWrapper _wrapper, Hook _hook) external {
        wrapper = _wrapper;
        hook = _hook;
        entered = false;
    }

    function asset() external view returns (address) {
        return address(ASSET);
    }

    function convertToAssets(uint256 _shares) external pure returns (uint256) {
        return _shares;
    }

    function maxWithdraw(address _holder) external view returns (uint256) {
        return balanceOf[_holder];
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function deposit(
        uint256 _assets,
        address _receiver
    ) external returns (uint256) {
        ASSET.transferFrom(msg.sender, address(this), _assets);
        balanceOf[_receiver] += _assets;
        _reenter(Hook.Mint);

        return _assets;
    }

    function withdraw(
        uint256 _assets,
        address _receiver,
        address _owner
    ) external returns (uint256) {
        balanceOf[_owner] -= _assets;
        ASSET.transfer(_receiver, _assets);
        _reenter(Hook.Withdraw);

        return _assets;
    }

    /// @dev Fires once per arming so a guard-less wrapper recurses exactly one level
    ///      instead of running out of gas, which would mask the missing guard.
    function _reenter(Hook _hook) private {
        if (hook != _hook || entered) return;
        entered = true;

        if (_hook == Hook.Mint) {
            wrapper.mint(1e6, address(this));
        } else {
            wrapper.withdraw(1, address(this), address(this));
        }
    }
}

/// @notice The entry/exit reentrancy guards, driven from the yield source the wrapper hands
///         control to mid-operation. Each test reenters the SAME entrypoint it is testing:
///         a shared guard means reentering a different one would revert on the outer
///         function's guard and pass even with the inner one removed.
contract VaultWrapperEntryExitReentrancyTest is VaultWrapperFeeTestBase {
    ReenteringSourceVault internal source;

    function setUp() public override {
        super.setUp();
        source = new ReenteringSourceVault(asset);

        uint16[4] memory noFees;
        wrapper = _newWrapperFor(
            address(source),
            FeeConfig({ rateBps: noFees }),
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );

        // The source needs its own funded, pre-approved position so the reentrant call
        // fails on the guard rather than on a missing balance or allowance.
        asset.mint(address(source), DEPOSIT);
        vm.prank(address(source));
        asset.approve(address(wrapper), type(uint256).max);
    }

    function testRevert_MintCannotBeReenteredFromYieldSource() public {
        source.arm(wrapper, ReenteringSourceVault.Hook.Mint);

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        wrapper.mint(DEPOSIT, alice);
        vm.stopPrank();
    }

    function testRevert_WithdrawCannotBeReenteredFromYieldSource() public {
        _deposit(alice, DEPOSIT); // hook still disarmed, so the entry succeeds
        source.arm(wrapper, ReenteringSourceVault.Hook.Withdraw);

        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        wrapper.withdraw(DEPOSIT / 2, alice, alice);
    }
}
