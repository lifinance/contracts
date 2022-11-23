// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { DeBridgeFacet } from "lifi/Facets/DeBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IDeBridgeGate } from "lifi/Interfaces/IDeBridgeGate.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub DeBridgeFacet Contract
contract TestDeBridgeFacet is DeBridgeFacet {
    constructor(IDeBridgeGate _deBridgeGate) DeBridgeFacet(_deBridgeGate) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract DeBridgeFacetTest is DSTest, DiamondTest {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER = 0xaD0135AF20fa82E106607257143d0060A7eB5cBf;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant DAI_HOLDER = 0x4943b0C9959dcf58871A799dfB71becE0D97c9f4;
    address internal constant DEBRIDGE_GATE = 0x43dE2d77BF8027e25dBD179B491e8d64f38398aA;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    uint256 internal constant DSTCHAIN_ID = 42161;
    uint256 public constant REVERT_IF_EXTERNAL_FAIL = 1;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestDeBridgeFacet internal deBridgeFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    ILiFi.BridgeData internal validBridgeData;
    DeBridgeFacet.DeBridgeData internal validDeBridgeData;
    IDeBridgeGate.SubmissionAutoParamsTo internal autoparam;
    uint256 internal nativeFee;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15876510;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        deBridgeFacet = new TestDeBridgeFacet(IDeBridgeGate(DEBRIDGE_GATE));
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = deBridgeFacet.startBridgeTokensViaDeBridge.selector;
        functionSelectors[1] = deBridgeFacet.swapAndStartBridgeTokensViaDeBridge.selector;
        functionSelectors[2] = deBridgeFacet.addDex.selector;
        functionSelectors[3] = deBridgeFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(deBridgeFacet), functionSelectors);

        deBridgeFacet = TestDeBridgeFacet(address(diamond));

        deBridgeFacet.addDex(address(uniswap));
        deBridgeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        deBridgeFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "debridge",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ADDRESS,
            receiver: USDC_HOLDER,
            minAmount: 10 * 10**usdc.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        autoparam = IDeBridgeGate.SubmissionAutoParamsTo({
            executionFee: 0,
            flags: REVERT_IF_EXTERNAL_FAIL,
            fallbackAddress: DAI_HOLDER,
            data: ""
        });

        IDeBridgeGate.ChainSupportInfo memory chainConfig = IDeBridgeGate(DEBRIDGE_GATE).getChainToConfig(DSTCHAIN_ID);
        nativeFee = chainConfig.fixedNativeFee == 0
            ? IDeBridgeGate(DEBRIDGE_GATE).globalFixedNativeFee()
            : chainConfig.fixedNativeFee;
        validDeBridgeData = DeBridgeFacet.DeBridgeData("", false, nativeFee, 0, autoparam);
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(deBridgeFacet), 10_000 * 10**usdc.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        deBridgeFacet.startBridgeTokensViaDeBridge(bridgeData, validDeBridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(deBridgeFacet), 10_000 * 10**usdc.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        deBridgeFacet.startBridgeTokensViaDeBridge(bridgeData, validDeBridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(deBridgeFacet), 10_000 * 10**usdc.decimals());

        usdc.transfer(DAI_HOLDER, usdc.balanceOf(USDC_HOLDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, 10 * 10**usdc.decimals(), 0));
        deBridgeFacet.startBridgeTokensViaDeBridge(validBridgeData, validDeBridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNoEnoughNativeAsset() public {
        vm.startPrank(USDC_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(InvalidAmount.selector);
        deBridgeFacet.startBridgeTokensViaDeBridge{ value: 2e18 }(bridgeData, validDeBridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(deBridgeFacet), 10_000 * 10**usdc.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        deBridgeFacet.startBridgeTokensViaDeBridge(bridgeData, validDeBridgeData);

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(deBridgeFacet), 10_000 * 10**usdc.decimals());

        deBridgeFacet.startBridgeTokensViaDeBridge{ value: nativeFee }(validBridgeData, validDeBridgeData);

        vm.stopPrank();
    }

    function testCanBridgeNativeTokens() public {
        vm.startPrank(USDC_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        deBridgeFacet.startBridgeTokensViaDeBridge{ value: 3e18 + nativeFee }(bridgeData, validDeBridgeData);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(DAI_HOLDER);

        dai.approve(address(deBridgeFacet), 10_000 * 10**dai.decimals());

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        uint256 amountOut = 1000 * 10**usdc.decimals();

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
                address(deBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        deBridgeFacet.swapAndStartBridgeTokensViaDeBridge{ value: nativeFee }(bridgeData, swapData, validDeBridgeData);

        vm.stopPrank();
    }
}
