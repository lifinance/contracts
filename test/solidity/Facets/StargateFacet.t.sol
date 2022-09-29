// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IStargateRouter } from "lifi/Interfaces/IStargateRouter.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";

// Stub CBridgeFacet Contract
contract TestStargateFacet is StargateFacet {
    /// @notice Initialize the contract.
    /// @param _router The contract address of the stargate router on the source chain.
    constructor(IStargateRouter _router) StargateFacet(_router) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract StargateFacetTest is DSTest, DiamondTest {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER = 0xee5B5B923fFcE93A870B3104b7CA09c3db80047A;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant MAINNET_ROUTER = 0x8731d54E9D02c286767d56ac03e8037C07e01e98;
    address internal constant DAI_HOLDER = 0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestStargateFacet internal stargate;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    FeeCollector internal feeCollector;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15588208;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        stargate = new TestStargateFacet(IStargateRouter(MAINNET_ROUTER));
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);
        feeCollector = new FeeCollector(address(this));

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = stargate.startBridgeTokensViaStargate.selector;
        functionSelectors[1] = stargate.swapAndStartBridgeTokensViaStargate.selector;
        functionSelectors[2] = stargate.setLayerZeroChainId.selector;
        functionSelectors[3] = stargate.setStargatePoolId.selector;
        functionSelectors[4] = stargate.quoteLayerZeroFee.selector;
        functionSelectors[5] = stargate.addDex.selector;
        functionSelectors[6] = stargate.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(stargate), functionSelectors);

        stargate = TestStargateFacet(address(diamond));
        stargate.setLayerZeroChainId(1, 101);
        stargate.setLayerZeroChainId(137, 109);
        stargate.setStargatePoolId(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 1);
        stargate.setStargatePoolId(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174, 1);

        stargate.addDex(address(uniswap));
        stargate.addDex(address(feeCollector));
        stargate.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        stargate.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        stargate.setFunctionApprovalBySignature(feeCollector.collectNativeFees.selector);
        stargate.setFunctionApprovalBySignature(feeCollector.collectTokenFees.selector);
    }

    function testCanGetFees() public {
        vm.startPrank(USDC_HOLDER);
        StargateFacet.StargateData memory stargateData = StargateFacet.StargateData(
            2,
            100,
            0,
            abi.encodePacked(USDC_HOLDER),
            ""
        );
        stargate.quoteLayerZeroFee(137, stargateData);
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(stargate), 10_000 * 10**usdc.decimals());

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "stargate",
            "",
            address(0),
            USDC_ADDRESS,
            USDC_HOLDER,
            10,
            137,
            false,
            false
        );
        StargateFacet.StargateData memory data = StargateFacet.StargateData(
            1,
            9,
            0,
            abi.encodePacked(address(0)),
            abi.encode(bridgeData, new LibSwap.SwapData[](0), USDC_ADDRESS, USDC_HOLDER)
        );

        (uint256 fees, ) = stargate.quoteLayerZeroFee(137, data);
        stargate.startBridgeTokensViaStargate{ value: fees }(bridgeData, data);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeERC20Tokens() public {
        vm.startPrank(DAI_HOLDER);
        dai.approve(address(stargate), 10_000 * 10**dai.decimals());

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        uint256 amountOut = 10 * 10**usdc.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(stargate),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "stargate",
            "",
            address(0),
            USDC_ADDRESS,
            DAI_HOLDER,
            9,
            137,
            true,
            true
        );
        StargateFacet.StargateData memory data = StargateFacet.StargateData(
            1,
            9,
            0,
            abi.encodePacked(address(0)),
            abi.encode(bridgeData, swapData, USDC_ADDRESS, DAI_HOLDER)
        );

        (uint256 fees, ) = stargate.quoteLayerZeroFee(137, data);
        stargate.swapAndStartBridgeTokensViaStargate{ value: fees }(bridgeData, swapData, data);
        vm.stopPrank();
    }

    function testCanCollectFeesAndBridgeERC20Tokens() public {
        vm.startPrank(DAI_HOLDER);

        uint256 amountToBridge = 10 * 10**usdc.decimals();
        uint256 fee = 0.001 ether;
        uint256 lifiFee = 0.00015 ether;

        // Calculate USDC amount
        address[] memory path = new address[](2);
        path[0] = WETH_ADDRESS;
        path[1] = USDC_ADDRESS;
        uint256[] memory amounts = uniswap.getAmountsIn(amountToBridge, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            address(0),
            address(0),
            fee + lifiFee,
            abi.encodeWithSelector(feeCollector.collectNativeFees.selector, fee, lifiFee, address(0xb33f)),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapETHForExactTokens.selector,
                amountToBridge,
                path,
                address(stargate),
                block.timestamp
            ),
            false
        );

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "stargate",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ADDRESS,
            receiver: DAI_HOLDER,
            minAmount: 9 * 10**usdc.decimals(),
            destinationChainId: 137,
            hasSourceSwaps: true,
            hasDestinationCall: true
        });
        StargateFacet.StargateData memory data = StargateFacet.StargateData({
            dstPoolId: 1,
            minAmountLD: 7 * 10**usdc.decimals(),
            dstGasForCall: 0,
            callTo: abi.encodePacked(address(0)),
            callData: abi.encode(bridgeData, swapData, USDC_ADDRESS, DAI_HOLDER)
        });

        (uint256 fees, ) = stargate.quoteLayerZeroFee(137, data);
        console.log(fees);
        stargate.swapAndStartBridgeTokensViaStargate{ value: fees + amountIn + fee + lifiFee }(
            bridgeData,
            swapData,
            data
        );
        vm.stopPrank();

        assertEq(feeCollector.getTokenBalance(address(0xb33f), address(0)), fee);
        assertEq(feeCollector.getLifiTokenBalance(address(0)), lifiFee);
        assertEq(address(stargate).balance, 0);
        assertEq(usdc.balanceOf(address(stargate)), 0);
    }
}
