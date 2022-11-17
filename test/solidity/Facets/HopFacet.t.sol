// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub HopFacet Contract
contract TestHopFacet is HopFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetTest is DSTest, DiamondTest {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_BRIDGE = 0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant USDC_HOLDER = 0xaD0135AF20fa82E106607257143d0060A7eB5cBf;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant DAI_BRIDGE = 0x3d4Cc8A61c7528Fd86C55cfe061a78dCBA48EDd1;
    address internal constant DAI_HOLDER = 0x4943b0C9959dcf58871A799dfB71becE0D97c9f4;
    address internal constant CONNEXT_HANDLER = 0xB4C1340434920d70aD774309C75f9a4B679d801e;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    uint256 internal constant DSTCHAIN_ID = 137;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestHopFacet internal hopFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    ILiFi.BridgeData internal validBridgeData;
    HopFacet.HopData internal validHopData;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15876510;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        hopFacet = new TestHopFacet();
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = hopFacet.startBridgeTokensViaHop.selector;
        functionSelectors[1] = hopFacet.swapAndStartBridgeTokensViaHop.selector;
        functionSelectors[2] = hopFacet.initHop.selector;
        functionSelectors[3] = hopFacet.registerBridge.selector;
        functionSelectors[4] = hopFacet.addDex.selector;
        functionSelectors[5] = hopFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        HopFacet.Config[] memory configs = new HopFacet.Config[](2);
        configs[0] = HopFacet.Config(USDC_ADDRESS, USDC_BRIDGE);
        configs[1] = HopFacet.Config(DAI_ADDRESS, DAI_BRIDGE);

        hopFacet = TestHopFacet(address(diamond));
        hopFacet.initHop(configs);

        hopFacet.addDex(address(uniswap));
        hopFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        hopFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "hop",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_ADDRESS,
            receiver: DAI_HOLDER,
            minAmount: 10 * 10**dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validHopData = HopFacet.HopData(
            0,
            0,
            block.timestamp + 60 * 20,
            9 * 10**dai.decimals(),
            block.timestamp + 60 * 20
        );
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(hopFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        hopFacet.startBridgeTokensViaHop(bridgeData, validHopData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(hopFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        hopFacet.startBridgeTokensViaHop(bridgeData, validHopData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(hopFacet), 10_000 * 10**dai.decimals());

        dai.transfer(USDC_HOLDER, dai.balanceOf(DAI_HOLDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, 10 * 10**dai.decimals(), 0));
        hopFacet.startBridgeTokensViaHop(validBridgeData, validHopData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(hopFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        hopFacet.startBridgeTokensViaHop(bridgeData, validHopData);

        vm.stopPrank();
    }

    function testCanBridgeTokens() public {
        vm.startPrank(DAI_HOLDER);
        dai.approve(address(hopFacet), 10_000 * 10**dai.decimals());

        hopFacet.startBridgeTokensViaHop(validBridgeData, validHopData);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(hopFacet), 10_000 * 10**usdc.decimals());

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;

        uint256 amountOut = 10 * 10**dai.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(hopFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        hopFacet.swapAndStartBridgeTokensViaHop(bridgeData, swapData, validHopData);

        vm.stopPrank();
    }
}
