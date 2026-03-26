// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";
import { IL1StandardBridge } from "lifi/Interfaces/IL1StandardBridge.sol";
import { LibSwap, TestBase, ILiFi, ERC20 } from "../utils/TestBase.sol";
import { InvalidAmount, InvalidReceiver, InformationMismatch, TransferFromFailed, AlreadyInitialized, InvalidConfig, OnlyContractOwner, NotInitialized } from "lifi/Errors/GenericErrors.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Stub OptimismBridgeFacet Contract
contract TestOptimismBridgeFacet is
    OptimismBridgeFacet,
    TestWhitelistManagerBase
{}

contract OptimismBridgeFacetTest is TestBase {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER =
        0xaD0135AF20fa82E106607257143d0060A7eB5cBf;
    address internal constant DAI_L1_ADDRESS =
        0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant DAI_L1_HOLDER =
        0x4943b0C9959dcf58871A799dfB71becE0D97c9f4;
    address internal constant DAI_L2_ADDRESS =
        0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant STANDARD_BRIDGE =
        0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1;
    address internal constant DAI_BRIDGE =
        0x10E6593CDda8c58a1d0f14C5164B376352a55f2F;
    address internal constant UNISWAP_V2_ROUTER =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    uint256 internal constant DSTCHAIN_ID = 10;
    uint32 internal constant L2_GAS = 200000;

    // -----

    TestOptimismBridgeFacet internal optimismBridgeFacet;
    ILiFi.BridgeData internal validBridgeData;
    OptimismBridgeFacet.OptimismData internal validOptimismData;

    event OptimismBridgeRegistered(address indexed assetId, address bridge);

    function setUp() public {
        customBlockNumberForForking = 15876510;
        initTestBase();

        optimismBridgeFacet = new TestOptimismBridgeFacet();

        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = optimismBridgeFacet
            .startBridgeTokensViaOptimismBridge
            .selector;
        functionSelectors[1] = optimismBridgeFacet
            .swapAndStartBridgeTokensViaOptimismBridge
            .selector;
        functionSelectors[2] = optimismBridgeFacet.initOptimism.selector;
        functionSelectors[3] = optimismBridgeFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[4] = optimismBridgeFacet
            .removeAllowedContractSelector
            .selector;
        functionSelectors[5] = optimismBridgeFacet
            .registerOptimismBridge
            .selector;

        addFacet(diamond, address(optimismBridgeFacet), functionSelectors);

        OptimismBridgeFacet.Config[]
            memory configs = new OptimismBridgeFacet.Config[](1);
        configs[0] = OptimismBridgeFacet.Config(DAI_L1_ADDRESS, DAI_BRIDGE);

        optimismBridgeFacet = TestOptimismBridgeFacet(address(diamond));
        optimismBridgeFacet.initOptimism(
            configs,
            IL1StandardBridge(STANDARD_BRIDGE)
        );

        optimismBridgeFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapExactTokensForTokens.selector
        );
        optimismBridgeFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapETHForExactTokens.selector
        );
        optimismBridgeFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapTokensForExactETH.selector
        );

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "optimism",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_L1_ADDRESS,
            receiver: DAI_L1_HOLDER,
            minAmount: 10 * 10 ** dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validOptimismData = OptimismBridgeFacet.OptimismData(
            DAI_L2_ADDRESS,
            L2_GAS,
            false
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(optimismBridgeFacet),
            "OptimismBridgeFacet"
        );
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        dai.transfer(USDC_HOLDER, dai.balanceOf(DAI_L1_HOLDER));

        vm.expectRevert(TransferFromFailed.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            validBridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNoEnoughNativeAsset() public {
        vm.startPrank(DAI_L1_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(InvalidAmount.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge{ value: 2e18 }(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRevertToInitWhenAlreadyInitialized() public {
        OptimismBridgeFacet.Config[]
            memory configs = new OptimismBridgeFacet.Config[](1);
        configs[0] = OptimismBridgeFacet.Config(DAI_L1_ADDRESS, DAI_BRIDGE);

        // Re-initialization should fail
        vm.expectRevert(AlreadyInitialized.selector);
        optimismBridgeFacet.initOptimism(
            configs,
            IL1StandardBridge(STANDARD_BRIDGE)
        );
    }

    function testRevertToInitWhenInvalidConfig() public {
        _mockUninitialized();

        OptimismBridgeFacet.Config[]
            memory configs = new OptimismBridgeFacet.Config[](1);
        configs[0] = OptimismBridgeFacet.Config(DAI_L1_ADDRESS, address(0));

        // Initialization should fail
        vm.expectRevert(InvalidConfig.selector);
        optimismBridgeFacet.initOptimism(
            configs,
            IL1StandardBridge(STANDARD_BRIDGE)
        );
    }

    function testRevertToRegisterWhenNotOwner() public {
        // non-owner
        vm.startPrank(DAI_L1_HOLDER);

        vm.expectRevert(OnlyContractOwner.selector);
        optimismBridgeFacet.registerOptimismBridge(address(1), address(2));

        vm.stopPrank();
    }

    function testRevertToRegisterWhenNotInitialized() public {
        _mockUninitialized();

        vm.expectRevert(NotInitialized.selector);
        optimismBridgeFacet.registerOptimismBridge(address(1), address(2));
    }

    function testRevertToRegisterWhenInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        optimismBridgeFacet.registerOptimismBridge(address(1), address(0));
    }

    function testCanBridgeNativeAsset() public {
        vm.startPrank(DAI_L1_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1e18;

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        optimismBridgeFacet.startBridgeTokensViaOptimismBridge{
            value: bridgeData.minAmount
        }(bridgeData, validOptimismData);

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(DAI_L1_HOLDER);
        dai.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** dai.decimals()
        );

        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            validBridgeData,
            validOptimismData
        );
        vm.stopPrank();
    }

    function testCanBridgeSNX() public {
        address snxToken = 0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F;
        address snxBridge = 0x39Ea01a0298C315d149a490E34B59Dbf2EC7e48F;

        // register custom SNX bridge
        optimismBridgeFacet.registerOptimismBridge(snxToken, snxBridge);

        // approve SNX
        address snxHolder = 0xF977814e90dA44bFA03b6295A0616a897441aceC;
        vm.startPrank(snxHolder);
        ERC20(snxToken).approve(
            address(optimismBridgeFacet),
            validBridgeData.minAmount
        );

        // bridge SNX
        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = snxToken;
        validOptimismData.isSynthetix = true;
        optimismBridgeFacet.startBridgeTokensViaOptimismBridge(
            bridgeData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(
            address(optimismBridgeFacet),
            10_000 * 10 ** usdc.decimals()
        );

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_L1_ADDRESS;

        uint256 amountOut = 1000 * 10 ** dai.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_L1_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(optimismBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        optimismBridgeFacet.swapAndStartBridgeTokensViaOptimismBridge(
            bridgeData,
            swapData,
            validOptimismData
        );

        vm.stopPrank();
    }

    function testRegisterOptimismBridge() public {
        address assetId = makeAddr("asset");
        address bridge = makeAddr("bridge");
        optimismBridgeFacet.registerOptimismBridge(assetId, bridge);

        vm.expectEmit(true, true, true, true, address(optimismBridgeFacet));
        emit OptimismBridgeRegistered(assetId, bridge);

        optimismBridgeFacet.registerOptimismBridge(assetId, bridge);
    }

    function _mockUninitialized() internal {
        // Clear the initialization slot to mock the uninitialized state
        bytes32 baseSlot = keccak256("com.lifi.facets.optimism");
        bytes32 initializedSlot = bytes32(uint256(baseSlot) + 1);
        vm.store(address(diamond), initializedSlot, bytes32(uint256(0)));
    }
}
