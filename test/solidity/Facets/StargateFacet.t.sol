// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, LiFiDiamond } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner, InvalidConfig, AlreadyInitialized } from "src/Errors/GenericErrors.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";
import { IStargateRouter } from "lifi/Interfaces/IStargateRouter.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

// Stub StargateFacet Contract
contract TestStargateFacet is StargateFacet {
    /// @notice Initialize the contract.
    /// @param _router The contract address of the stargatefacet router on the source chain.
    /// @param _nativeRouter The contract address of the native stargatefacet router on the source chain.
    constructor(
        IStargateRouter _router,
        IStargateRouter _nativeRouter
    ) StargateFacet(_router, _nativeRouter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract StargateFacetTest is TestBaseFacet {
    // EVENTS
    event LayerZeroChainIdSet(
        uint256 indexed chainId,
        uint16 layerZeroChainId
    );

    // These values are for Mainnet
    address internal constant WETH_ADDRESS =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant MAINNET_ROUTER =
        0x8731d54E9D02c286767d56ac03e8037C07e01e98;
    address internal constant MAINNET_NATIVE_ROUTER =
        0xb1b2eeF380f21747944f46d28f683cD1FBB4d03c;
    uint256 internal constant DST_CHAIN_ID = 137;
    // -----

    TestStargateFacet internal stargateFacet;
    FeeCollector internal feeCollector;
    StargateFacet.StargateData internal stargateData;
    uint256 internal nativeAddToMessageValue;

    function setUp() public {
        // set custom block number for forking
        customBlockNumberForForking = 17661386;

        initTestBase();

        stargateFacet = new TestStargateFacet(
            IStargateRouter(MAINNET_ROUTER),
            IStargateRouter(MAINNET_NATIVE_ROUTER)
        );
        feeCollector = new FeeCollector(address(this));

        bytes4[] memory functionSelectors = new bytes4[](8);
        functionSelectors[0] = stargateFacet.initStargate.selector;
        functionSelectors[1] = stargateFacet
            .startBridgeTokensViaStargate
            .selector;
        functionSelectors[2] = stargateFacet
            .swapAndStartBridgeTokensViaStargate
            .selector;
        functionSelectors[3] = stargateFacet.setLayerZeroChainId.selector;
        functionSelectors[4] = stargateFacet.quoteLayerZeroFee.selector;
        functionSelectors[5] = stargateFacet.addDex.selector;
        functionSelectors[6] = stargateFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(stargateFacet), functionSelectors);

        StargateFacet.ChainIdConfig[]
            memory chainIdConfig = new StargateFacet.ChainIdConfig[](3);
        chainIdConfig[0] = StargateFacet.ChainIdConfig(1, 101);
        chainIdConfig[1] = StargateFacet.ChainIdConfig(137, 109);
        chainIdConfig[2] = StargateFacet.ChainIdConfig(10, 111);

        stargateFacet = TestStargateFacet(address(diamond));
        stargateFacet.initStargate(chainIdConfig);

        stargateFacet.addDex(address(uniswap));
        stargateFacet.addDex(address(feeCollector));
        stargateFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        stargateFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        stargateFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        stargateFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        stargateFacet.setFunctionApprovalBySignature(
            feeCollector.collectNativeFees.selector
        );
        stargateFacet.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );

        setFacetAddressInTestBase(address(stargateFacet), "StargateFacet");

        bridgeData.bridge = "stargate";
        bridgeData.minAmount = defaultUSDCAmount;

        stargateData = StargateFacet.StargateData({
            srcPoolId: 1,
            dstPoolId: 1,
            minAmountLD: (defaultUSDCAmount * 90) / 100,
            dstGasForCall: 0,
            lzFee: 0,
            refundAddress: payable(USER_REFUND),
            callTo: abi.encodePacked(address(0)),
            callData: ""
        });
        (uint256 fees, ) = stargateFacet.quoteLayerZeroFee(
            DST_CHAIN_ID,
            stargateData
        );
        stargateData.lzFee = addToMessageValue = fees;

        // No native route to Polygon so we use Optimism
        (uint256 nativeFees, ) = stargateFacet.quoteLayerZeroFee(
            10, // Optimism chainId
            stargateData
        );
        nativeAddToMessageValue = nativeFees;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            stargateFacet.startBridgeTokensViaStargate{
                value: bridgeData.minAmount
            }(bridgeData, stargateData);
        } else {
            stargateFacet.startBridgeTokensViaStargate{
                value: addToMessageValue
            }(bridgeData, stargateData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        stargateFacet.swapAndStartBridgeTokensViaStargate{
            value: addToMessageValue
        }(bridgeData, swapData, stargateData);
    }

    /// Overrides ///

    function testBase_CanBridgeNativeTokens()
        public
        override
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((defaultNativeAmount))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;
        bridgeData.destinationChainId = 10;

        stargateData.minAmountLD = (defaultNativeAmount * 90) / 100;
        stargateData.lzFee = nativeAddToMessageValue;
        addToMessageValue = 0;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
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
        bridgeData.destinationChainId = 10;

        stargateData.lzFee = nativeAddToMessageValue;

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WETH;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;
        stargateData.minAmountLD = (amountOut * 90) / 100;
        addToMessageValue = 0;

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
                    block.timestamp + 20 seconds
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

    function test_revert_SetLayerZeroChainIdAsNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        stargateFacet.setLayerZeroChainId(123, 456);
    }

    function test_SetLayerZeroChainIdAsOwner() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        vm.expectEmit(true, true, true, true, address(stargateFacet));
        emit LayerZeroChainIdSet(123, 456);
        stargateFacet.setLayerZeroChainId(123, 456);
    }

    function test_revert_InitializeAgain() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        StargateFacet.ChainIdConfig[]
            memory chainIdConfig = new StargateFacet.ChainIdConfig[](2);
        chainIdConfig[0] = StargateFacet.ChainIdConfig(1, 101);
        chainIdConfig[1] = StargateFacet.ChainIdConfig(137, 109);

        vm.expectRevert(AlreadyInitialized.selector);
        stargateFacet.initStargate(chainIdConfig);
    }

    function test_revert_InitializeAsNonOwner() public {
        LiFiDiamond diamond2 = createDiamond();
        stargateFacet = new TestStargateFacet(
            IStargateRouter(MAINNET_ROUTER),
            IStargateRouter(MAINNET_NATIVE_ROUTER)
        );
        feeCollector = new FeeCollector(address(this));

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = stargateFacet.initStargate.selector;
        functionSelectors[1] = stargateFacet
            .startBridgeTokensViaStargate
            .selector;
        functionSelectors[2] = stargateFacet
            .swapAndStartBridgeTokensViaStargate
            .selector;
        functionSelectors[3] = stargateFacet.setLayerZeroChainId.selector;
        functionSelectors[4] = stargateFacet.quoteLayerZeroFee.selector;
        functionSelectors[5] = stargateFacet.addDex.selector;
        functionSelectors[6] = stargateFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond2, address(stargateFacet), functionSelectors);

        StargateFacet.ChainIdConfig[]
            memory chainIdConfig = new StargateFacet.ChainIdConfig[](2);
        chainIdConfig[0] = StargateFacet.ChainIdConfig(1, 101);
        chainIdConfig[1] = StargateFacet.ChainIdConfig(137, 109);

        stargateFacet = TestStargateFacet(address(diamond2));

        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);
        stargateFacet.initStargate(chainIdConfig);
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // fails otherwise with "slippage too high" from Stargate router contract
        vm.assume(amount > 100);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }

    function test_revert_invalidSrcPool() public {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // invalid data
        stargateData.srcPoolId = 100;

        vm.expectRevert();

        stargateFacet.startBridgeTokensViaStargate{ value: addToMessageValue }(
            bridgeData,
            stargateData
        );

        vm.stopPrank();
    }

    function test_revert_invalidDestPool() public {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // invalid data
        stargateData.dstPoolId = 100;

        vm.expectRevert();

        stargateFacet.startBridgeTokensViaStargate{ value: addToMessageValue }(
            bridgeData,
            stargateData
        );

        vm.stopPrank();
    }
}
