// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { InvalidReceiver, NullAddrIsNotAValidSpender, InvalidAmount } from "lifi/Errors/GenericErrors.sol";

import { TestBase } from "../utils/TestBase.sol";
import { MockTronUSDT } from "../utils/MockTronUSDT.sol";

contract LibAssetImplementer {
    function transferAsset(
        address assetId,
        address payable recipient,
        uint256 amount
    ) public {
        LibAsset.transferAsset(assetId, recipient, amount);
    }

    function transferFromERC20(
        address assetId,
        address from,
        address payable recipient,
        uint256 amount
    ) public {
        LibAsset.transferFromERC20(assetId, from, recipient, amount);
    }

    function approveERC20(
        address assetId,
        address spender,
        uint256 requiredAllowance,
        uint256 setAllowanceTo
    ) public {
        LibAsset.approveERC20(
            IERC20(assetId),
            spender,
            requiredAllowance,
            setAllowanceTo
        );
    }

    function depositAsset(address assetId, uint256 amount) public {
        LibAsset.depositAsset(assetId, amount);
    }

    function transferERC20(
        address assetId,
        address recipient,
        uint256 amount
    ) public {
        LibAsset.transferERC20(assetId, recipient, amount);
    }

    function isContract(address account) public view returns (bool) {
        return LibAsset.isContract(account);
    }

    receive() external payable {}
}

/// @title LibAssetTest
/// @notice Unit tests for `LibAsset` via `LibAssetImplementer`.
/// @dev `TestBase` pulls in `forge-std` / fork setup; imports below follow [CONV:TESTS] (external → `lifi/` → `test/`).
contract LibAssetTest is TestBase {
    /// @dev Must match `LibAsset` `TRON_USDT` — official mainnet USDT TRC20
    ///      (base58 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t).
    address internal constant TRON_MAINNET_USDT =
        0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C;

    LibAssetImplementer internal implementer;

    function setUp() public {
        implementer = new LibAssetImplementer();
        initTestBase();

        vm.label(address(implementer), "LibAssetImplementer");
        vm.label(TRON_MAINNET_USDT, "TRON_MAINNET_USDT");
    }

    function testRevert_WhenSpenderIsZeroThenErc20ApprovalReverts() public {
        vm.expectRevert(NullAddrIsNotAValidSpender.selector);

        implementer.approveERC20(
            ADDRESS_USDC,
            address(0),
            defaultUSDCAmount,
            type(uint256).max
        );
    }

    function test_WhenAssetIsNativeThenApprovalIsNoOp() public {
        // Should return early without reverting when trying to approve native asset
        implementer.approveERC20(address(0), address(1), 1, 1);
    }

    function testRevert_InvalidReceiverWhenTokenSentToZeroAddress() public {
        vm.expectRevert(InvalidReceiver.selector);

        implementer.transferAsset(
            ADDRESS_USDC,
            payable(address(0)),
            defaultUSDCAmount
        );
    }

    function testRevert_InvalidReceiverWhenNativeSentToZeroAddress() public {
        vm.expectRevert(InvalidReceiver.selector);

        implementer.transferAsset(
            address(0),
            payable(address(0)),
            defaultUSDCAmount
        );
    }

    function testRevert_InvalidReceiverWhenPulledTokensDeliveredToZeroAddress() public {
        vm.expectRevert(InvalidReceiver.selector);

        implementer.transferFromERC20(
            ADDRESS_USDC,
            USER_SENDER,
            payable(address(0)),
            defaultUSDCAmount
        );
    }

    function testRevert_InvalidAmountWhenDepositingZero() public {
        vm.expectRevert(InvalidAmount.selector);

        implementer.depositAsset(ADDRESS_USDC, 0);
    }

    function test_RecognizesUsdcAsDeployedContract() public {
        bool result = implementer.isContract(ADDRESS_USDC);

        assertEq(result, true);
    }

    function test_TreatsZeroAddressAndEOAAsNonContracts() public {
        bool result = implementer.isContract(address(0));

        assertEq(result, false);

        result = implementer.isContract(USER_SENDER);

        assertEq(result, false);
    }

    // Tron USDT — `MockTronUSDT` + `vm.etch` at the canonical mainnet USDT *address* (`LibAsset.TRON_USDT`).
    // Simulates the on-chain buggy `transfer` return; no Tron JSON-RPC / fork (public RPCs are unreliable for Foundry).

    /// @notice Install `MockTronUSDT` bytecode at the canonical USDT *address* on a local chain (etch).
    ///         Drives the `LibAsset` Tron+USDT branch without a Tron fork.
    function _mockTronUSDTAtMainnetAddress() internal returns (MockTronUSDT) {
        MockTronUSDT impl = new MockTronUSDT();
        vm.etch(TRON_MAINNET_USDT, address(impl).code);

        return MockTronUSDT(TRON_MAINNET_USDT);
    }

    function test_SucceedsWhenSendingTronUsdtOnTronChain() public {
        MockTronUSDT tronUSDT = _mockTronUSDTAtMainnetAddress();
        tronUSDT.mint(address(implementer), 1000e6);

        vm.chainId(728126428); // Tron mainnet

        implementer.transferERC20(TRON_MAINNET_USDT, USER_RECEIVER, 500e6);

        assertEq(tronUSDT.balanceOf(USER_RECEIVER), 500e6);
        assertEq(tronUSDT.balanceOf(address(implementer)), 500e6);
    }

    function testRevert_TransferFailedWhenTronLikeTokenOnNonTronChain() public {
        MockTronUSDT tronUSDT = new MockTronUSDT();
        vm.label(address(tronUSDT), "MockTronUSDT_standalone");
        tronUSDT.mint(address(implementer), 1000e6);

        // On non-Tron chain, SafeTransferLib rejects the false return from transfer()
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);

        implementer.transferERC20(address(tronUSDT), USER_RECEIVER, 500e6);
    }

    function testRevert_InsufficientBalanceWhenSendingUnfundedTronUsdtOnTronChain() public {
        _mockTronUSDTAtMainnetAddress();
        // No tokens minted — insufficient balance

        vm.chainId(728126428);
        vm.expectRevert(MockTronUSDT.InsufficientBalance.selector);

        implementer.transferERC20(TRON_MAINNET_USDT, USER_RECEIVER, 500e6);
    }

    function testRevert_TransferFailedWhenNonCanonicalUsdtOnTronChain() public {
        MockTronUSDT buggy = new MockTronUSDT();
        vm.label(address(buggy), "MockTronUSDT_nonCanonical");
        buggy.mint(address(implementer), 1000e6);

        vm.chainId(728126428);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);

        implementer.transferERC20(address(buggy), USER_RECEIVER, 500e6);
    }

    /// @dev One unit to a dedicated receiver; uses local stub at canonical Tron USDT address.
    function test_SucceedsWhenSendingOneTronUsdtUnitOnTronChain() public {
        address receiver = address(0x1111);
        uint256 amount = 1e6;

        vm.label(receiver, "tronUSDT_fixedReceiver");

        MockTronUSDT tronUSDT = _mockTronUSDTAtMainnetAddress();
        tronUSDT.mint(address(implementer), amount);

        vm.chainId(728126428);

        uint256 recvBefore = tronUSDT.balanceOf(receiver);
        implementer.transferERC20(TRON_MAINNET_USDT, receiver, amount);

        assertEq(tronUSDT.balanceOf(receiver), recvBefore + amount);
        assertEq(tronUSDT.balanceOf(address(implementer)), 0);
    }

    function test_TronUsdtIsPresentAtCanonicalAddressAfterLocalStub() public {
        _mockTronUSDTAtMainnetAddress();

        assertGt(
            TRON_MAINNET_USDT.code.length,
            0,
            "etched mock must expose runtime code at TRON_MAINNET_USDT"
        );
    }

    function test_StablecoinTransferSucceedsBeforeAndAfterTronChainId() public {
        // Works on default chain (non-Tron)
        deal(ADDRESS_USDC, address(implementer), 1000e6);
        implementer.transferERC20(ADDRESS_USDC, USER_RECEIVER, 500e6);

        assertEq(IERC20(ADDRESS_USDC).balanceOf(USER_RECEIVER), 500e6);

        // Also works on Tron chain
        deal(ADDRESS_USDC, address(implementer), 1000e6);
        vm.chainId(728126428);
        implementer.transferERC20(ADDRESS_USDC, USER_RECEIVER, 500e6);

        assertEq(
            IERC20(ADDRESS_USDC).balanceOf(USER_RECEIVER),
            1000e6 // 500 + 500 from prior transfer
        );
    }

    function test_DelegationPrefixIsNotTreatedAsContract() public {
        // 0xef0100 is the delegation designator
        // build a 23‑byte blob: 0xef0100 ‖ <20‑byte delegate address>
        // here we just point back at the test contract itself,
        // but you can put any 20‑byte address
        bytes memory aaCode = abi.encodePacked(
            hex"ef0100",
            bytes20(address(this))
        );

        vm.etch(USER_SENDER, aaCode); // inject the delegation designator into the USER_SENDER address

        bool result = implementer.isContract(USER_SENDER);

        assertFalse(result, "Delegated EOA is not a contract");
    }
}
