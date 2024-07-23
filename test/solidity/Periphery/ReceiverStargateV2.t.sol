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

address constant ENDPOINT_V2_MAINNET = 0x1a44076050125825900e736c501f859c50fE728c;
address constant STARGATE_NATIVE_POOL_MAINNET = 0x77b2043768d28E9C9aB44E1aBfC95944bcE57931;
bytes4 constant LZ_COMPOSE_NOT_FOUND_SELECTOR = bytes4(
    keccak256("LZ_ComposeNotFound(bytes32,bytes32)")
);
bytes32 constant RECEIVED_MESSAGE_HASH = bytes32(uint256(1));

contract ReceiverStargateV2Test is TestBase {
    using stdJson for string;

    ReceiverStargateV2 internal receiver;
    bytes32 guid = bytes32(0);
    address receiverAddress = USER_RECEIVER;

    address public constant STARGATE_USDC_POOL_MAINNET =
        0xc026395860Db2d07ee33e05fE50ed7bD583189C7;
    address public constant STARGATE_TOKEN_MESSAGING_MAINNET =
        0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980;
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
            STARGATE_TOKEN_MESSAGING_MAINNET,
            ENDPOINT_V2_MAINNET,
            RECOVER_GAS_VALUE
        );
        vm.label(address(receiver), "ReceiverStargateV2");
        vm.label(address(executor), "Executor");
        vm.label(address(erc20Proxy), "ERC20Proxy");

        transferId = keccak256("123");
    }

    function test_OwnerCanPullERC20Token() public {
        // fund receiver with ERC20 tokens
        deal(ADDRESS_DAI, address(receiver), 1000);

        uint256 initialBalance = dai.balanceOf(USER_RECEIVER);

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.pullToken(ADDRESS_DAI, payable(USER_RECEIVER), 1000);

        assertEq(dai.balanceOf(USER_RECEIVER), initialBalance + 1000);
    }

    function test_OwnerCanPullNativeToken() public {
        // fund receiver with native tokens
        vm.deal(address(receiver), 1 ether);

        uint256 initialBalance = USER_RECEIVER.balance;

        // pull token
        vm.startPrank(USER_DIAMOND_OWNER);

        receiver.pullToken(address(0), payable(USER_RECEIVER), 1 ether);

        assertEq(USER_RECEIVER.balance, initialBalance + 1 ether);
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

    function _getValidLzComposeCalldata(
        address _sendingAssetId,
        address _receivingAssetId
    ) public view returns (bytes memory callData, uint256 amountOutMin) {
        // create swapdata
        address[] memory path = new address[](2);
        path[0] = _sendingAssetId;
        path[1] = _receivingAssetId;

        uint256 amountIn = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        amountOutMin = amounts[1];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
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
            STARGATE_TOKEN_MESSAGING_MAINNET,
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
        (bytes memory composeMsg, ) = _getValidLzComposeCalldata(
            ADDRESS_USDC,
            ADDRESS_WRAPPED_NATIVE
        );

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

    function test_lzCompose_reentrancy() public {
        ReentrantReceiver reentrantReceiver = new ReentrantReceiver(
            address(receiver)
        );
        receiverAddress = address(reentrantReceiver);
        vm.deal(receiverAddress, 100 ether);
        // mock-send bridged funds to receiver contract
        deal(ADDRESS_USDC, address(receiver), defaultUSDCAmount);
        vm.deal(address(receiver), 1 ether);

        (bytes memory composeMsg, ) = _getValidLzComposeCalldata(
            ADDRESS_USDC,
            ADDRESS_WRAPPED_NATIVE
        );

        vm.startPrank(STARGATE_NATIVE_POOL_MAINNET);
        IMessagingComposer(ENDPOINT_V2_MAINNET).sendCompose(
            address(receiver),
            guid,
            0,
            composeMsg
        );

        address nonPermissionedUser = makeAddr("nonPermissionedUser");
        vm.startPrank(nonPermissionedUser);

        IMessagingComposer(ENDPOINT_V2_MAINNET).lzCompose{ gas: 400000 }(
            STARGATE_NATIVE_POOL_MAINNET,
            address(receiver),
            "",
            0,
            composeMsg,
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
        ) = _getValidLzComposeCalldata(ADDRESS_USDC, ADDRESS_DAI);

        // fake a sendCompose from USDC pool on ETH mainnet
        vm.startPrank(STARGATE_USDC_POOL_MAINNET);
        IMessagingComposer(ENDPOINT_V2_MAINNET).sendCompose(
            address(receiver),
            guid,
            0,
            composeMsg
        );

        // demonstrates that lzCompose(...) call is not permissioned, and that the authenticity criteria is determined in sendCompose(...) by msg.sender
        address nonPermissionedUser = makeAddr("nonPermissionedUser");
        vm.startPrank(nonPermissionedUser);

        vm.expectEmit();
        emit LiFiTransferCompleted(
            bytes32(0),
            ADDRESS_USDC,
            receiverAddress,
            amountOutMin,
            block.timestamp
        );
        IMessagingComposer(ENDPOINT_V2_MAINNET).lzCompose{ gas: 400000 }(
            STARGATE_USDC_POOL_MAINNET,
            address(receiver),
            "",
            0,
            composeMsg,
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

interface IMessagingComposer {
    function sendCompose(
        address _to,
        bytes32 _guid,
        uint16 _index,
        bytes calldata _message
    ) external;

    function lzCompose(
        address _from,
        address _to,
        bytes32 _guid,
        uint16 _index,
        bytes calldata _message,
        bytes calldata _extraData
    ) external payable;
}

contract NonETHReceiver {
    // this contract cannot receive any ETH due to missing receive function
}

contract ReentrantReceiver {
    bytes internal composeMsg;

    address internal receiver;

    constructor(address _receiver) {
        receiver = _receiver;
    }

    function setComposeMsg(bytes memory _composeMsg) public {
        composeMsg = _composeMsg;
    }

    function assertEqual(bytes memory a, bytes memory b) public pure {
        require(a.length == b.length, "Bytes arrays must be of equal length");

        for (uint i = 0; i < a.length; i++) {
            require(a[i] == b[i], "Bytes arrays not equal");
        }
    }

    receive() external payable {
        // contrived to match test_lzCompose_reentrancy
        try
            IMessagingComposer(ENDPOINT_V2_MAINNET).lzCompose{ gas: 400000 }(
                address(STARGATE_NATIVE_POOL_MAINNET),
                receiver,
                "",
                0,
                composeMsg,
                ""
            )
        {} catch (bytes memory reason) {
            assertEqual(
                abi.encodeWithSelector(
                    LZ_COMPOSE_NOT_FOUND_SELECTOR,
                    RECEIVED_MESSAGE_HASH, // already received;  indicates reentrancy caught
                    bytes32(
                        0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470 // precomputed
                    )
                ),
                reason
            );
        }
    }
}
