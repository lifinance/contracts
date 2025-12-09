// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReceiverOIF } from "lifi/Periphery/ReceiverOIF.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { MandateOutput } from "lifi/Interfaces/IOpenIntentFramework.sol";

import { TestBase, LibSwap } from "../utils/TestBase.sol";

address constant OUTPUT_SETTLER_COIN = 0x0000000000eC36B683C2E6AC89e9A75989C22a2e;

interface OutputSettler {
    function fill(
        bytes32 orderId,
        MandateOutput calldata output,
        uint48 fillDeadline,
        bytes calldata fillerData
    ) external payable returns (bytes32 fillRecordHash);
}

contract NonETHReceiver {
    // this contract cannot receive any ETH due to missing receive function
}

contract ReceiverOIFTest is TestBase {
    Executor internal executor;
    ERC20Proxy internal erc20Proxy;
    ReceiverOIF internal receiver;

    bytes32 internal transferId = keccak256("Hello");

    function setUp() public {
        // Block after deployment.
        customBlockNumberForForking = 23695990;
        initTestBase();

        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(erc20Proxy), address(this));
        receiver = new ReceiverOIF(
            address(this),
            address(executor),
            OUTPUT_SETTLER_COIN
        );
    }

    function test_OwnerCanWithdrawERC20Token() public {
        // fund receiver with ERC20 tokens
        deal(ADDRESS_DAI, address(receiver), 1000);

        uint256 initialBalance = dai.balanceOf(USER_RECEIVER);

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.withdrawToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);

        assertEq(dai.balanceOf(USER_RECEIVER), initialBalance + 1000);
    }

    function test_OwnerCanWithdrawNativeToken() public {
        // fund receiver with native tokens
        vm.deal(address(receiver), 1 ether);

        uint256 initialBalance = USER_RECEIVER.balance;

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.withdrawToken(address(0), payable(USER_RECEIVER), 1 ether);

        assertEq(USER_RECEIVER.balance, initialBalance + 1 ether);
    }

    function test_WithdrawTokenWillRevertIfExternalCallFails() public {
        vm.deal(address(receiver), 1 ether);

        // deploy contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(abi.encodeWithSignature("ExternalCallFailed()"));

        receiver.withdrawToken(
            address(0),
            payable(address(nonETHReceiver)),
            1 ether
        );
    }

    function test_revert_WithdrawTokenNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.withdrawToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);
    }

    function test_contractIsSetUpCorrectly() public {
        assertEq(address(receiver.EXECUTOR()) == address(executor), true);
        assertEq(receiver.OUTPUT_SETTLER() == OUTPUT_SETTLER_COIN, true);
    }

    function _getSwapData(
        address _sendingAssetId,
        address _receivingAssetId
    )
        public
        view
        returns (LibSwap.SwapData[] memory swapData, uint256 amountOutMin)
    {
        address[] memory path = new address[](2);
        path[0] = _sendingAssetId;
        path[1] = _receivingAssetId;

        uint256 amountIn = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        amountOutMin = amounts[1];
        swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: _sendingAssetId,
            receivingAssetId: _receivingAssetId,
            fromAmount: amountIn,
            callData: abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOutMin,
                path,
                address(executor),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });
    }

    function test_OnlyOutputSettlerCanCallOutputFilled() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        (LibSwap.SwapData[] memory swapData, ) = _getSwapData(
            ADDRESS_USDC,
            ADDRESS_WRAPPED_NATIVE
        );

        bytes memory payload = abi.encode(transferId, swapData, USER_RECEIVER);

        // call from deployer of ReceiverStargateV2
        vm.startPrank(address(this));
        vm.expectRevert(UnAuthorized.selector);

        receiver.outputFilled(
            bytes32(uint256(uint160(ADDRESS_USDC))),
            defaultUSDCAmount,
            payload
        );
        // call from owner of ReceiverStargateV2
        vm.startPrank(address(this));
        vm.expectRevert(UnAuthorized.selector);

        receiver.outputFilled(
            bytes32(uint256(uint160(ADDRESS_USDC))),
            defaultUSDCAmount,
            payload
        );
        // call from owner of user
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);

        receiver.outputFilled(
            bytes32(uint256(uint160(ADDRESS_USDC))),
            defaultUSDCAmount,
            payload
        );
    }

    function testRevert_tooLittleGas() public {
        (LibSwap.SwapData[] memory swapData, ) = _getSwapData(
            ADDRESS_USDC,
            ADDRESS_DAI
        );

        bytes memory payload = abi.encode(transferId, swapData, USER_RECEIVER);

        vm.startPrank(OUTPUT_SETTLER_COIN);
        vm.expectRevert();

        receiver.outputFilled{ gas: 10000 }(
            bytes32(uint256(uint160(ADDRESS_USDC))),
            defaultUSDCAmount,
            payload
        );
    }

    function test_canExecuteSwap() public {
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountOutMin
        ) = _getSwapData(ADDRESS_USDC, ADDRESS_DAI);

        bytes memory payload = abi.encode(transferId, swapData, USER_RECEIVER);

        MandateOutput memory output = MandateOutput({
            oracle: bytes32(0), // not relevant
            settler: bytes32(uint256(uint160(OUTPUT_SETTLER_COIN))),
            chainId: block.chainid,
            token: bytes32(uint256(uint160(ADDRESS_USDC))),
            amount: defaultUSDCAmount,
            recipient: bytes32(uint256(uint160(address(receiver)))),
            callbackData: payload,
            context: hex""
        });

        // demonstrates that fill(...) call is not permissioned or have to be connected to an actual contract.
        address randomFillerAccount = makeAddr("randomFillerAccount");
        vm.startPrank(randomFillerAccount);

        // Give filler funds to fill output
        deal(ADDRESS_USDC, address(randomFillerAccount), defaultUSDCAmount);

        IERC20(ADDRESS_USDC).approve(OUTPUT_SETTLER_COIN, defaultUSDCAmount);

        vm.expectEmit();
        emit LiFiTransferCompleted(
            transferId,
            ADDRESS_USDC,
            USER_RECEIVER,
            amountOutMin,
            block.timestamp
        );
        OutputSettler(OUTPUT_SETTLER_COIN).fill(
            keccak256("orderId"),
            output,
            type(uint48).max,
            abi.encode(randomFillerAccount)
        );

        assertTrue(dai.balanceOf(USER_RECEIVER) == amountOutMin);
    }

    function testRevert_cannotFillERC20WithInvalidCalldata() public {
        (LibSwap.SwapData[] memory swapData, ) = _getSwapData(
            ADDRESS_USDC,
            ADDRESS_DAI
        );
        // Screw up the swapData. This is not be valid calldata.
        swapData[0].callData = abi.encode(swapData[0].callData);

        bytes memory payload = abi.encode(transferId, swapData, USER_RECEIVER);

        MandateOutput memory output = MandateOutput({
            oracle: bytes32(0), // not relevant
            settler: bytes32(uint256(uint160(OUTPUT_SETTLER_COIN))),
            chainId: block.chainid,
            token: bytes32(uint256(uint160(ADDRESS_USDC))),
            amount: defaultUSDCAmount,
            recipient: bytes32(uint256(uint160(address(receiver)))),
            callbackData: payload,
            context: hex""
        });

        // demonstrates that fill(...) call is not permissioned or have to be connected to an actual contract.
        address randomFillerAccount = makeAddr("randomFillerAccount");
        vm.startPrank(randomFillerAccount);

        // Give filler funds to fill output
        deal(ADDRESS_USDC, address(randomFillerAccount), defaultUSDCAmount);
        IERC20(ADDRESS_USDC).approve(OUTPUT_SETTLER_COIN, defaultUSDCAmount);

        vm.expectRevert();
        OutputSettler(OUTPUT_SETTLER_COIN).fill(
            keccak256("orderId"),
            output,
            type(uint48).max,
            abi.encode(randomFillerAccount)
        );
    }

    function testRevert_cannotFillNativeWithInvalidCalldata() public {
        uint256 amount = defaultUSDCAmount;
        // While this is a native swap, we don't need to fix the swapData since we very strictly wants this to fail.
        (LibSwap.SwapData[] memory swapData, ) = _getSwapData(
            ADDRESS_USDC,
            ADDRESS_DAI
        );
        // Screw up the swapData. This is not be valid calldata.
        swapData[0].callData = abi.encode(swapData[0].callData);

        bytes memory payload = abi.encode(transferId, swapData, USER_RECEIVER);

        MandateOutput memory output = MandateOutput({
            oracle: bytes32(0), // not relevant
            settler: bytes32(uint256(uint160(OUTPUT_SETTLER_COIN))),
            chainId: block.chainid,
            token: bytes32(0),
            amount: amount,
            recipient: bytes32(uint256(uint160(address(receiver)))),
            callbackData: payload,
            context: hex""
        });

        // demonstrates that fill(...) call is not permissioned or have to be connected to an actual contract.
        address randomFillerAccount = makeAddr("randomFillerAccount");
        vm.startPrank(randomFillerAccount);

        // Give filler funds to fill output
        deal(address(randomFillerAccount), amount);

        vm.expectRevert();
        OutputSettler(OUTPUT_SETTLER_COIN).fill{ value: amount }(
            keccak256("orderId"),
            output,
            type(uint48).max,
            abi.encode(randomFillerAccount)
        );
    }
}
