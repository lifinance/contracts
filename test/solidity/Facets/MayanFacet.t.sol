// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// solhint-disable max-line-length

import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";
import { IMayan } from "lifi/Interfaces/IMayan.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { InvalidCallData, InvalidConfig, InvalidNonEVMReceiver, InvalidAmount, InvalidSendingToken } from "src/Errors/GenericErrors.sol";
import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Stub MayanFacet Contract
contract TestMayanFacet is MayanFacet, TestWhitelistManagerBase {
    constructor(IMayan _bridge) MayanFacet(_bridge) {}
}

/// @notice Mirrors Mayan Swift v2 encoders for `abi.encodeCall` fixtures (no on-chain deployment).
interface ISwiftV2Encode {
    struct OrderParams {
        uint8 payloadType;
        bytes32 trader;
        bytes32 destAddr;
        uint16 destChainId;
        bytes32 referrerAddr;
        bytes32 tokenOut;
        uint64 minAmountOut;
        uint64 gasDrop;
        uint64 cancelFee;
        uint64 refundFee;
        uint64 deadline;
        uint8 referrerBps;
        uint8 auctionMode;
        bytes32 random;
    }

    struct PermitParams {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function createOrderWithToken(
        address tokenIn,
        uint256 amountIn,
        OrderParams calldata params,
        bytes calldata customPayload
    ) external;

    function createOrderWithSig(
        address tokenIn,
        uint256 amountIn,
        OrderParams calldata params,
        bytes calldata customPayload,
        uint256 submissionFee,
        bytes calldata signedOrderHash,
        PermitParams calldata permitParams
    ) external;
}

/// @notice This contract exposes _parseReceiver, _parseHypercoreReceiver and
///         _replaceInputAmount for testing purposes.
contract TestMayanFacetExposed is MayanFacet {
    constructor(IMayan _mayan) MayanFacet(_mayan) {}

    /// @dev Exposes the internal _parseReceiver function on the non-HyperCore (destAddr) path.
    function testParseReceiver(
        bytes memory protocolData
    ) public pure returns (bytes32) {
        return _parseReceiver(protocolData, 0);
    }

    /// @dev Exposes the internal _parseHypercoreReceiver function.
    function testParseHypercoreReceiver(
        bytes memory protocolData
    ) public pure returns (bytes32) {
        return _parseHypercoreReceiver(protocolData);
    }

    /// @dev Exposes _parseReceiver with an explicit destination chain id.
    function testParseReceiverForChain(
        bytes memory protocolData,
        uint256 destinationChainId
    ) public pure returns (bytes32) {
        return _parseReceiver(protocolData, destinationChainId);
    }

    /// @dev Exposes the internal _replaceInputAmount function.
    function testReplaceInputAmount(
        bytes memory protocolData,
        uint256 inputAmount
    ) public pure returns (bytes memory) {
        return _replaceInputAmount(protocolData, inputAmount);
    }
}

/// @notice Records the arguments the facet forwards to `swapAndForwardEth` so tests can assert
///         amount handling and pass-through without depending on Mayan's real forwarder. Etched
///         onto the forwarder address so the facet's live external call lands here.
contract MockMayanSwapForwarder {
    uint256 public lastValue;
    uint256 public lastAmountIn;
    address public lastSwapProtocol;
    bytes public lastSwapData;
    address public lastMiddleToken;
    uint256 public lastMinMiddleAmount;
    address public lastMayanProtocol;
    bytes public lastMayanData;

    function swapAndForwardEth(
        uint256 amountIn,
        address swapProtocol,
        bytes calldata swapData,
        address middleToken,
        uint256 minMiddleAmount,
        address mayanProtocol,
        bytes calldata mayanData
    ) external payable {
        lastValue = msg.value;
        lastAmountIn = amountIn;
        lastSwapProtocol = swapProtocol;
        lastSwapData = swapData;
        lastMiddleToken = middleToken;
        lastMinMiddleAmount = minMiddleAmount;
        lastMayanProtocol = mayanProtocol;
        lastMayanData = mayanData;
    }
}

contract MayanFacetTest is TestBaseFacet {
    MayanFacet.MayanData internal validMayanData;
    MayanFacet.MayanData internal validMayanDataNative;
    MayanFacet.MayanData internal invalidMayanDataEVM2Solana;
    TestMayanFacet internal mayanBridgeFacet;
    IMayan internal constant MAYAN_FORWARDER =
        IMayan(0x0654874eb7F59C6f5b39931FC45dC45337c967c3);
    address internal constant POLYGON_USDT =
        0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    address internal constant DEV_WALLET =
        0x29DaCdF7cCaDf4eE67c923b4C22255A4B2494eD7;

    bytes32 internal constant ACTUAL_SOL_ADDR =
        hex"4cb7c5f1632114c376c0e7a9a1fd1fbd562699fbd9a0c9f4f26ba8cf6e23df0d"; // [pre-commit-checker: not a secret]
    bytes32 internal constant EXPECTED_SOL_ADDR = bytes32("EXPECTED ADDRESS");
    address internal constant HYPERCORE_RECEIVER =
        0xd01e6A41E4DE4032830C99aa79c0206753De628A;
    /// @dev Mayan's native-swap forwarder shape the swapAndForwardEth path targets.
    address internal constant MAYAN_NATIVE_SWAP_PROTOCOL =
        0x337685fdaB40D39bd02028545a4FfA7D287cC3E2;
    /// @dev Arbitrum WETH; middleToken for Mayan's implicit 1:1 ETH->WETH conversion.
    address internal constant ARBITRUM_WETH =
        0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    error InvalidReceiver(address expected, address actual);
    error ProtocolDataTooShort();

    function setUp() public {
        customBlockNumberForForking = 19968172;
        initTestBase();

        setupMayan();

        // adjust bridgeData
        bridgeData.bridge = "mayanBridge";
        bridgeData.destinationChainId = 137;

        // produce valid MayanData
        validMayanData = MayanFacet.MayanData(
            "",
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            // Calldata generated from Mayan SDK 100 USDC on Mainnet -> USDT on Polygon
            hex"afd9b706000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc6543210000000000000000000000000000000000000000000000000000000000000005000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f0000000000000000000000000000000000000000000000000000000005aa76a8000000000000000000000000000000000000000000000000000000006655d64300000000000000000000000000000000000000000000000000000000001ff535000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c",
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );

        validMayanDataNative = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Calldata generated from Mayan SDK 1 ETH -> USDT on Polygon
            hex"1eb1cff00000000000000000000000000000000000000000000000000000000000013e0b0000000000000000000000000000000000000000000000000000000000004df200000000000000000000000000000000000000000000000000000000000a42dfcb617b639c537bd08846f61be4481c34f9391f1b8f53d082de024e232508113e00000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c390000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000006655d880000000000000000000000000000000000000000000000000000000006655d88000000000000000000000000000000000000000000000000000000000e16ffab40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000",
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );

        invalidMayanDataEVM2Solana = MayanFacet.MayanData(
            EXPECTED_SOL_ADDR,
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Send tokens to Solana
            hex"6111ad2500000000000000000000000000000000000000000000000000000000002fa3e500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010883f01f2183c5bf05d6756bf0b0aade846ff42b2bc9afe11e60e677d80270a38b3500000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c394cb7c5f1632114c376c0e7a9a1fd1fbd562699fbd9a0c9f4f26ba8cf6e23df0d0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed7c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000665e43ef00000000000000000000000000000000000000000000000000000000665e43ef00000000000000000000000000000000000000000000000000000000006869570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000",
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );
    }

    function setupMayan() internal {
        mayanBridgeFacet = new TestMayanFacet(MAYAN_FORWARDER);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = mayanBridgeFacet
            .startBridgeTokensViaMayan
            .selector;
        functionSelectors[1] = mayanBridgeFacet
            .swapAndStartBridgeTokensViaMayan
            .selector;
        functionSelectors[2] = mayanBridgeFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = mayanBridgeFacet
            .removeAllowedContractSelector
            .selector;

        addFacet(diamond, address(mayanBridgeFacet), functionSelectors);
        mayanBridgeFacet = TestMayanFacet(address(diamond));
        mayanBridgeFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        mayanBridgeFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        mayanBridgeFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(mayanBridgeFacet), "MayanFacet");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            mayanBridgeFacet.startBridgeTokensViaMayan{
                value: bridgeData.minAmount
            }(bridgeData, validMayanDataNative);
        } else {
            mayanBridgeFacet.startBridgeTokensViaMayan(
                bridgeData,
                validMayanData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (LibAsset.isNativeAsset(bridgeData.sendingAssetId)) {
            validMayanData = validMayanDataNative;
        }

        if (isNative) {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayan{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validMayanData);
        } else {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayan(
                bridgeData,
                swapData,
                validMayanData
            );
        }
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestMayanFacet(IMayan(address(0)));
    }

    function testBase_CanSwapAndBridgeNativeTokens()
        public
        override
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialUSDCBalance = usdc.balanceOf(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        usdc.approve(_facetTestContractAddress, amountIn);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_USDC,
            address(0),
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUSDCBalance - swapData[0].fromAmount
        );
    }

    function test_CanSwapAndBridgeTokensFromNative()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialETHBalance = USER_SENDER.balance;

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        address[] memory path = new address[](2);

        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(true);

        // check balances after call
        assertEq(
            USER_SENDER.balance,
            initialETHBalance - swapData[0].fromAmount
        );
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        amount = bound(amount, 150, 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }

    function testRevert_FailsIfNonEVMReceiverIsIncorrect() public {
        bridgeData.receiver = NON_EVM_ADDRESS;
        validMayanData = invalidMayanDataEVM2Solana;
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(InvalidNonEVMReceiver.selector)
        );

        mayanBridgeFacet.startBridgeTokensViaMayan(bridgeData, validMayanData);

        vm.stopPrank();
    }

    function test_CanSwapAndBridgeTokensWithMoreThan8Decimals()
        public
        virtual
    {
        // Overrides
        // Change fork to BSC
        customRpcUrlForForking = "ETH_NODE_URI_BSC";
        customBlockNumberForForking = 39980051;
        ADDRESS_USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
        ADDRESS_USDT = 0x55d398326f99059fF775485246999027B3197955;
        ADDRESS_DAI = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
        ADDRESS_UNISWAP = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
        ADDRESS_WRAPPED_NATIVE = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
        vm.label(DEV_WALLET, "DEV_WALLET");
        initTestBase();
        setupMayan();

        // transfer initial DAI/USDC/WETH balance to USER_SENDER
        deal(ADDRESS_USDC, DEV_WALLET, 100_000 * 10 ** usdc.decimals());
        deal(ADDRESS_DAI, DEV_WALLET, 100_000 * 10 ** dai.decimals());
        deal(
            ADDRESS_WRAPPED_NATIVE,
            DEV_WALLET,
            100_000 * 10 ** weth.decimals()
        );

        // fund USER_SENDER with 1000 ether
        vm.deal(DEV_WALLET, 1000 ether);

        validMayanData = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Calldata generated from Mayan SDK 4.12312312 USDC on Mainnet -> Arbitrum
            hex"6111ad25000000000000000000000000000000000000000000000000000000000f52ae0e000000000000000000000000000000000000000000000000000000000000f2d000000000000000000000000000000000000000000000000000000000018eb30afc7fcf68097cd0584877939477347b5b8fa10efee2e29805370a35fd2a22ee9500000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c3900000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed700000000000000000000000000000000000000000000000000000000000000171e8c4fab8994494c8f1e5c1287445b2917d60c43c79aa959162f5d6000598d3200000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed7000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000000001700000000000000000000000000000000000000000000000000000000000001e00000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d000000000000000000000000000000000000000000000000393846a1e4cce00000000000000000000000000000000000000000000000000000000000667d7a7a00000000000000000000000000000000000000000000000000000000667d7a7a0000000000000000000000000000000000000000000000000000000000177f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000",
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );

        vm.startPrank(DEV_WALLET);

        // Time travel
        vm.warp(1719499200);

        // prepare bridgeData
        defaultUSDCAmount = 4.123123123123 ether;
        bridgeData.destinationChainId = 42161;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;
        bridgeData.receiver = DEV_WALLET;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        ILiFi.BridgeData memory eventBridgeData = bridgeData;
        eventBridgeData.minAmount = 4123123120000000000; // Adjusted for 8 decimals
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(eventBridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function test_CanSwapAndBridgeNativeTokensWithMoreThan8Decimals() public {
        defaultNativeAmount += 0.123456789 ether;
        testBase_CanSwapAndBridgeNativeTokens();
    }

    function test_CanBridgeNativeTokens() public {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialBalance = USER_SENDER.balance;

        // prepare bridgeData
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        validMayanDataNative = MayanFacet.MayanData(
            bytes32(
                0x0000000000000000000000000000000000000000000000000000000abc654321
            ),
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Calldata generated from Mayan SDK 1 ETH -> USDT on Polygon
            hex"1eb1cff00000000000000000000000000000000000000000000000000000000000013e0b0000000000000000000000000000000000000000000000000000000000004df200000000000000000000000000000000000000000000000000000000000a42dfcb617b639c537bd08846f61be4481c34f9391f1b8f53d082de024e232508113e00000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c390000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000006655d880000000000000000000000000000000000000000000000000000000006655d88000000000000000000000000000000000000000000000000000000000e16ffab40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000",
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            validMayanDataNative.nonEVMReceiver
        );

        // execute call in child contract
        initiateBridgeTxWithFacet(true);

        // check balances after call
        assertEq(USER_SENDER.balance, initialBalance - 1 ether);
    }

    function test_CanBridgeNativeTokensViaMayanSwapAndForwardEth() public {
        // End-to-end of the new native branch: swapProtocol != 0 routes the native input through
        // MAYAN.swapAndForwardEth (Mayan's implicit ETH->WETH conversion) instead of forwardEth.
        // Mayan's forwarder behavior is out of scope, so it is etched with a recorder to isolate
        // the facet's branch selection, receiver validation and argument pass-through.
        MockMayanSwapForwarder mock = new MockMayanSwapForwarder();
        vm.etch(address(MAYAN_FORWARDER), address(mock).code);

        // validMayanDataNative.protocolData (wrapAndSwapETH 0x1eb1cff0) parses to 0xabc654321 ==
        // USER_RECEIVER, so the EVM receiver check passes on the swap path.
        bridgeData.receiver = USER_RECEIVER;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        bridgeData.destinationChainId = 137;

        bytes memory swapCalldata = hex"c1c0e9c9";
        MayanFacet.MayanData memory data = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4,
            validMayanDataNative.protocolData,
            MAYAN_NATIVE_SWAP_PROTOCOL,
            swapCalldata,
            ARBITRUM_WETH,
            0.99 ether,
            USER_RECEIVER
        );

        vm.startPrank(USER_SENDER);
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);
        mayanBridgeFacet.startBridgeTokensViaMayan{ value: 1 ether }(
            bridgeData,
            data
        );
        vm.stopPrank();

        MockMayanSwapForwarder forwarder = MockMayanSwapForwarder(
            address(MAYAN_FORWARDER)
        );
        assertEq(
            forwarder.lastValue(),
            1 ether,
            "swapAndForwardEth must receive minAmount as native value"
        );
        assertEq(
            forwarder.lastAmountIn(),
            1 ether,
            "amountIn arg must equal minAmount"
        );
        assertEq(forwarder.lastSwapProtocol(), MAYAN_NATIVE_SWAP_PROTOCOL);
        assertEq(forwarder.lastMiddleToken(), ARBITRUM_WETH);
        assertEq(
            forwarder.lastMinMiddleAmount(),
            0.99 ether,
            "minMiddleAmount must be forwarded"
        );
        assertEq(forwarder.lastSwapData(), swapCalldata);
        assertEq(
            forwarder.lastMayanData(),
            validMayanDataNative.protocolData,
            "protocolData must be forwarded unchanged"
        );
    }

    function test_CanSwapAndBridgeNativeViaMayanSwapAndForwardEth() public {
        // Double-swap edge: a LI.FI source swap (USDC -> native ETH) feeds the new native
        // swapAndForwardEth branch (Mayan's implicit ETH->WETH). Asserts _replaceInputAmount stays
        // skipped for native (protocolData unchanged) and minMiddleAmount is respected.
        MockMayanSwapForwarder mock = new MockMayanSwapForwarder();
        vm.etch(address(MAYAN_FORWARDER), address(mock).code);

        vm.startPrank(USER_SENDER);
        uint256 initialUSDCBalance = usdc.balanceOf(USER_SENDER);

        bridgeData.receiver = USER_RECEIVER;
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);
        bridgeData.destinationChainId = 137;

        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 amountOut = defaultNativeAmount;
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        usdc.approve(_facetTestContractAddress, amountIn);

        bytes memory swapCalldata = hex"a1b2c3d4";
        MayanFacet.MayanData memory data = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4,
            validMayanDataNative.protocolData,
            MAYAN_NATIVE_SWAP_PROTOCOL,
            swapCalldata,
            ARBITRUM_WETH,
            0.5 ether,
            USER_RECEIVER
        );

        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        mayanBridgeFacet.swapAndStartBridgeTokensViaMayan(
            bridgeData,
            swapData,
            data
        );
        vm.stopPrank();

        MockMayanSwapForwarder forwarder = MockMayanSwapForwarder(
            address(MAYAN_FORWARDER)
        );
        // The exact-out source swap yields 1 ETH; normalization to 8 decimals leaves 1e18.
        assertEq(
            forwarder.lastAmountIn(),
            forwarder.lastValue(),
            "amountIn arg must equal forwarded native value"
        );
        assertEq(
            forwarder.lastValue(),
            1 ether,
            "normalized swap output must be forwarded as native value"
        );
        assertEq(
            forwarder.lastMinMiddleAmount(),
            0.5 ether,
            "minMiddleAmount must be respected"
        );
        assertEq(forwarder.lastMiddleToken(), ARBITRUM_WETH);
        // Native never runs _replaceInputAmount, so Mayan receives the original protocolData.
        assertEq(
            forwarder.lastMayanData(),
            validMayanDataNative.protocolData,
            "native path must not rewrite protocolData"
        );
        assertEq(usdc.balanceOf(USER_SENDER), initialUSDCBalance - amountIn);
    }

    function testRevert_SwapAndForwardEthReceiverMismatch() public {
        // Receiver validation guards the new path too: a protocolData whose parsed receiver differs
        // from bridgeData.receiver reverts before any forwarding, even with swapProtocol set.
        bridgeData.receiver = DEV_WALLET;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        bridgeData.destinationChainId = 137;

        MayanFacet.MayanData memory data = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4,
            validMayanDataNative.protocolData, // parses to USER_RECEIVER, not DEV_WALLET
            MAYAN_NATIVE_SWAP_PROTOCOL,
            "",
            ARBITRUM_WETH,
            0,
            USER_RECEIVER
        );

        vm.startPrank(USER_SENDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvalidReceiver.selector,
                DEV_WALLET,
                USER_RECEIVER
            )
        );
        mayanBridgeFacet.startBridgeTokensViaMayan{ value: 1 ether }(
            bridgeData,
            data
        );
        vm.stopPrank();
    }

    function testRevert_SwapAndForwardEthWithZeroMinMiddleAmount() public {
        // minMiddleAmount is the only slippage guard on the native ETH -> middleToken source swap.
        // At zero the swap is fully sandwichable (order created for dust), so the facet must reject
        // it before forwarding. Receiver validation passes first (parses to USER_RECEIVER), so this
        // isolates the minMiddleAmount guard on the swapAndForwardEth branch.
        bridgeData.receiver = USER_RECEIVER;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        bridgeData.destinationChainId = 137;

        MayanFacet.MayanData memory data = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4,
            validMayanDataNative.protocolData,
            MAYAN_NATIVE_SWAP_PROTOCOL,
            hex"c1c0e9c9",
            ARBITRUM_WETH,
            0,
            USER_RECEIVER
        );

        vm.startPrank(USER_SENDER);
        vm.expectRevert(InvalidAmount.selector);
        mayanBridgeFacet.startBridgeTokensViaMayan{ value: 1 ether }(
            bridgeData,
            data
        );
        vm.stopPrank();
    }

    function testRevert_StartBridgeWithZeroRefundRecipient() public {
        MayanFacet.MayanData memory data = validMayanData;
        data.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, type(uint256).max);

        vm.expectRevert(InvalidCallData.selector);
        mayanBridgeFacet.startBridgeTokensViaMayan(bridgeData, data);
        vm.stopPrank();
    }

    function testRevert_SwapAndStartBridgeWithZeroRefundRecipient() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, type(uint256).max);

        MayanFacet.MayanData memory data = validMayanData;
        data.refundRecipient = address(0);

        vm.expectRevert(InvalidCallData.selector);
        mayanBridgeFacet.swapAndStartBridgeTokensViaMayan(
            bridgeData,
            swapData,
            data
        );
        vm.stopPrank();
    }

    function testRevert_SwapOutputAssetDoesNotMatchSendingAsset() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        // Last swap outputs USDC; declaring DAI as the bridge sending asset is the mismatch.
        bridgeData.sendingAssetId = ADDRESS_DAI;
        dai.approve(_facetTestContractAddress, type(uint256).max);

        vm.expectRevert(InvalidSendingToken.selector);
        mayanBridgeFacet.swapAndStartBridgeTokensViaMayan(
            bridgeData,
            swapData,
            validMayanData
        );
        vm.stopPrank();
    }

    function test_RefundsExcessNativeToRefundRecipient() public {
        // The excess native value must be refunded to MayanData.refundRecipient (the user), not to
        // msg.sender (which may be a relayer). Mayan's forwarder is out of scope, so it is etched
        // with a recorder that keeps the forwarded value and leaves the excess in the facet.
        MockMayanSwapForwarder mock = new MockMayanSwapForwarder();
        vm.etch(address(MAYAN_FORWARDER), address(mock).code);

        address refundRecipient = address(0xD00D);

        // validMayanDataNative.protocolData parses to 0xabc654321 == USER_RECEIVER.
        bridgeData.receiver = USER_RECEIVER;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        bridgeData.destinationChainId = 137;

        MayanFacet.MayanData memory data = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4,
            validMayanDataNative.protocolData,
            MAYAN_NATIVE_SWAP_PROTOCOL,
            hex"c1c0e9c9",
            ARBITRUM_WETH,
            0.99 ether,
            refundRecipient
        );

        uint256 excess = 0.5 ether;
        uint256 refundRecipientBalanceBefore = refundRecipient.balance;

        vm.startPrank(USER_SENDER);
        mayanBridgeFacet.startBridgeTokensViaMayan{ value: 1 ether + excess }(
            bridgeData,
            data
        );
        vm.stopPrank();

        MockMayanSwapForwarder forwarder = MockMayanSwapForwarder(
            address(MAYAN_FORWARDER)
        );
        assertEq(
            forwarder.lastValue(),
            1 ether,
            "only minAmount must be forwarded to Mayan"
        );
        assertEq(
            refundRecipient.balance - refundRecipientBalanceBefore,
            excess,
            "excess native must be refunded to refundRecipient"
        );
    }

    function testRevert_FailsWhenNonEVMChainIntentionAndNonEVMReceiverIsEmpty()
        public
    {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, type(uint256).max);

        bridgeData.receiver = NON_EVM_ADDRESS; // nonEVMAddress

        vm.expectRevert(
            abi.encodeWithSelector(InvalidNonEVMReceiver.selector)
        );

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_FailsWhenBridgeDataReceiverDoesNotMatchMayanProtocolReceiver()
        public
    {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, type(uint256).max);

        bridgeData.receiver = DEV_WALLET;

        validMayanData = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Calldata generated from Mayan SDK 4.12312312 USDC on Mainnet -> Arbitrum
            hex"6222ad25000000000000000000000000000000000000000000000000000000000f52ae0e000000000000000000000000000000000000000000000000000000000000f2d000000000000000000000000000000000000000000000000000000000018eb30afc7fcf68097cd0584877939477347b5b8fa10efee2e29805370a35fd2a22ee9500000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c3900000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed700000000000000000000000000000000000000000000000000000000000000171e8c4fab8994494c8f1e5c1287445b2917d60c43c79aa959162f5d6000598d3200000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed7000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000000001700000000000000000000000000000000000000000000000000000000000001e00000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d000000000000000000000000000000000000000000000000393846a1e4cce00000000000000000000000000000000000000000000000000000000000667d7a7a00000000000000000000000000000000000000000000000000000000667d7a7a0000000000000000000000000000000000000000000000000000000000177f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000",
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );
        // invalid protocolData that produces wrong receiver for payload

        vm.expectRevert(
            abi.encodeWithSelector(
                InvalidReceiver.selector,
                DEV_WALLET,
                address(0)
            )
        );

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_WhenProtocolDataTooShort() public {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );
        bytes memory shortData = new bytes(50); // shorter than 68 bytes (50 bytes)
        uint256 newAmount = 1000;

        vm.expectRevert(abi.encodeWithSelector(ProtocolDataTooShort.selector));

        testFacet.testReplaceInputAmount(shortData, newAmount);
    }

    /// @dev Regression for the MayanSwap.swap (0x6111ad25) amount rewrite: amountIn sits at a
    ///      FIXED head offset (byte 452), so a non-empty customPayload in the tail must not shift
    ///      which word gets overwritten. Builds otherwise-identical calldata with an empty and a
    ///      non-empty payload and asserts only the amountIn word changes in both. The non-empty
    ///      case is sized so the previous `length - 256` offset would have landed on the sentinel
    ///      word (324) instead of amountIn, corrupting it.
    function test_ReplaceInputAmountRewritesMayanSwapAmountRegardlessOfPayload()
        public
    {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );
        uint256 newAmount = 999;

        bytes memory emptyPayload = _buildMayanSwapProtocolData(111, 0);
        bytes memory withPayload = _buildMayanSwapProtocolData(111, 96);

        bytes memory outEmpty = testFacet.testReplaceInputAmount(
            emptyPayload,
            newAmount
        );
        bytes memory outWithPayload = testFacet.testReplaceInputAmount(
            withPayload,
            newAmount
        );

        assertEq(outEmpty.length, emptyPayload.length);
        assertEq(outWithPayload.length, withPayload.length);
        assertEq(_readWordAt(outEmpty, 452), newAmount);
        assertEq(_readWordAt(outWithPayload, 452), newAmount);
        assertEq(_readWordAt(outEmpty, 324), 0xDEAD);
        assertEq(_readWordAt(outWithPayload, 324), 0xDEAD);
    }

    /// @dev Builds MayanSwap.swap-shaped calldata: selector + 14 head words + amountIn word, then
    ///      `payloadLen` tail bytes. Word 10 (byte 324) holds a sentinel so tests can prove
    ///      non-amount bytes survive the rewrite.
    function _buildMayanSwapProtocolData(
        uint256 amountIn,
        uint256 payloadLen
    ) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            bytes4(0x6111ad25),
            new bytes(320), // words 0..9  -> bytes [4,324)
            uint256(0xDEAD), // word 10 sentinel -> bytes [324,356)
            new bytes(96), // words 11..13 -> bytes [356,452)
            amountIn // word 14 amountIn -> bytes [452,484)
        );

        return abi.encodePacked(head, new bytes(payloadLen));
    }

    /// @dev Reads the 32-byte word at `byteOffset` within a bytes buffer.
    function _readWordAt(
        bytes memory data,
        uint256 byteOffset
    ) internal pure returns (uint256 word) {
        assembly {
            word := mload(add(add(data, 0x20), byteOffset))
        }
    }

    // The HyperCore receiver-parsing coverage is split across the tests below. It was originally
    // one function, but under the legacy codegen pipeline (solc 0.8.17 / london, used for
    // London-EVM production deploys) the combined locals plus the Swift v2 ABI encoder overflowed
    // the stack ("Stack too deep"). Per-scenario tests keep each frame small, and the shared
    // order/encoding helpers below keep the 7-argument encoder out of the test frame (EXSC-577).

    function test_ParseHypercoreReceiverFromCreateOrderWithToken() public {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        // Real on-chain HyperCore deposit on Base (createOrderWithToken 0xa3a30834,
        // payloadType 2). destAddr is Mayan's HCDepositor handler; the real receiver is
        // customPayload[0:20]. Source tx:
        // 0x7077760ccec417b7057267465e933f163545c82ce5808798c17be068860eeb29
        bytes memory protocolData = vm.parseBytes(
            "0xa3a30834000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000004c1a6c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000d01e6a41e4de4032830c99aa79c0206753de628a00000000000000000000000056032241c0adab58a29b13e94fb595a4bc414e33000000000000000000000000000000000000000000000000000000000000002f000000000000000000000000a5aa6e2171b416e1d27ec53ca8c13db3f91a89cd000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f00000000000000000000000000000000000000000000000000000000004479bf0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001250a000000000000000000000000000000000000000000000000000000000000d107000000000000000000000000000000000000000000000000000000006a1ec3f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022d72eef3486e6427a1820fced5ec5ea59bdc4f4efd88f471e3660fec52cfd7de00000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000020d01e6a41e4de4032830c99aa79c0206753de628a00000000000000000007a120"
        );

        bytes32 receiver = testFacet.testParseHypercoreReceiver(protocolData);

        assertEq(
            address(uint160(uint256(receiver))),
            HYPERCORE_RECEIVER,
            "parse hypercore receiver: createOrderWithToken customPayload[0:20]"
        );

        // Exercises _parseReceiver's early return: routed via the HyperCore chain id, a genuine
        // deposit returns the customPayload receiver (the `if (receiver != 0) return` branch)
        // rather than falling through to the destAddr handler.
        assertEq(
            address(
                uint160(
                    uint256(
                        testFacet.testParseReceiverForChain(protocolData, 1337)
                    )
                )
            ),
            HYPERCORE_RECEIVER,
            "_parseReceiver returns customPayload receiver for genuine hypercore deposit"
        );
    }

    function test_ParseHypercoreReceiverFromCreateOrderWithSig() public {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        // createOrderWithSig (0x6147435b) carries the same OrderParams + customPayload layout
        bytes memory protocolData = _encodeHypercoreOrderWithSig(
            _hypercoreOrderToHandler(HYPERCORE_RECEIVER),
            _hypercoreCustomPayload(HYPERCORE_RECEIVER)
        );

        bytes32 receiver = testFacet.testParseHypercoreReceiver(protocolData);

        assertEq(
            address(uint160(uint256(receiver))),
            HYPERCORE_RECEIVER,
            "parse hypercore receiver: createOrderWithSig customPayload[0:20]"
        );
    }

    function test_ParseHypercoreReceiverReturnsZeroWhenGatesFail() public {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        bytes memory customPayload = _hypercoreCustomPayload(
            HYPERCORE_RECEIVER
        );

        // Unknown / non-Swift selector (bridgeWithFee 0x94454a5d) -> zero receiver, so the
        // caller's bridgeData.receiver == receiver check reverts.
        assertEq(
            testFacet.testParseHypercoreReceiver(
                vm.parseBytes(
                    "0x94454a5d000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
                )
            ),
            bytes32(0),
            "non-Swift selector must yield zero receiver"
        );

        // A Swift v2 order whose destAddr is NOT Mayan's HCDepositor handler must yield zero, so
        // the caller's receiver check reverts rather than trusting an attacker-controlled
        // customPayload routed to a fake handler.
        ISwiftV2Encode.OrderParams memory order = _hypercoreOrderToHandler(
            HYPERCORE_RECEIVER
        );
        order.destAddr = bytes32(uint256(uint160(address(0xdEAD))));

        assertEq(
            testFacet.testParseHypercoreReceiver(
                _encodeHypercoreOrderWithSig(order, customPayload)
            ),
            bytes32(0),
            "non-HCDepositor destAddr must yield zero receiver"
        );

        // A Swift v2 order to the genuine handler but with a non-HyperCore payloadType (!= 2) must
        // yield zero, so the caller's receiver check reverts rather than trusting customPayload for
        // an order type the HCDepositor would not treat as a deposit.
        order = _hypercoreOrderToHandler(HYPERCORE_RECEIVER);
        order.payloadType = 1;

        assertEq(
            testFacet.testParseHypercoreReceiver(
                _encodeHypercoreOrderWithSig(order, customPayload)
            ),
            bytes32(0),
            "non-deposit payloadType must yield zero receiver"
        );

        // A Swift v2 order to the genuine handler with payloadType 2 but a non-HyperEVM destChainId
        // (!= 47) must yield zero, so it falls through to standard destAddr validation rather than
        // trusting customPayload for an order not bound for the HyperCore handler chain.
        order = _hypercoreOrderToHandler(HYPERCORE_RECEIVER);
        order.destChainId = 1;

        assertEq(
            testFacet.testParseHypercoreReceiver(
                _encodeHypercoreOrderWithSig(order, customPayload)
            ),
            bytes32(0),
            "non-HyperEVM destChainId must yield zero receiver"
        );
    }

    function test_ParseHypercoreReceiverReturnsZeroWhenPayloadTruncated()
        public
    {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        // A genuine handler order whose customPayload declares fewer than 20 bytes cannot hold
        // the receiver. The bounds check must yield zero rather than a padded partial read that
        // could be crafted to match _bridgeData.receiver.
        ISwiftV2Encode.OrderParams memory order = _hypercoreOrderToHandler(
            HYPERCORE_RECEIVER
        );
        bytes memory shortPayload = abi.encodePacked(
            bytes10(bytes20(uint160(HYPERCORE_RECEIVER)))
        );

        assertEq(
            testFacet.testParseHypercoreReceiver(
                _encodeHypercoreOrderWithSig(order, shortPayload)
            ),
            bytes32(0),
            "truncated customPayload (<20 bytes) must yield zero receiver"
        );
    }

    function test_ParseReceiverFallsThroughToDestAddrForNonDepositOrder()
        public
    {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        // A Swift v2 order under the HyperCore chain id but to a real user destAddr with a
        // non-deposit payloadType is treated as an ordinary order: _parseHypercoreReceiver yields
        // 0 (gates fail) and _parseReceiver falls through to standard destAddr parsing, so the
        // user's destAddr is what gets validated against bridgeData.receiver.
        // destAddr and customPayload carry distinct receivers so the assertion proves the fall-
        // through returned destAddr, not the customPayload that a still-firing HyperCore path
        // would surface.
        address destReceiver = HYPERCORE_RECEIVER;
        address payloadReceiver = address(0xBEEF);

        ISwiftV2Encode.OrderParams memory order = _hypercoreOrderToHandler(
            destReceiver
        );
        order.destAddr = bytes32(uint256(uint160(destReceiver)));
        order.payloadType = 1;
        order.destChainId = 1;

        bytes memory protocolData = _encodeHypercoreOrderWithSig(
            order,
            _hypercoreCustomPayload(payloadReceiver)
        );

        assertEq(
            address(
                uint160(
                    uint256(
                        testFacet.testParseReceiverForChain(protocolData, 1337)
                    )
                )
            ),
            destReceiver,
            "non-deposit order under hypercore chainId falls through to destAddr validation"
        );
    }

    function test_ParseHypercoreReceiverFollowsCustomPayloadOffsetPointer()
        public
    {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        // Non-canonical encoding: customPayload placed one word later than canonical, with the
        // head word 16 offset pointer updated to match. A fixed-offset parser would read the
        // wrong word; following the pointer locates the receiver Mayan actually decodes. destAddr
        // (head word 4) and destChainId (head word 5) are set so the gate passes.
        bytes32 receiver = testFacet.testParseHypercoreReceiver(
            _buildNonCanonicalHypercoreOrder(HYPERCORE_RECEIVER)
        );

        assertEq(
            address(uint160(uint256(receiver))),
            HYPERCORE_RECEIVER,
            "parse hypercore receiver: follows customPayload offset pointer"
        );
    }

    function test_ParseReceiverParsesHcDepositInitiatorUnderHypercoreChainId()
        public
    {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        // Regression: an HCDepositInitiator deposit under the HyperCore chain id (1337) must
        // still parse via its fixed-offset switch case, not be shadowed by the Swift v2 path.
        bytes memory hcDeposit = vm.parseBytes(
            "0xe27dce37000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000006acfc00000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c00000000000000000000000000000000000000000000000000000000000001f400000000000000000000000000000000000000000000000000000000006acfc00000000000000000000000000000000000000000000000000000000000012caf000000000000000000000000bd55c2f306c97fd1d3e7a023f7c4834a2f472834000000000000000000000000000000000000000000000000000000000069a3110000000000000000000000000000000000000000000000000000000068a7068ee2d54d29d37687633ac8ad2fc0514a5ee922480ebf7f24c509fb2cf2f00dbe341c22259dd180dda20abd2a4c9cbd8e13900cb34642fdedd1458a953d17c74d0c000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000"
        );

        assertEq(
            address(
                uint160(
                    uint256(
                        testFacet.testParseReceiverForChain(hcDeposit, 1337)
                    )
                )
            ),
            0xBD55C2F306C97Fd1d3E7A023f7c4834a2F472834,
            "HCDepositInitiator under hypercore chainId must fall through to fixed-offset parsing"
        );
    }

    /// @dev A canonical Swift v2 order to Mayan's HCDepositor handler (payloadType 2,
    ///      destChainId 47 = HyperEVM) — the shape that makes _parseHypercoreReceiver trust
    ///      customPayload[0:20]. Gate tests start from this and flip one field.
    function _hypercoreOrderToHandler(
        address trader
    ) private pure returns (ISwiftV2Encode.OrderParams memory order) {
        order = ISwiftV2Encode.OrderParams({
            payloadType: 2,
            trader: bytes32(uint256(uint160(trader))),
            destAddr: bytes32(
                uint256(uint160(0x56032241C0AdAb58A29b13E94fb595a4bc414e33))
            ),
            destChainId: 47,
            referrerAddr: bytes32(0),
            tokenOut: bytes32(0),
            minAmountOut: 0,
            gasDrop: 0,
            cancelFee: 0,
            refundFee: 0,
            deadline: 0,
            referrerBps: 0,
            auctionMode: 0,
            random: bytes32(0)
        });
    }

    /// @dev customPayload whose first 20 bytes are the HyperCore receiver Mayan decodes.
    function _hypercoreCustomPayload(
        address receiver
    ) private pure returns (bytes memory) {
        return abi.encodePacked(receiver, uint32(0), uint64(500000));
    }

    /// @dev Encodes a Swift v2 createOrderWithSig call. Kept in its own frame so the 7-argument
    ///      ABI encoder (incl. the OrderParams tuple) doesn't push the calling test's stack past
    ///      the solc 0.8.17 limit.
    function _encodeHypercoreOrderWithSig(
        ISwiftV2Encode.OrderParams memory order,
        bytes memory customPayload
    ) private pure returns (bytes memory) {
        ISwiftV2Encode.PermitParams memory permit;

        return
            abi.encodeCall(
                ISwiftV2Encode.createOrderWithSig,
                (
                    0xaf88d065e77c8cC2239327C5EDb3A432268e5831,
                    1e6,
                    order,
                    customPayload,
                    0,
                    bytes(""),
                    permit
                )
            );
    }

    /// @dev Builds a createOrderWithToken order whose customPayload sits one word later than the
    ///      canonical position, with the head word 16 offset pointer updated to match. Extracted
    ///      to its own function to keep the offset-pointer test under the stack limit.
    function _buildNonCanonicalHypercoreOrder(
        address expectedReceiver
    ) private pure returns (bytes memory) {
        // Built in two halves: materializing the head to memory frees its stack slots so the
        // byte-by-byte encodePacked doesn't exceed the solc 0.8.17 stack limit once inlined.
        bytes memory head = abi.encodePacked(
            bytes4(0xa3a30834),
            new bytes(2 * 32), // head words 0..1 (tokenIn, amountIn) filler
            uint256(2), // word 2: payloadType = 2
            new bytes(32), // word 3: trader filler
            bytes32(
                uint256(uint160(0x56032241C0AdAb58A29b13E94fb595a4bc414e33))
            ), // word 4: destAddr = handler
            uint256(47) // word 5: destChainId = HyperEVM
        );

        return
            abi.encodePacked(
                head,
                new bytes(10 * 32), // head words 6..15 filler
                uint256(0x240), // word 16: customPayload offset (canonical would be 0x220)
                new bytes(32), // extra padding word before customPayload
                uint256(32), // customPayload length
                expectedReceiver,
                uint32(0),
                uint64(0)
            );
    }

    function test_CanBridgeTokensToHyperCore() public {
        // End-to-end of the bug path: the full startBridgeTokensViaMayan -> _startBridge flow for a
        // HyperCore deposit (destinationChainId == 1337) where bridgeData.receiver is the
        // customPayload[0:20] receiver. Before the fix the receiver was validated against destAddr
        // (the HCDepositor handler), so this reverted with InvalidReceiver. Mayan's forwarder
        // behavior is out of scope, so forwardERC20 is stubbed to isolate the facet's validation.
        bridgeData.receiver = HYPERCORE_RECEIVER;
        bridgeData.destinationChainId = 1337;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        MayanFacet.MayanData memory hyperCoreData = MayanFacet.MayanData(
            "",
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C,
            _hyperCoreProtocolData(),
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );

        vm.mockCall(
            address(MAYAN_FORWARDER),
            abi.encodeWithSelector(IMayan.forwardERC20.selector),
            ""
        );

        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, type(uint256).max);

        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        mayanBridgeFacet.startBridgeTokensViaMayan(bridgeData, hyperCoreData);

        vm.stopPrank();
    }

    function testRevert_HyperCoreReceiverDoesNotMatchCustomPayload() public {
        // Same HyperCore flow, but bridgeData.receiver != customPayload[0:20]; the full _startBridge
        // must revert before forwarding, proving the customPayload receiver is enforced end-to-end.
        address wrongReceiver = address(0xBEEF);

        bridgeData.receiver = wrongReceiver;
        bridgeData.destinationChainId = 1337;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        MayanFacet.MayanData memory hyperCoreData = MayanFacet.MayanData(
            "",
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C,
            _hyperCoreProtocolData(),
            address(0),
            "",
            address(0),
            0,
            USER_RECEIVER
        );

        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                InvalidReceiver.selector,
                wrongReceiver,
                HYPERCORE_RECEIVER
            )
        );

        mayanBridgeFacet.startBridgeTokensViaMayan(bridgeData, hyperCoreData);

        vm.stopPrank();
    }

    /// @dev Real on-chain HyperCore deposit calldata (createOrderWithToken 0xa3a30834,
    ///      payloadType 2, destChainId 47): destAddr is Mayan's HCDepositor handler and the real
    ///      receiver is customPayload[0:20] (HYPERCORE_RECEIVER). Source tx:
    ///      0x7077760ccec417b7057267465e933f163545c82ce5808798c17be068860eeb29
    function _hyperCoreProtocolData() private pure returns (bytes memory) {
        return
            vm.parseBytes(
                "0xa3a30834000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000004c1a6c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000d01e6a41e4de4032830c99aa79c0206753de628a00000000000000000000000056032241c0adab58a29b13e94fb595a4bc414e33000000000000000000000000000000000000000000000000000000000000002f000000000000000000000000a5aa6e2171b416e1d27ec53ca8c13db3f91a89cd000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f00000000000000000000000000000000000000000000000000000000004479bf0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001250a000000000000000000000000000000000000000000000000000000000000d107000000000000000000000000000000000000000000000000000000006a1ec3f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022d72eef3486e6427a1820fced5ec5ea59bdc4f4efd88f471e3660fec52cfd7de00000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000020d01e6a41e4de4032830c99aa79c0206753de628a00000000000000000007a120"
            );
    }

    function test_ParseReceiver() public {
        TestMayanFacetExposed testFacet = new TestMayanFacetExposed(
            IMayan(MAYAN_FORWARDER)
        );

        address expectedReceiver = 0x1eB6638dE8c571c787D7bC24F98bFA735425731C;
        // test for 0x94454a5d bridgeWithFee(address,uint256,uint64,uint64,[*bytes32*],(uint32,bytes32,bytes32))
        // not used in swap sdk anymore look at bridgeWithFee with 0x2072197f
        bytes memory protocolData = vm.parseBytes(
            "0x94454a5d000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
        bytes32 receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for bridgeWithFee"
        );

        // test for 0x32ad465f bridgeWithLockedFee(address,uint256,uint64,uint256,(uint32,bytes32 (receiver address),bytes32))
        // not used in swap sdk anymore look at bridgeWithLockedFee with 0x9be95bb4
        protocolData = vm.parseBytes(
            "0x32ad465f000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c0000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for bridgeWithLockedFee"
        );
        // test for 0xafd9b706 createOrder((address,uint256,uint64,bytes32 (receiver address),uint16,bytes32,uint64,uint64,uint64,bytes32,uint8),(uint32,bytes32,bytes32))
        // not used in swap sdk anymore look at createOrder with 0x1c59b7fc
        expectedReceiver = 0x1eB6638dE8c571c787D7bC24F98bFA735425731C;
        protocolData = vm.parseBytes(
            "0xafd9b706000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for createOrder"
        );
        // test for 0x6111ad25 swap((uint64,uint64,uint64),(bytes32,uint16,bytes32,[*bytes32*],uint16,bytes32,bytes32),bytes32,uint16,(uint256,uint64,uint64,bool,uint64,bytes),address,uint256)
        // generated with demo script
        expectedReceiver = 0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62;
        protocolData = vm.parseBytes(
            "0x6111ad25000000000000000000000000000000000000000000000000000000000001de1d00000000000000000000000000000000000000000000000000000000000012eb00000000000000000000000000000000000000000000000000000000000007022b1771acd9079d027f4a54e5a1bf21747275501b846a7973ccaa40e6375fc92f00000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c390000000000000000000000002b2c52b1b63c4bfc7f1a310a1734641d8e34de62000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b2c52b1b63c4bfc7f1a310a1734641d8e34de62000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001e000000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab10000000000000000000000000000000000000000000000000004fa6948660c000000000000000000000000000000000000000000000000000000000067d9762e0000000000000000000000000000000000000000000000000000000067d9762e000000000000000000000000000000000000000000000000000000000004ed0c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for swap"
        );
        // test for 0x1eb1cff0 wrapAndSwapETH((uint64,uint64,uint64),(bytes32,uint16,bytes32,[*bytes32*],uint16,bytes32,bytes32),bytes32,uint16,(uint256,uint64,uint64,bool,uint64,bytes))
        // generated with demo script
        protocolData = vm.parseBytes(
            "0x1eb1cff0000000000000000000000000000000000000000000000000000000000001dccd00000000000000000000000000000000000000000000000000000000000012f100000000000000000000000000000000000000000000000000000000000007302b1771acd9079d027f4a54e5a1bf21747275501b846a7973ccaa40e6375fc92f00000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c390000000000000000000000002b2c52b1b63c4bfc7f1a310a1734641d8e34de62000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b2c52b1b63c4bfc7f1a310a1734641d8e34de62000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000067d97ce20000000000000000000000000000000000000000000000000000000067d97ce200000000000000000000000000000000000000000000000000000000000506910000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0x1eb1cff0 wrapAndSwapETH((uint64,uint64,uint64),(bytes32,uint16,bytes32,[*bytes32*],uint16,bytes32,bytes32),bytes32,uint16,(uint256,uint64,uint64,bool,uint64,bytes)"
        );
        // test for 0xb866e173 createOrderWithEth((bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,[*bytes32*],uint16,bytes32,uint8,uint8,bytes32))
        expectedReceiver = 0x1eB6638dE8c571c787D7bC24F98bFA735425731C;
        protocolData = vm.parseBytes(
            "0xb866e173000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );

        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for createOrderWithEth"
        );
        // test for 0x8e8d142b createOrderWithToken(address,uint256,(bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,[*bytes32*],uint16,bytes32,uint8,uint8,bytes32))
        expectedReceiver = 0x1eB6638dE8c571c787D7bC24F98bFA735425731C;
        protocolData = vm.parseBytes(
            "0x8e8d142b000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b400000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );

        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for createOrderWithToken"
        );

        // Swift v2 shared OrderParams (destAddr at calldata 0x84 for both selectors)
        ISwiftV2Encode.OrderParams memory swiftV2Order = ISwiftV2Encode
            .OrderParams({
                payloadType: 1,
                trader: bytes32(
                    uint256(
                        uint160(0xaf88d065e77c8cC2239327C5EDb3A432268e5831)
                    )
                ),
                destAddr: bytes32(uint256(uint160(expectedReceiver))),
                destChainId: 1,
                referrerAddr: bytes32(0),
                tokenOut: bytes32(0),
                minAmountOut: 0,
                gasDrop: 0,
                cancelFee: 0,
                refundFee: 0,
                deadline: 0,
                referrerBps: 0,
                auctionMode: 0,
                random: bytes32(0)
            });

        // test for 0xa3a30834 Swift v2 createOrderWithToken (abi.encodeCall)
        protocolData = abi.encodeCall(
            ISwiftV2Encode.createOrderWithToken,
            (
                address(0xaf88d065e77c8cC2239327C5EDb3A432268e5831),
                uint256(0x4c4b40),
                swiftV2Order,
                bytes("")
            )
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for Swift v2 createOrderWithToken (encodeCall)"
        );

        // test for 0xa3a30834 Swift v2 createOrderWithToken (backend/SDK calldata sample, full tail)
        protocolData = vm.parseBytes(
            "0xa3a30834000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000001e84800000000000000000000000000000000000000000000000000000000000000001000000000000000000000000b2ec0ec355243846fccb716f35796a3330c64e551ccbd4fdcd76cd2e3ba8d05205c012ecd28743f14359a7151b64da60a1679ece0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000a5aa6e2171b416e1d27ec53ca8c13db3f91a89cdce010e60afedb22717bd63192f54145a3f965a33bb82d2c7029eb2ce1e20826400000000000000000000000000000000000000000000000000000000001e0d22000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000025e700000000000000000000000000000000000000000000000000000000000027460000000000000000000000000000000000000000000000000000000069bbf77900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a347d8417de9cc392e0ff115d03e2f444aba6c92bb6e29e1ec9fd4def237a0bd00000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            receiver,
            hex"1ccbd4fdcd76cd2e3ba8d05205c012ecd28743f14359a7151b64da60a1679ece", // [pre-commit-checker: not a secret]
            "parse receiver: Swift v2 backend sample destAddr (bytes32)"
        );
        bytes32 wordAt0xc4;
        assembly {
            let p := add(protocolData, 0x20)
            wordAt0xc4 := mload(add(p, 0xc4))
        }

        assertEq(
            address(uint160(uint256(wordAt0xc4))),
            0xA5aa6E2171b416E1D27ec53Ca8C13DB3F91A89CD,
            "referrerAddr word at 0xc4 (OrderParams field order)"
        );

        // test for 0x6147435b Swift v2 createOrderWithSig (abi.encodeCall; on-chain bytes often nested in forwardERC20)
        ISwiftV2Encode.PermitParams memory permit = ISwiftV2Encode
            .PermitParams({
                value: 0,
                deadline: 0,
                v: 0,
                r: bytes32(0),
                s: bytes32(0)
            });
        protocolData = abi.encodeCall(
            ISwiftV2Encode.createOrderWithSig,
            (
                address(0xaf88d065e77c8cC2239327C5EDb3A432268e5831),
                uint256(0x4c4b40),
                swiftV2Order,
                bytes(""),
                uint256(0),
                bytes(""),
                permit
            )
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for Swift v2 createOrderWithSig"
        );

        // test for 0x1c59b7fc MayanCircle::createOrder((address,uint256,uint64,bytes32,uint16,bytes32,uint64,uint64,uint64,bytes32,uint8))
        // example tenderly: https://dashboard.tenderly.co/tx/arbitrum/0x3bffa9aa20062cd21e0f4d40333214ce23e382d308180fc20ddd6c405bff2649/debugger?trace=0.3.0
        // tested directly from the backend
        expectedReceiver = 0x1eB6638dE8c571c787D7bC24F98bFA735425731C;
        protocolData = vm.parseBytes(
            "0x1c59b7fc000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000023e290000000000000000000000000000000000000000000000000000000067c1b1f500000000000000000000000000000000000000000000000000000000001c497b000000000000000000000000a5aa6e2171b416e1d27ec53ca8c13db3f91a89cd0000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0x1c59b7fc MayanCircle::createOrder((address,uint256,uint64,bytes32,uint16,bytes32,uint64,uint64,uint64,bytes32,uint8))"
        );

        // test for 0x9be95bb4 MayanCircle::bridgeWithLockedFee(address,uint256,uint64,uint256,uint32,bytes32)
        // example tenderly: https://dashboard.tenderly.co/tx/arbitrum/0x8ad553f8059efcb7fd84130e5625e4b2fdc3ea34461227e1e4a983053e12790c/debugger?trace=0.3
        // tested directly from the backend
        protocolData = vm.parseBytes(
            "0x9be95bb4000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000df8e600000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0x9be95bb4 MayanCircle::bridgeWithLockedFee(address,uint256,uint64,uint256,uint32,bytes32)"
        );

        // test for 0x2072197f MayanCircle::bridgeWithFee(address,uint256,uint64,uint64,bytes32,uint32,uint8,bytes)
        // example tenderly: https://dashboard.tenderly.co/tx/arbitrum/0xa12ac33dcc79c4185a484095764772f8169fee8228c614892843e2f8df685a98/debugger?trace=0
        // tested directly from the backend
        protocolData = vm.parseBytes(
            "0x2072197f000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000004c4b400000000000000000000000000000000000000000000000000000000000000b4400000000000000000000000000000000000000000000000000000000000000000000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c0000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0x2072197f MayanCircle::bridgeWithFee(address,uint256,uint64,uint64,bytes32,uint32,uint8,bytes)"
        );

        // test for 0xf58b6de8 bridge(address,uint256,uint64,uint256,uint64,[*bytes32*],uint32,bytes32,uint8,uint8,uint32,bytes)
        expectedReceiver = 0x28A328C327307ab1b180327234fDD2a290EFC6DE;
        protocolData = vm.parseBytes(
            "0xf58b6de8000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000001e84800000000000000000000000000000000000000000000000000000000000001a8100000000000000000000000000000000000000000000000000000000000000dc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028a328c327307ab1b180327234fdd2a290efc6de0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0xf58b6de8 bridge"
        );

        // test for 0x2337e236 createOrder(address,uint256,uint256,uint32,uint32,(bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,[*bytes32*],uint16,bytes32,uint8,uint8,bytes32))
        expectedReceiver = 0x28A328C327307ab1b180327234fDD2a290EFC6DE;
        protocolData = vm.parseBytes(
            "0x2337e236000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000071afd498d000000000000000000000000000000000000000000000000000000000000000001c800000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000028a328c327307ab1b180327234fdd2a290efc6de0000000000000000000000009702230a8ea53601f5cd2dc00fdbc13d4df4a8c700000000000000000000000000000000000000000000000000000000003e9022000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000055c900000000000000000000000000000000000000000000000000000000000018800000000000000000000000000000000000000000000000000000000067e2ae7d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0x2337e236 createOrder"
        );
        // test for 0xe27dce37 HCDepositInitiator::deposit(address,uint256,[*address*],uint64,uint256,uint256,(uint64, tuple))
        expectedReceiver = 0xBD55C2F306C97Fd1d3E7A023f7c4834a2F472834;
        protocolData = vm.parseBytes(
            "0xe27dce37000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000006acfc00000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c00000000000000000000000000000000000000000000000000000000000001f400000000000000000000000000000000000000000000000000000000006acfc00000000000000000000000000000000000000000000000000000000000012caf000000000000000000000000bd55c2f306c97fd1d3e7a023f7c4834a2f472834000000000000000000000000000000000000000000000000000000000069a3110000000000000000000000000000000000000000000000000000000068a7068ee2d54d29d37687633ac8ad2fc0514a5ee922480ebf7f24c509fb2cf2f00dbe341c22259dd180dda20abd2a4c9cbd8e13900cb34642fdedd1458a953d17c74d0c000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0xe27dce37 deposit"
        );
        // test for 0x4d1ed73b HCDepositInitiator::fastDeposit(address,uint256,[*address*],uint256,uint64,bytes32,uint8, uint32, uint256,(uint64, tuple))
        expectedReceiver = 0xBD55C2F306C97Fd1d3E7A023f7c4834a2F472834;
        protocolData = vm.parseBytes(
            "0x4d1ed73b000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000006acfc00000000000000000000000001eb6638de8c571c787d7bc24f98bfa735425731c000000000000000000000000000000000000000000000000000000000000030200000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000a5aa6e2171b416e1d27ec53ca8c13db3f91a89cd0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000006acfc0000000000000000000000000000000000000000000000000000000000000c7c2000000000000000000000000bd55c2f306c97fd1d3e7a023f7c4834a2f47283400000000000000000000000000000000000000000000000000000000006a04fc0000000000000000000000000000000000000000000000000000000068a700c15e7ee816c6a4ceb97bfac888543a9374ff2d81bf8e6a4fc3cd161eb4c5cf7caa501224a126e1607b6946cc79fd846fd640ff52af75b3ded947f5ff6a57c3f391000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000"
        );
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(
            address(uint160(uint256(receiver))),
            expectedReceiver,
            "parse receiver test failure for 0x4d1ed73b deposit"
        );

        // not matching any selector (default case) - return zero address
        protocolData = vm.parseBytes("0x99999999");
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(address(uint160(uint256(receiver))), address(0));
    }
}
