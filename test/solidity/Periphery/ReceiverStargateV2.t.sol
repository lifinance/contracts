// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test, TestBase, Vm, LiFiDiamond, DSTest, ILiFi, LibSwap, LibAllowList, console, InvalidAmount, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { OnlyContractOwner, UnAuthorized, ExternalCallFailed } from "src/Errors/GenericErrors.sol";

import { ReceiverStargateV2 } from "lifi/Periphery/ReceiverStargateV2.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { OFTComposeMsgCodec } from "lifi/Libraries/OFTComposeMsgCodec.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";

contract ReceiverStargateV2Test is TestBase {
    using stdJson for string;

    ReceiverStargateV2 internal receiver;
    bytes32 guid = bytes32(0);
    address receiverAddress = USER_RECEIVER;

    address public constant STARGATE_USDC_POOL_MAINNET =
        0xc026395860Db2d07ee33e05fE50ed7bD583189C7;
    address public constant ENDPOINT_V2_MAINNET =
        0x1a44076050125825900e736c501f859c50fE728c;
    uint256 public constant RECOVER_GAS_VALUE = 100000;
    address stargateRouter;
    bytes32 internal transferId;
    Executor executor;
    ERC20Proxy erc20Proxy;

    event StargateRouterSet(address indexed router);
    event ExecutorSet(address indexed executor);
    event RecoverGasSet(uint256 indexed recoverGas);

    function setUp() public {
        customBlockNumberForForking = 20024274;
        initTestBase();

        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(erc20Proxy));
        receiver = new ReceiverStargateV2(
            address(this),
            address(executor),
            ENDPOINT_V2_MAINNET,
            RECOVER_GAS_VALUE
        );
        vm.label(address(receiver), "ReceiverStargateV2");
        vm.label(address(executor), "Executor");
        vm.label(address(erc20Proxy), "ERC20Proxy");

        transferId = keccak256("123");
    }

    function test_OwnerCanPullToken() public {
        // send token to receiver
        vm.startPrank(USER_SENDER);
        dai.transfer(address(receiver), 1000);
        vm.stopPrank();

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.pullToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);

        assertEq(1000, dai.balanceOf(USER_RECEIVER));
    }

    function test_PullTokenWillRevertIfExternalCallFails() public {
        vm.deal(address(receiver), 1 ether);

        // deploy contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(ExternalCallFailed.selector);

        receiver.pullToken(
            address(0),
            payable(address(nonETHReceiver)),
            1 ether
        );
    }

    function test_revert_PullTokenNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        receiver.pullToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);
    }

    function _getValidLzComposeCalldata()
        public
        view
        returns (bytes memory callData, uint256 amountOutMin)
    {
        // create swapdata
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountIn = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        amountOutMin = amounts[1];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: ADDRESS_USDC,
            receivingAssetId: ADDRESS_DAI,
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

        // create a 32 bytes long offset value (stargate would attach this to our payload on src chain)
        bytes memory offSetBytes32 = new bytes(32);

        // we add 32 bytes in the beginning of the calldata since this part will be cut off by OFTComposeMsgCodec.composeMsg();
        bytes memory payload = mergeBytes(
            offSetBytes32,
            abi.encode(guid, swapData, receiverAddress) // actual payload
        );

        uint64 nonce = uint64(12345645);
        uint32 srcEid = 30102;
        uint256 amountLD = defaultUSDCAmount;

        // this is the payload that we expect to receive in our lzCompose function as parameter _message
        callData = OFTComposeMsgCodec.encode(nonce, srcEid, amountLD, payload);
    }

    function test_contractIsSetUpCorrectly() public {
        receiver = new ReceiverStargateV2(
            address(this),
            address(executor),
            ENDPOINT_V2_MAINNET,
            100000
        );

        assertEq(address(receiver.executor()) == address(executor), true);
        assertEq(receiver.endpointV2() == ENDPOINT_V2_MAINNET, true);
        assertEq(receiver.recoverGas() == RECOVER_GAS_VALUE, true);
    }

    function test_OnlyEndpointV2CanCallLzCompose() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // get valid payload for calling lzCompose
        // https://stargateprotocol.gitbook.io/stargate/v/v2-developer-docs/integrate-with-stargate/composability#receive
        (bytes memory composeMsg, ) = _getValidLzComposeCalldata();

        // call from deployer of ReceiverStargateV2
        vm.startPrank(address(this));
        vm.expectRevert(UnAuthorized.selector);

        receiver.lzCompose{ gas: 400000 }(
            address(0),
            "",
            composeMsg,
            address(0),
            ""
        );
        // call from owner of ReceiverStargateV2
        vm.startPrank(address(this));
        vm.expectRevert(UnAuthorized.selector);

        receiver.lzCompose{ gas: 400000 }(
            address(0),
            "",
            composeMsg,
            address(0),
            ""
        );
        // call from owner of user
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);

        receiver.lzCompose{ gas: 400000 }(
            address(0),
            "",
            composeMsg,
            address(0),
            ""
        );
    }

    function test_canDecodeStargatePayloadAndExecuteSwap() public {
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);

        // encode payload with mock data like Stargate would according to:
        // https://stargateprotocol.gitbook.io/stargate/v/v2-developer-docs/integrate-with-stargate/composability#receive
        (
            bytes memory composeMsg,
            uint256 amountOutMin
        ) = _getValidLzComposeCalldata();

        vm.startPrank(ENDPOINT_V2_MAINNET);

        vm.expectEmit();
        emit LiFiTransferCompleted(
            bytes32(0),
            ADDRESS_USDC,
            receiverAddress,
            amountOutMin,
            block.timestamp
        );
        receiver.lzCompose{ gas: 400000 }(
            STARGATE_USDC_POOL_MAINNET,
            "",
            composeMsg,
            address(0),
            ""
        );

        assertTrue(dai.balanceOf(receiverAddress) == amountOutMin);
    }

    // HELPER FUNCTIONS
    function mergeBytes(
        bytes memory a,
        bytes memory b
    ) public pure returns (bytes memory c) {
        // Store the length of the first array
        uint alen = a.length;
        // Store the length of BOTH arrays
        uint totallen = alen + b.length;
        // Count the loops required for array a (sets of 32 bytes)
        uint loopsa = (a.length + 31) / 32;
        // Count the loops required for array b (sets of 32 bytes)
        uint loopsb = (b.length + 31) / 32;
        assembly {
            let m := mload(0x40)
            // Load the length of both arrays to the head of the new bytes array
            mstore(m, totallen)
            // Add the contents of a to the array
            for {
                let i := 0
            } lt(i, loopsa) {
                i := add(1, i)
            } {
                mstore(
                    add(m, mul(32, add(1, i))),
                    mload(add(a, mul(32, add(1, i))))
                )
            }
            // Add the contents of b to the array
            for {
                let i := 0
            } lt(i, loopsb) {
                i := add(1, i)
            } {
                mstore(
                    add(m, add(mul(32, add(1, i)), alen)),
                    mload(add(b, mul(32, add(1, i))))
                )
            }
            mstore(0x40, add(m, add(32, totallen)))
            c := m
        }
    }
}

contract NonETHReceiver {
    // this contract cannot receive any ETH due to missing receive function
}
