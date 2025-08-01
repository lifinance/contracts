// solhint-disable max-line-length
// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";
import { IMayan } from "lifi/Interfaces/IMayan.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { InvalidConfig, InvalidNonEVMReceiver } from "src/Errors/GenericErrors.sol";

// Stub MayanFacet Contract
contract TestMayanFacet is MayanFacet {
    constructor(IMayan _bridge) MayanFacet(_bridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

/// @notice This contract exposes _parseReceiver and _replaceInputAmount for testing purposes.
contract TestMayanFacetExposed is MayanFacet {
    constructor(IMayan _mayan) MayanFacet(_mayan) {}

    /// @dev Exposes the internal _parseReceiver function.
    function testParseReceiver(
        bytes memory protocolData
    ) public pure returns (bytes32) {
        return _parseReceiver(protocolData);
    }

    /// @dev Exposes the internal _replaceInputAmount function.
    function testReplaceInputAmount(
        bytes memory protocolData,
        uint256 inputAmount
    ) public pure returns (bytes memory) {
        return _replaceInputAmount(protocolData, inputAmount);
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
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    bytes32 internal constant ACTUAL_SOL_ADDR =
        hex"4cb7c5f1632114c376c0e7a9a1fd1fbd562699fbd9a0c9f4f26ba8cf6e23df0d"; // [pre-commit-checker: not a secret]
    bytes32 internal constant EXPECTED_SOL_ADDR = bytes32("EXPECTED ADDRESS");

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
            hex"afd9b706000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc6543210000000000000000000000000000000000000000000000000000000000000005000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f0000000000000000000000000000000000000000000000000000000005aa76a8000000000000000000000000000000000000000000000000000000006655d64300000000000000000000000000000000000000000000000000000000001ff535000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c000000000000000000000000f18f923480dc144326e6c65d4f3d47aa459bb41c"
        );

        validMayanDataNative = MayanFacet.MayanData(
            "",
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Calldata generated from Mayan SDK 1 ETH -> USDT on Polygon
            hex"1eb1cff00000000000000000000000000000000000000000000000000000000000013e0b0000000000000000000000000000000000000000000000000000000000004df200000000000000000000000000000000000000000000000000000000000a42dfcb617b639c537bd08846f61be4481c34f9391f1b8f53d082de024e232508113e00000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c390000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000006655d880000000000000000000000000000000000000000000000000000000006655d88000000000000000000000000000000000000000000000000000000000e16ffab40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
        );

        invalidMayanDataEVM2Solana = MayanFacet.MayanData(
            EXPECTED_SOL_ADDR,
            0xBF5f3f65102aE745A48BD521d10BaB5BF02A9eF4, // mayanProtocol address
            // Send tokens to Solana
            hex"6111ad2500000000000000000000000000000000000000000000000000000000002fa3e500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010883f01f2183c5bf05d6756bf0b0aade846ff42b2bc9afe11e60e677d80270a38b3500000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c394cb7c5f1632114c376c0e7a9a1fd1fbd562699fbd9a0c9f4f26ba8cf6e23df0d0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed7c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000665e43ef00000000000000000000000000000000000000000000000000000000665e43ef00000000000000000000000000000000000000000000000000000000006869570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
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
        functionSelectors[2] = mayanBridgeFacet.addDex.selector;
        functionSelectors[3] = mayanBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(mayanBridgeFacet), functionSelectors);
        mayanBridgeFacet = TestMayanFacet(address(diamond));
        mayanBridgeFacet.addDex(ADDRESS_UNISWAP);
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
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
            hex"6111ad25000000000000000000000000000000000000000000000000000000000f52ae0e000000000000000000000000000000000000000000000000000000000000f2d000000000000000000000000000000000000000000000000000000000018eb30afc7fcf68097cd0584877939477347b5b8fa10efee2e29805370a35fd2a22ee9500000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c3900000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed700000000000000000000000000000000000000000000000000000000000000171e8c4fab8994494c8f1e5c1287445b2917d60c43c79aa959162f5d6000598d3200000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed7000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000000001700000000000000000000000000000000000000000000000000000000000001e00000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d000000000000000000000000000000000000000000000000393846a1e4cce00000000000000000000000000000000000000000000000000000000000667d7a7a00000000000000000000000000000000000000000000000000000000667d7a7a0000000000000000000000000000000000000000000000000000000000177f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
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
            hex"1eb1cff00000000000000000000000000000000000000000000000000000000000013e0b0000000000000000000000000000000000000000000000000000000000004df200000000000000000000000000000000000000000000000000000000000a42dfcb617b639c537bd08846f61be4481c34f9391f1b8f53d082de024e232508113e00000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c390000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abC654321000000000000000000000000c2132d05d31c914a87c6611c10748aeb04b58e8f000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000006655d880000000000000000000000000000000000000000000000000000000006655d88000000000000000000000000000000000000000000000000000000000e16ffab40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
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
            hex"6222ad25000000000000000000000000000000000000000000000000000000000f52ae0e000000000000000000000000000000000000000000000000000000000000f2d000000000000000000000000000000000000000000000000000000000018eb30afc7fcf68097cd0584877939477347b5b8fa10efee2e29805370a35fd2a22ee9500000000000000000000000000000000000000000000000000000000000000016dfa43f824c3b8b61e715fe8bf447f2aba63e59ab537f186cf665152c2114c3900000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed700000000000000000000000000000000000000000000000000000000000000171e8c4fab8994494c8f1e5c1287445b2917d60c43c79aa959162f5d6000598d3200000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed7000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000000000001700000000000000000000000000000000000000000000000000000000000001e00000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d000000000000000000000000000000000000000000000000393846a1e4cce00000000000000000000000000000000000000000000000000000000000667d7a7a00000000000000000000000000000000000000000000000000000000667d7a7a0000000000000000000000000000000000000000000000000000000000177f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
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

        // not matching any selector (default case) - return zero address
        protocolData = vm.parseBytes("0x99999999");
        receiver = testFacet.testParseReceiver(protocolData);
        assertEq(address(uint160(uint256(receiver))), address(0));
    }
}
