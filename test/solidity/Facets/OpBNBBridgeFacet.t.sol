// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { OpBNBBridgeFacet } from "lifi/Facets/OpBNBBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IL1StandardBridge } from "lifi/Interfaces/IL1StandardBridge.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub OpBNBBridgeFacet Contract
contract TestOpBNBBridgeFacet is OpBNBBridgeFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OpBNBBridgeFacetTest is DSTest, DiamondTest {
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

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestOpBNBBridgeFacet internal opBNBBridgeFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    ILiFi.BridgeData internal validBridgeData;
    OpBNBBridgeFacet.OpBNBData internal validOpBNBData;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15876510;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        opBNBBridgeFacet = new TestOpBNBBridgeFacet();
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_L1_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = opBNBBridgeFacet
            .startBridgeTokensViaOpBNBBridge
            .selector;
        functionSelectors[1] = opBNBBridgeFacet
            .swapAndStartBridgeTokensViaOpBNBBridge
            .selector;
        functionSelectors[2] = opBNBBridgeFacet.initOpBNB.selector;
        functionSelectors[3] = opBNBBridgeFacet.addDex.selector;
        functionSelectors[4] = opBNBBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(opBNBBridgeFacet), functionSelectors);

        OpBNBBridgeFacet.Config[]
            memory configs = new OpBNBBridgeFacet.Config[](1);
        configs[0] = OpBNBBridgeFacet.Config(DAI_L1_ADDRESS, DAI_BRIDGE);

        opBNBBridgeFacet = TestOpBNBBridgeFacet(address(diamond));
        opBNBBridgeFacet.initOpBNB(
            configs,
            IL1StandardBridge(STANDARD_BRIDGE)
        );

        opBNBBridgeFacet.addDex(address(uniswap));
        opBNBBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        opBNBBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "opbnb",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_L1_ADDRESS,
            receiver: DAI_L1_HOLDER,
            minAmount: 10 * 10 ** dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validOpBNBData = OpBNBBridgeFacet.OpBNBData(
            DAI_L2_ADDRESS,
            L2_GAS,
            false
        );
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            bridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            bridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        dai.transfer(USDC_HOLDER, dai.balanceOf(DAI_L1_HOLDER));

        vm.expectRevert(
            abi.encodeWithSelector(
                InsufficientBalance.selector,
                10 * 10 ** dai.decimals(),
                0
            )
        );
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            validBridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNoEnoughNativeAsset() public {
        vm.startPrank(DAI_L1_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(InvalidAmount.selector);
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge{ value: 2e18 }(
            bridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            bridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(DAI_L1_HOLDER);
        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            validBridgeData,
            validOpBNBData
        );
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(
            address(opBNBBridgeFacet),
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
                address(opBNBBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        opBNBBridgeFacet.swapAndStartBridgeTokensViaOpBNBBridge(
            bridgeData,
            swapData,
            validOpBNBData
        );

        vm.stopPrank();
    }
}
