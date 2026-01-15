// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../../../utils/TestBase.sol";
import { TestWhitelistManagerBase } from "../../../utils/TestWhitelistManagerBase.sol";
import { TestHelpers, MockUniswapDEX } from "../../../utils/TestHelpers.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { IAcrossSpokePoolV4 } from "lifi/Interfaces/IAcrossSpokePoolV4.sol";
import { ISpokePoolPeriphery } from "lifi/Interfaces/ISpokePoolPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { InvalidConfig, InformationMismatch, InvalidReceiver, InvalidNonEVMReceiver, InvalidCallData } from "lifi/Errors/GenericErrors.sol";

// Stub AcrossV4SwapFacet Contract
contract TestAcrossV4SwapFacet is AcrossV4SwapFacet, TestWhitelistManagerBase {
    constructor(
        ISpokePoolPeriphery _spokePoolPeriphery,
        address _spokePool,
        address _sponsoredOftSrcPeriphery,
        address _sponsoredCctpSrcPeriphery
    )
        AcrossV4SwapFacet(
            _spokePoolPeriphery,
            _spokePool,
            _sponsoredOftSrcPeriphery,
            _sponsoredCctpSrcPeriphery
        )
    {}
}

contract AcrossV4SwapFacetTest is TestBase, TestHelpers {
    /// @dev ABI-compatible with `AcrossV4SwapFacet.AcrossV4SwapFacetData` but uses `uint8` to
    ///      allow encoding out-of-range enum values for decoder panic tests.
    struct AcrossV4SwapFacetDataRaw {
        uint8 swapApiTarget;
        bytes callData;
    }
    // Mainnet addresses (updated to new SpokePoolPeriphery)

    address internal constant SPOKE_POOL_PERIPHERY =
        0x89415a82d909a7238d69094C3Dd1dCC1aCbDa85C;
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;

    address internal constant SPONSORED_OFT_SRC_PERIPHERY =
        0x4607BceaF7b22cb0c46882FFc9fAB3c6efe66e5a;
    address internal constant SPONSORED_CCTP_SRC_PERIPHERY =
        0x89004EA51Bac007FEc55976967135b2Aa6e838d4;

    // Mainnet token addresses
    address internal constant WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC_MAINNET =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT_MAINNET =
        0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant UNISWAP_UNIVERSAL_ROUTER =
        0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD;

    // Arbitrum token addresses
    address internal constant USDC_ARBITRUM =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant USDT_ARBITRUM =
        0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    /// @dev Across Swap API calldata (no selector), pinned to mainnet block 24237300.
    ///      Source query:
    ///      - originChainId=1, destinationChainId=42161
    ///      - inputToken=WETH(mainnet), outputToken=USDC(arbitrum)
    ///      - amount=0.1 WETH
    ///      - depositor=USER_SENDER, recipient=USER_RECEIVER
    bytes internal constant ACROSS_SWAP_API_SPOKE_POOL_PERIPHERY_CALLDATA =
        hex"0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000180000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000000000000000001ff3684f28c67538d4d072c227340000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000016345785d8a0000000000000000000000000000000000000000000000000000000000001384ad9c000000000000000000000000000000000000000000000000000000000000086000000000000000000000000000000000000000000000000000000000000000010000000000000000000000005c7bcd6e7de5423a257d81b442095a1a6ced35c50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000000000000000000000000000000000001383f7ff0000000000000000000000000000000000000000000000000000000abc1234560000000000000000000000000f7ae28de1c8532170ad4ee566b5801485c13a0e000000000000000000000000000000000000000000000000000000000000a4b100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000069685dc300000000000000000000000000000000000000000000000000000000696879e300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000056000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000f7ae28de1c8532170ad4ee566b5801485c13a0e000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044ef8738d3000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000000000000000000000000000000000000000000000000000000000000f7ae28de1c8532170ad4ee566b5801485c13a0e000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044ef8738d3000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000000000000000000000000000000000000abc65432100000000000000000000000000000000000000000000000000000000000000000000000000000000bf75133b48b0a42ab9374027902e83c5e2949034000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000224d836083e000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000016345785d8a0000000000000000000000000000000000000000000000000000000000001384ad9c0000000000000000000000000000000000000000000000000000000013b73d85000000000000000000000000000000000000000000000000016345785d8a000000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc6543210000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000230780000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007042213bc0b000000000000000000000000c92814c1974355122a8a43781a090552634ee567000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000016345785d8a0000000000000000000000000000c92814c1974355122a8a43781a090552634ee56700000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000006241fff991f0000000000000000000000004d6d2a149a46d9d8c4473fbaa269f3738247eb60000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000001384ad9c00000000000000000000000000000000000000000000000000000000000000a06caeff1c5dfa88bb50c0132900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000002e000000000000000000000000000000000000000000000000000000000000004a000000000000000000000000000000000000000000000000000000000000000e4c1fb425e000000000000000000000000c92814c1974355122a8a43781a090552634ee567000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000016345785d8a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000069685fc900000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010438c9c147000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000000000000000000000000000000000000000002710000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000242e1a7d4d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001846c5f9cf9000000000000000000000000c92814c1974355122a8a43781a090552634ee567000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000ffffffffffffffc5000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000043271000000000400065a8177fae2701a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000d1b71758e21960000137e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008434ee90ca000000000000000000000000f5c4f3dc02c3fb9279495a8fef7b0741da956157000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000013b7592a0000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    /// @dev Across Swap API calldata (no selector) for a direct SpokePool deposit (USDC(mainnet) -> USDC(arbitrum)).
    ///      Source query:
    ///      - originChainId=1, destinationChainId=42161
    ///      - inputToken=USDC(mainnet), outputToken=USDC(arbitrum)
    ///      - amount=100 USDC
    ///      - depositor=USER_SENDER, recipient=USER_RECEIVER
    bytes internal constant ACROSS_SWAP_API_SPOKE_POOL_CALLDATA =
        hex"0000000000000000000000000000000000000000000000000000000abc1234560000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000000000000005f59571000000000000000000000000000000000000000000000000000000000000a4b100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000069685dc300000000000000000000000000000000000000000000000000000000696879e3000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000000";

    TestAcrossV4SwapFacet internal acrossV4SwapFacet;
    ISpokePoolPeriphery.BaseDepositData internal baseDepositData;
    address internal swapToken;
    address internal exchange;
    ISpokePoolPeriphery.TransferType internal transferType;
    bytes internal routerCalldata;
    uint256 internal minExpectedInputTokenAmount;
    bool internal enableProportionalAdjustment;

    function setUp() public {
        // Updated to block 24237400 (2026-01-15) to match embedded Across Swap API calldata.
        customBlockNumberForForking = 24237400;
        initTestBase();

        acrossV4SwapFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            SPOKE_POOL,
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = acrossV4SwapFacet
            .startBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[1] = acrossV4SwapFacet
            .swapAndStartBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[2] = acrossV4SwapFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(acrossV4SwapFacet), functionSelectors);
        acrossV4SwapFacet = TestAcrossV4SwapFacet(address(diamond));
        acrossV4SwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(acrossV4SwapFacet),
            "AcrossV4SwapFacet"
        );

        // Adjust bridgeData - mainnet to Arbitrum
        bridgeData.bridge = "acrossV4Swap";
        bridgeData.destinationChainId = 42161; // Arbitrum

        // Decode embedded Across Swap API calldata and use it as our baseline for SpokePoolPeriphery tests.
        ISpokePoolPeriphery.SwapAndDepositData memory swapAndDepositData = abi
            .decode(
                ACROSS_SWAP_API_SPOKE_POOL_PERIPHERY_CALLDATA,
                (ISpokePoolPeriphery.SwapAndDepositData)
            );

        baseDepositData = swapAndDepositData.depositData;
        swapToken = swapAndDepositData.swapToken;
        exchange = swapAndDepositData.exchange;
        transferType = swapAndDepositData.transferType;
        routerCalldata = swapAndDepositData.routerCalldata;
        minExpectedInputTokenAmount = swapAndDepositData
            .minExpectedInputTokenAmount;
        enableProportionalAdjustment = swapAndDepositData
            .enableProportionalAdjustment;

        // Align bridgeData with the encoded swapToken + recipient.
        bridgeData.sendingAssetId = swapToken;
        bridgeData.minAmount = swapAndDepositData.swapTokenAmount;
        bridgeData.receiver = address(
            uint160(uint256(baseDepositData.recipient))
        );

        vm.label(SPOKE_POOL_PERIPHERY, "SpokePoolPeriphery");
        vm.label(SPOKE_POOL, "SpokePool");
        vm.label(WETH, "WETH");
        vm.label(USDC_MAINNET, "USDC");
    }

    function test_contractIsSetUpCorrectly() public {
        acrossV4SwapFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            SPOKE_POOL,
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        assertEq(
            address(acrossV4SwapFacet.SPOKE_POOL_PERIPHERY()),
            SPOKE_POOL_PERIPHERY
        );
        assertEq(acrossV4SwapFacet.SPOKE_POOL(), SPOKE_POOL);
        assertEq(
            acrossV4SwapFacet.SPONSORED_OFT_SRC_PERIPHERY(),
            SPONSORED_OFT_SRC_PERIPHERY
        );
        assertEq(
            acrossV4SwapFacet.SPONSORED_CCTP_SRC_PERIPHERY(),
            SPONSORED_CCTP_SRC_PERIPHERY
        );
    }

    function testRevert_WhenConstructedWithZeroPeripheryAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(address(0)),
            SPOKE_POOL,
            address(0),
            address(0)
        );
    }

    function testRevert_WhenConstructedWithZeroSpokePoolAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(0),
            address(0),
            address(0)
        );
    }

    function test_CanBridgeViaSwapApiCalldata_SpokePoolPeriphery() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);
        bytes memory callData = _buildCallData(bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(bridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                callData
            )
        );

        vm.stopPrank();
    }

    function test_CanBridgeViaSwapApiCalldata_SpokePool() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.receiver = USER_RECEIVER;
        localBridgeData.minAmount = 100 * 10 ** 6; // 100 USDC
        localBridgeData.destinationChainId = 42161;

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: _convertAddressToBytes32(USER_SENDER),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: _convertAddressToBytes32(USDC_MAINNET),
                outputToken: _convertAddressToBytes32(USDC_ARBITRUM),
                inputAmount: localBridgeData.minAmount,
                outputAmount: 99980657, // from API quote at block 24237400
                destinationChainId: localBridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: 1768447427, // from API quote at block 24237400
                fillDeadline: 1768454627, // from API quote at block 24237400
                exclusivityParameter: 0,
                message: ""
            });
        bytes memory callData = abi.encode(params);

        uint256 spokePoolBalanceBefore = usdc.balanceOf(SPOKE_POOL);

        vm.startPrank(USER_SENDER);

        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(localBridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            _facetData(AcrossV4SwapFacet.SwapApiTarget.SpokePool, callData)
        );

        vm.stopPrank();

        assertEq(
            usdc.balanceOf(SPOKE_POOL),
            spokePoolBalanceBefore + localBridgeData.minAmount
        );
    }

    function test_SpokePool_PositiveSlippageAdjustsInputAndOutputAmounts()
        public
    {
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            SPOKE_POOL,
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        // Setup swap to return +10% USDC
        uint256 preSwapAmount = 100 * 10 ** 6;
        uint256 swapOutputAmount = 110 * 10 ** 6;

        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.receiver = USER_RECEIVER;
        localBridgeData.minAmount = preSwapAmount;

        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(localFacet),
            USDC_MAINNET,
            swapOutputAmount,
            0
        );
        localFacet.addAllowedContractSelector(
            address(mockDEX),
            mockDEX.swapExactTokensForTokens.selector
        );

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = USDC_MAINNET;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDEX),
                approveTo: address(mockDEX),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: USDC_MAINNET,
                fromAmount: 100 * 10 ** 18,
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18,
                    preSwapAmount,
                    path,
                    address(localFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: preSwapAmount,
                outputAmount: 99 * 10 ** 6,
                destinationChainId: localBridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.startPrank(USER_SENDER);

        dai.approve(address(localFacet), swapData[0].fromAmount);

        uint256 spokePoolBalanceBefore = usdc.balanceOf(SPOKE_POOL);

        // NOTE: Avoid memory aliasing with structs that contain dynamic types (e.g. `string`).
        // Build a fresh struct so that mutating `expectedEventData` cannot affect `localBridgeData`.
        ILiFi.BridgeData memory expectedEventData = ILiFi.BridgeData({
            transactionId: localBridgeData.transactionId,
            bridge: localBridgeData.bridge,
            integrator: localBridgeData.integrator,
            referrer: localBridgeData.referrer,
            sendingAssetId: localBridgeData.sendingAssetId,
            receiver: localBridgeData.receiver,
            minAmount: swapOutputAmount,
            destinationChainId: localBridgeData.destinationChainId,
            hasSourceSwaps: localBridgeData.hasSourceSwaps,
            hasDestinationCall: localBridgeData.hasDestinationCall
        });

        vm.expectEmit(true, true, true, true, address(localFacet));
        emit LiFiTransferStarted(expectedEventData);

        localFacet.swapAndStartBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            swapData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();

        // Effects-only assertion:
        // the SpokePool must receive the post-swap input amount (swapOutputAmount).
        assertEq(
            usdc.balanceOf(SPOKE_POOL),
            spokePoolBalanceBefore + swapOutputAmount
        );
    }

    function testRevert_SpokePool_WhenInputAmountMismatch() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.receiver = USER_RECEIVER;
        localBridgeData.minAmount = 100 * 10 ** 6; // 100 USDC
        localBridgeData.destinationChainId = 42161;

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: localBridgeData.minAmount - 1,
                outputAmount: 99900000,
                destinationChainId: localBridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.startPrank(USER_SENDER);

        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    function testRevert_WhenDestinationChainIdMismatch() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set mismatched destination chain ID
        baseDepositData.destinationChainId = 1; // Ethereum instead of Arbitrum

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function testRevert_WhenEVMRecipientIsZero() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set recipient to zero (for EVM chains, we only validate non-zero)
        baseDepositData.recipient = bytes32(0);

        vm.expectRevert(InvalidReceiver.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function testRevert_WhenNonEVMReceiverIsZero() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set non-EVM receiver
        bridgeData.receiver = NON_EVM_ADDRESS;
        baseDepositData.recipient = bytes32(0);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function test_CanBridgeToNonEVMChain() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set non-EVM receiver
        bridgeData.receiver = NON_EVM_ADDRESS;
        bytes32 nonEVMRecipient = bytes32(uint256(0x1234567890abcdef));
        baseDepositData.recipient = nonEVMRecipient;

        // Expect non-EVM event
        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            nonEVMRecipient
        );

        // Expect LiFiTransferStarted event
        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(bridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function testRevert_WhenDepositorIsZero() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set depositor to zero address
        baseDepositData.depositor = address(0);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function testRevert_WhenSwapApiTargetIsInvalid() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // the test will fail when trying to convert the enum value to the SwapApiTarget enum
        // and never reaches the InvalidCallData revert
        vm.expectRevert();
        bytes memory encoded = abi.encodeWithSelector(
            acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap.selector,
            bridgeData,
            AcrossV4SwapFacetDataRaw({
                swapApiTarget: 5,
                callData: _buildCallData(bridgeData.minAmount)
            })
        );

        // Bubble up the revert data
        (bool success, bytes memory returnData) = address(acrossV4SwapFacet)
            .call(encoded);
        if (!success) {
            LibUtil.revertWith(returnData);
        }

        vm.stopPrank();
    }

    function testRevert_WhenDestinationCallEnabled() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Destination calls are disabled - set hasDestinationCall to true
        bridgeData.hasDestinationCall = true;

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWhenDestinationCallEnabled() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.hasDestinationCall = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);

        // Destination calls are disabled
        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap(
            bridgeData,
            swapData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function test_GetAcrossChainIdForSolana() public {
        // Test that Solana chain ID is converted correctly
        uint256 solanaLiFiChainId = 1151111081099710; // LIFI_CHAIN_ID_SOLANA
        uint256 solanaAcrossChainId = 34268394551451; // ACROSS_CHAIN_ID_SOLANA

        // We can't directly test the internal function, but we can test it via non-EVM bridging
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set up for Solana bridging
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = solanaLiFiChainId;
        // depositData.destinationChainId should be the Across chain ID (converted)
        baseDepositData.destinationChainId = solanaAcrossChainId;
        baseDepositData.recipient = bytes32(uint256(uint160(USER_RECEIVER)));

        // Expect non-EVM event
        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            baseDepositData.recipient
        );

        // Expect LiFiTransferStarted event
        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(bridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function testRevert_WhenSolanaChainIdMismatch() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set up for Solana bridging with wrong Across chain ID
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 1151111081099710; // LIFI_CHAIN_ID_SOLANA
        baseDepositData.destinationChainId = 1; // Wrong chain ID (should be 34268394551451)

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePoolPeriphery_WhenSpokePoolMismatch() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        address wrongSpokePool = address(0xBEEF); // mismatch with immutable SPOKE_POOL
        vm.assume(wrongSpokePool != SPOKE_POOL);

        bytes memory callData = _buildCallDataWithSpokePool(
            bridgeData.minAmount,
            wrongSpokePool
        );

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                callData
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePoolPeriphery_WhenSwapTokenMismatchForErc20()
        public
    {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        swapToken = USDT_MAINNET; // mismatch with USDC_MAINNET
        bytes memory callData = _buildCallData(bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                callData
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePoolPeriphery_WhenEvmRecipientMismatch() public {
        vm.startPrank(USER_SENDER);

        weth.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        baseDepositData.recipient = _convertAddressToBytes32(address(0x1234)); // does not match with USER_RECEIVER from bridgeData
        bytes memory callData = _buildCallData(bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                callData
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePool_WhenDepositorIsZero() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.receiver = USER_RECEIVER;
        localBridgeData.minAmount = 100 * 10 ** 6; // 100 USDC
        localBridgeData.destinationChainId = 42161;

        vm.startPrank(USER_SENDER);

        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(0),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: localBridgeData.minAmount,
                outputAmount: 99900000,
                destinationChainId: localBridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePool_WhenInputTokenMismatch() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.receiver = USER_RECEIVER;
        localBridgeData.minAmount = 100 * 10 ** 6; // 100 USDC
        localBridgeData.destinationChainId = 42161;

        vm.startPrank(USER_SENDER);

        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDT_MAINNET))), // mismatch with USDC_MAINNET
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: localBridgeData.minAmount,
                outputAmount: 99900000,
                destinationChainId: localBridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePool_WhenEvmRecipientMismatch() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.receiver = USER_RECEIVER;
        localBridgeData.minAmount = 100 * 10 ** 6; // 100 USDC
        localBridgeData.destinationChainId = 42161;

        vm.startPrank(USER_SENDER);

        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(address(0x1234)), // different to USER_RECEIVER
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: localBridgeData.minAmount,
                outputAmount: 99900000,
                destinationChainId: localBridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.expectRevert(InvalidReceiver.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    /// Helper functions ///

    /// @notice Converts an address to bytes32
    function _convertAddressToBytes32(
        address _address
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_address)));
    }

    function _buildCallData(
        uint256 _swapTokenAmount
    ) internal view returns (bytes memory) {
        return _buildCallDataWithSpokePool(_swapTokenAmount, SPOKE_POOL);
    }

    function _buildCallDataWithSpokePool(
        uint256 _swapTokenAmount,
        address _spokePool
    ) internal view returns (bytes memory) {
        ISpokePoolPeriphery.SwapAndDepositData
            memory swapAndDepositData = ISpokePoolPeriphery
                .SwapAndDepositData({
                    submissionFees: ISpokePoolPeriphery.Fees({
                        amount: 0,
                        recipient: address(0)
                    }),
                    depositData: baseDepositData,
                    swapToken: swapToken,
                    exchange: exchange,
                    transferType: transferType,
                    swapTokenAmount: _swapTokenAmount,
                    minExpectedInputTokenAmount: minExpectedInputTokenAmount,
                    routerCalldata: routerCalldata,
                    enableProportionalAdjustment: enableProportionalAdjustment,
                    spokePool: _spokePool,
                    nonce: 0
                });

        return abi.encode(swapAndDepositData);
    }

    function _facetData(
        AcrossV4SwapFacet.SwapApiTarget _swapApiTarget,
        bytes memory _callData
    ) internal pure returns (AcrossV4SwapFacet.AcrossV4SwapFacetData memory) {
        return
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: _swapApiTarget,
                callData: _callData
            });
    }

    // Sponsored OFT/CCTP tests are in:
    // `test/solidity/Facets/AcrossV4SwapFacet.Sponsored.t.sol`
}
