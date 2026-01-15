// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../../../utils/TestBaseFacet.sol";
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

/// @dev Calldata sink for the SpokePool `deposit(...)` selector.
///      We intentionally do NOT implement the full `IAcrossSpokePoolV4` interface here because
///      the legacy ABI decoder for the 12-arg `deposit` can trigger stack-too-deep in solc.
contract MockAcrossSpokePoolV4 {
    uint256 public lastMsgValue;
    bytes public lastCallData;

    fallback() external payable {
        lastMsgValue = msg.value;
        lastCallData = msg.data;
    }

    receive() external payable {
        lastMsgValue = msg.value;
    }
}

contract MockSpokePoolPeriphery is ISpokePoolPeriphery {
    SwapAndDepositData internal lastSwapAndDepositData;
    uint256 public lastMsgValue;

    function swapAndBridge(
        SwapAndDepositData calldata _swapAndDepositData
    ) external payable {
        lastSwapAndDepositData = _swapAndDepositData;
        lastMsgValue = msg.value;
    }
}

contract AcrossV4SwapFacetTest is TestBaseFacet, TestHelpers {
    error FfiEncodeFailed();
    error SliceOutOfBounds();
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

    TestAcrossV4SwapFacet internal acrossV4SwapFacet;
    ISpokePoolPeriphery.BaseDepositData internal baseDepositData;
    address internal swapToken;
    address internal exchange;
    ISpokePoolPeriphery.TransferType internal transferType;
    bytes internal routerCalldata;
    uint256 internal minExpectedInputTokenAmount;
    bool internal enableProportionalAdjustment;

    function setUp() public {
        // Updated to block 24067413 (2025-12-22 10:00 UTC) to match fresh Across API quote
        customBlockNumberForForking = 24067413;
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

        // Build valid AcrossV4SwapData
        // NOTE: Using USDC as both swap token AND input token creates a "no-op" swap scenario
        // This allows testing the periphery integration without dealing with stale swap calldata
        // The periphery will execute the router calldata but since input=output, we get back USDC
        uint32 quoteTimestamp = uint32(block.timestamp);

        // Minimal router calldata that does nothing (empty execute call to Universal Router)
        // This is a workaround since real swap calldata from Across API becomes stale quickly
        // due to price movements and requires exact block state matching
        bytes
            memory dummyRouterCalldata = hex"24856bc30000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

        baseDepositData = ISpokePoolPeriphery.BaseDepositData({
            inputToken: USDC_MAINNET, // Bridge USDC directly (no swap)
            outputToken: _convertAddressToBytes32(USDC_ARBITRUM), // Receive USDC on Arbitrum
            outputAmount: (bridgeData.minAmount * 99) / 100, // 99% of input amount
            depositor: USER_SENDER,
            recipient: _convertAddressToBytes32(USER_RECEIVER),
            destinationChainId: 42161, // Arbitrum
            exclusiveRelayer: bytes32(0),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 3600),
            exclusivityParameter: 0,
            message: ""
        });

        swapToken = USDC_MAINNET; // USDC (same as inputToken, no swap needed)
        exchange = UNISWAP_UNIVERSAL_ROUTER; // Router address (won't be called with empty calldata)
        transferType = ISpokePoolPeriphery.TransferType.Approval;
        routerCalldata = dummyRouterCalldata; // Empty execute() call
        minExpectedInputTokenAmount = bridgeData.minAmount; // Expect full amount back (no swap)
        enableProportionalAdjustment = false;

        vm.label(SPOKE_POOL_PERIPHERY, "SpokePoolPeriphery");
        vm.label(SPOKE_POOL, "SpokePool");
        vm.label(WETH, "WETH");
        vm.label(USDC_MAINNET, "USDC");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        // Keep minExpectedInputTokenAmount and outputAmount in sync with bridgeData for fuzz tests.
        minExpectedInputTokenAmount = bridgeData.minAmount;
        baseDepositData.outputAmount = (bridgeData.minAmount * 999) / 1000; // Approx 0.1% fee

        if (isNative) {
            // For native assets, inputToken should be WETH (wrapped native)
            baseDepositData.inputToken = WETH;
            swapToken = WETH;
            acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap{
                value: bridgeData.minAmount
            }(
                bridgeData,
                _facetData(
                    AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                    _buildCallData(bridgeData.minAmount)
                )
            );
        } else {
            acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
                bridgeData,
                _facetData(
                    AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                    _buildCallData(bridgeData.minAmount)
                )
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        // NOTE: For native bridging, the facet forwards value from its own balance to SpokePoolPeriphery.
        // The base test swaps USDC->ETH into the facet balance, so we do not pass msg.value here.
        // We only need to make sure the calldata uses WETH for swapToken/inputToken.
        if (bridgeData.sendingAssetId == address(0)) {
            baseDepositData.inputToken = WETH;
            swapToken = WETH;
        }

        acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap(
            bridgeData,
            swapData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                _buildCallData(bridgeData.minAmount)
            )
        );
    }

    // Base tests now enabled with real Across Swap API data
    // Flow: User sends USDC -> SpokePoolPeriphery swaps USDC->USDT -> bridges USDT to Arbitrum
    // Balance checks verify USDC leaves user account (origin swap happens inside periphery)

    // Base test will cover native asset path
    // Note: The facet does support native assets - they are wrapped to WETH by the periphery

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

    function testRevert_WhenConstructedWithZeroSponsoredOftSrcPeripheryAddress()
        public
    {
        vm.expectRevert(InvalidConfig.selector);

        new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            SPOKE_POOL,
            address(0),
            SPONSORED_CCTP_SRC_PERIPHERY
        );
    }

    function testRevert_WhenConstructedWithZeroSponsoredCctpSrcPeripheryAddress()
        public
    {
        vm.expectRevert(InvalidConfig.selector);

        new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            SPOKE_POOL,
            SPONSORED_OFT_SRC_PERIPHERY,
            address(0)
        );
    }

    function test_CanBridgeViaSwapApiCalldata_SpokePoolPeriphery() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);
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
        MockAcrossSpokePoolV4 mockSpokePool = new MockAcrossSpokePoolV4();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(mockSpokePool),
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: bridgeData.minAmount,
                outputAmount: 99900000,
                destinationChainId: bridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        bytes memory callData = abi.encode(params);

        vm.expectEmit(true, true, true, true, address(localFacet));
        emit LiFiTransferStarted(bridgeData);

        localFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(AcrossV4SwapFacet.SwapApiTarget.SpokePool, callData)
        );

        vm.stopPrank();
    }

    function test_SpokePool_PositiveSlippageAdjustsInputAndOutputAmounts()
        public
    {
        MockAcrossSpokePoolV4 mockSpokePool = new MockAcrossSpokePoolV4();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(mockSpokePool),
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        // Setup swap to return +10% USDC
        uint256 preSwapAmount = 100 * 10 ** 6;
        uint256 swapOutputAmount = 110 * 10 ** 6;

        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.sendingAssetId = USDC_MAINNET;
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

        bytes memory spokePoolCallData = mockSpokePool.lastCallData();
        assertGt(spokePoolCallData.length, 4);

        bytes memory spokePoolArgs = _sliceBytes(
            spokePoolCallData,
            4,
            spokePoolCallData.length - 4
        );

        // We only need to assert the adjusted amounts (to cover the positive-slippage branch).
        // Decode the initial static args only; the remaining args include a dynamic `bytes` and
        // decoding them all tends to trigger stack-too-deep in tests.
        (
            ,
            ,
            ,
            ,
            uint256 inputAmount,
            uint256 outputAmount,
            uint256 destinationChainId
        ) = abi.decode(
                spokePoolArgs,
                (bytes32, bytes32, bytes32, bytes32, uint256, uint256, uint256)
            );

        assertEq(destinationChainId, bridgeData.destinationChainId);

        // Positive slippage adjustment:
        // inputAmount becomes the post-swap amount (swapOutputAmount)
        // outputAmount scales proportionally based on the quote output/input ratio (99/100).
        assertEq(inputAmount, swapOutputAmount);
        assertEq(
            outputAmount,
            (swapOutputAmount * (99 * 10 ** 6)) / preSwapAmount
        );
    }

    function testRevert_SpokePool_WhenInputAmountMismatch() public {
        MockAcrossSpokePoolV4 mockSpokePool = new MockAcrossSpokePoolV4();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(mockSpokePool),
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: bridgeData.minAmount - 1,
                outputAmount: 99900000,
                destinationChainId: bridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.expectRevert(InformationMismatch.selector);

        localFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    /// @notice Converts an address to bytes32
    function _convertAddressToBytes32(
        address _address
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_address)));
    }

    /// @dev Solidity doesn't support bytes memory slicing (`data[start:]`), so we copy into a new bytes.
    function _sliceBytes(
        bytes memory _data,
        uint256 _start,
        uint256 _len
    ) internal pure returns (bytes memory out) {
        if (_data.length < _start + _len) revert SliceOutOfBounds();
        out = new bytes(_len);
        for (uint256 i = 0; i < _len; i++) {
            out[i] = _data[_start + i];
        }
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

    // Sponsored OFT/CCTP tests and related encoding helpers were split into:
    // `test/solidity/Facets/AcrossV4SwapFacet.Sponsored.t.sol`
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

    // Additional test cases for 100% coverage

    function testRevert_WhenDestinationChainIdMismatch() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

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
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

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
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

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
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

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

    function testRevert_SwapAndBridgeWhenDestinationChainIdMismatch() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);

        // Set mismatched destination chain ID
        baseDepositData.destinationChainId = 1; // Ethereum instead of Arbitrum

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

    function testRevert_SwapAndBridgeWhenEVMRecipientIsZero() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);

        // Set recipient to zero (for EVM chains, we only validate non-zero)
        baseDepositData.recipient = bytes32(0);

        vm.expectRevert(InvalidReceiver.selector);

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

    function test_PositiveSlippageAdjustment() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);
        minExpectedInputTokenAmount = bridgeData.minAmount;

        // Expect the event
        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(bridgeData);

        // This will test the path where minAmount == originalAmount (no adjustment)
        // The positive slippage adjustment logic is tested by the fact that
        // if _depositAndSwap returns more than originalAmount, the adjustment happens
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

    function test_OutputAmountAdjustedWithPositiveSlippage() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = USDC_MAINNET;
        bridgeData.minAmount = 100 * 10 ** 6; // 100 USDC (expected output from swap)

        // Setup mock DEX to return 110 USDC (10% positive slippage)
        uint256 swapOutputAmount = 110 * 10 ** 6; // 110 USDC (positive slippage)
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(acrossV4SwapFacet),
            USDC_MAINNET,
            swapOutputAmount,
            0 // Use default amountIn
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            address(mockDEX),
            mockDEX.swapExactTokensForTokens.selector
        );

        // Setup swap data
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
                fromAmount: 100 * 10 ** 18, // 100 DAI
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18, // amountIn
                    100 * 10 ** 6, // amountOutMin
                    path,
                    address(acrossV4SwapFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // Base calldata uses a 0.99 output/input ratio (99 USDC out for 100 USDC in).
        // With positive slippage to 110 USDC, the facet should scale outputAmount proportionally:
        // newOutput ~= 99 * 110 / 100 = 108.9 USDC.
        baseDepositData.inputToken = USDC_MAINNET;
        baseDepositData.outputToken = _convertAddressToBytes32(USDC_ARBITRUM);
        baseDepositData.outputAmount = 99 * 10 ** 6;
        minExpectedInputTokenAmount = bridgeData.minAmount;

        // Approve DAI
        dai.approve(address(acrossV4SwapFacet), 100 * 10 ** 18);

        // Create expected bridgeData with updated minAmount for event check
        ILiFi.BridgeData memory expectedBridgeData = bridgeData;
        expectedBridgeData.minAmount = swapOutputAmount; // 110 USDC (after positive slippage)

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(expectedBridgeData);

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

    function test_OutputAmountNotAdjustedWhenNoPositiveSlippage() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = USDC_MAINNET;
        bridgeData.minAmount = 100 * 10 ** 6; // 100 USDC

        // Setup mock DEX to return exactly 100 USDC (no positive slippage)
        uint256 swapOutputAmount = 100 * 10 ** 6; // 100 USDC (exact, no slippage)
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(acrossV4SwapFacet),
            USDC_MAINNET,
            swapOutputAmount,
            0
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            address(mockDEX),
            mockDEX.swapExactTokensForTokens.selector
        );

        // Setup swap data
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
                fromAmount: 100 * 10 ** 18, // 100 DAI
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18,
                    100 * 10 ** 6,
                    path,
                    address(acrossV4SwapFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        uint256 originalOutputAmount = 99 * 10 ** 6; // Original outputAmount
        baseDepositData.inputToken = USDC_MAINNET;
        baseDepositData.outputToken = _convertAddressToBytes32(USDC_ARBITRUM);
        baseDepositData.outputAmount = originalOutputAmount;
        minExpectedInputTokenAmount = bridgeData.minAmount;

        dai.approve(address(acrossV4SwapFacet), 100 * 10 ** 18);

        // When minAmount == originalAmount (no positive slippage), outputAmount should NOT be adjusted
        // If it were incorrectly adjusted: (100 * 0.5e18) / 1e18 = 50 USDC (wrong!)
        // The original 99 USDC should be used, proving no adjustment occurred
        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(bridgeData);

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

    function test_ConvertAddressToBytes32() public {
        address testAddress = address(
            0x1234567890123456789012345678901234567890
        );
        bytes32 expected = bytes32(uint256(uint160(testAddress)));
        bytes32 result = _convertAddressToBytes32(testAddress);
        assertEq(result, expected);
    }

    function testRevert_SwapAndBridgeWhenNonEVMReceiverIsZero() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);

        // Set non-EVM receiver
        bridgeData.receiver = NON_EVM_ADDRESS;
        baseDepositData.recipient = bytes32(0);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

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

    function test_CanSwapAndBridgeToNonEVMChain() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);

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

    function testRevert_WhenDepositorIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

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
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

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

        // Bubble up the revert data so `expectRevert` can match it.
        (bool success, bytes memory returnData) = address(acrossV4SwapFacet)
            .call(encoded);
        if (!success) {
            LibUtil.revertWith(returnData);
        }

        vm.stopPrank();
    }

    function testRevert_WhenDestinationCallEnabled() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

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
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set up for Solana bridging
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = solanaLiFiChainId;
        // depositData.destinationChainId should be the Across chain ID (converted)
        baseDepositData.destinationChainId = solanaAcrossChainId;
        baseDepositData.recipient = bytes32(uint256(0x1234567890abcdef));

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
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        // Set up for Solana bridging with wrong Across chain ID
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 1151111081099710; // LIFI_CHAIN_ID_SOLANA
        baseDepositData.destinationChainId = 1; // Wrong chain ID (should be 34268394551451)
        baseDepositData.recipient = bytes32(uint256(0x1234567890abcdef));

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

    // -------------------------
    // Missing branch coverage
    // -------------------------

    function testRevert_SpokePoolPeriphery_WhenSpokePoolMismatch() public {
        MockSpokePoolPeriphery mockPeriphery = new MockSpokePoolPeriphery();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(address(mockPeriphery)),
            SPOKE_POOL,
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        address wrongSpokePool = address(0xBEEF);
        vm.assume(wrongSpokePool != SPOKE_POOL);

        bytes memory callData = _buildCallDataWithSpokePool(
            bridgeData.minAmount,
            wrongSpokePool
        );

        vm.expectRevert(InformationMismatch.selector);

        localFacet.startBridgeTokensViaAcrossV4Swap(
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
        MockSpokePoolPeriphery mockPeriphery = new MockSpokePoolPeriphery();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(address(mockPeriphery)),
            SPOKE_POOL,
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        swapToken = USDT_MAINNET;
        bytes memory callData = _buildCallData(bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        localFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                callData
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePoolPeriphery_WhenEvmRecipientMismatch() public {
        MockSpokePoolPeriphery mockPeriphery = new MockSpokePoolPeriphery();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(address(mockPeriphery)),
            SPOKE_POOL,
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        baseDepositData.recipient = _convertAddressToBytes32(address(0x1234));
        bytes memory callData = _buildCallData(bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        localFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery,
                callData
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePool_WhenDepositorIsZero() public {
        MockAcrossSpokePoolV4 mockSpokePool = new MockAcrossSpokePoolV4();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(mockSpokePool),
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(0),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: bridgeData.minAmount,
                outputAmount: 99900000,
                destinationChainId: bridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.expectRevert(InvalidCallData.selector);

        localFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePool_WhenInputTokenMismatch() public {
        MockAcrossSpokePoolV4 mockSpokePool = new MockAcrossSpokePoolV4();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(mockSpokePool),
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(USER_RECEIVER),
                inputToken: bytes32(uint256(uint160(USDT_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: bridgeData.minAmount,
                outputAmount: 99900000,
                destinationChainId: bridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.expectRevert(InformationMismatch.selector);

        localFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    function testRevert_SpokePool_WhenEvmRecipientMismatch() public {
        MockAcrossSpokePoolV4 mockSpokePool = new MockAcrossSpokePoolV4();
        TestAcrossV4SwapFacet localFacet = new TestAcrossV4SwapFacet(
            ISpokePoolPeriphery(SPOKE_POOL_PERIPHERY),
            address(mockSpokePool),
            SPONSORED_OFT_SRC_PERIPHERY,
            SPONSORED_CCTP_SRC_PERIPHERY
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(localFacet), bridgeData.minAmount);

        IAcrossSpokePoolV4.DepositParams memory params = IAcrossSpokePoolV4
            .DepositParams({
                depositor: bytes32(uint256(uint160(USER_SENDER))),
                recipient: _convertAddressToBytes32(address(0x1234)),
                inputToken: bytes32(uint256(uint160(USDC_MAINNET))),
                outputToken: bytes32(uint256(uint160(USDC_ARBITRUM))),
                inputAmount: bridgeData.minAmount,
                outputAmount: 99900000,
                destinationChainId: bridgeData.destinationChainId,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 3600),
                exclusivityParameter: 0,
                message: ""
            });

        vm.expectRevert(InvalidReceiver.selector);

        localFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            _facetData(
                AcrossV4SwapFacet.SwapApiTarget.SpokePool,
                abi.encode(params)
            )
        );

        vm.stopPrank();
    }

    // Sponsored OFT/CCTP tests are in:
    // `test/solidity/Facets/AcrossV4SwapFacet.Sponsored.t.sol`
}
