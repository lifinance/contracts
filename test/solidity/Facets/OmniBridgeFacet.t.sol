// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { OmniBridgeFacet } from "lifi/Facets/OmniBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IOmniBridge } from "lifi/Interfaces/IOmniBridge.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub OmniBridgeFacet Contract
contract TestOmniBridgeFacet is OmniBridgeFacet {
    constructor(IOmniBridge _foreignOmniBridge, IOmniBridge _wethOmniBridge)
        OmniBridgeFacet(_foreignOmniBridge, _wethOmniBridge)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OmniBridgeFacetTest is DSTest, DiamondTest {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER = 0xaD0135AF20fa82E106607257143d0060A7eB5cBf;
    address internal constant DAI_L1_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant DAI_L1_HOLDER = 0x4943b0C9959dcf58871A799dfB71becE0D97c9f4;
    address internal constant FOREIGN_BRIDGE = 0x88ad09518695c6c3712AC10a214bE5109a655671;
    address internal constant WETH_BRIDGE = 0xa6439Ca0FCbA1d0F80df0bE6A17220feD9c9038a;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    uint256 internal constant DSTCHAIN_ID = 100;

    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestOmniBridgeFacet internal omniBridgeFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    ILiFi.BridgeData internal validBridgeData;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15876510;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        omniBridgeFacet = new TestOmniBridgeFacet(IOmniBridge(FOREIGN_BRIDGE), IOmniBridge(WETH_BRIDGE));
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_L1_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = omniBridgeFacet.startBridgeTokensViaOmniBridge.selector;
        functionSelectors[1] = omniBridgeFacet.swapAndStartBridgeTokensViaOmniBridge.selector;
        functionSelectors[2] = omniBridgeFacet.addDex.selector;
        functionSelectors[3] = omniBridgeFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(omniBridgeFacet), functionSelectors);

        omniBridgeFacet = TestOmniBridgeFacet(address(diamond));

        omniBridgeFacet.addDex(address(uniswap));
        omniBridgeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        omniBridgeFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "omni",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_L1_ADDRESS,
            receiver: DAI_L1_HOLDER,
            minAmount: 10 * 10**dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(omniBridgeFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        omniBridgeFacet.startBridgeTokensViaOmniBridge(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(omniBridgeFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        omniBridgeFacet.startBridgeTokensViaOmniBridge(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(omniBridgeFacet), 10_000 * 10**dai.decimals());

        dai.transfer(USDC_HOLDER, dai.balanceOf(DAI_L1_HOLDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, 10 * 10**dai.decimals(), 0));
        omniBridgeFacet.startBridgeTokensViaOmniBridge(validBridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNoEnoughNativeAsset() public {
        vm.startPrank(DAI_L1_HOLDER);

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(InvalidAmount.selector);
        omniBridgeFacet.startBridgeTokensViaOmniBridge{ value: 2e18 }(bridgeData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(omniBridgeFacet), 10_000 * 10**dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        omniBridgeFacet.startBridgeTokensViaOmniBridge(bridgeData);

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(DAI_L1_HOLDER);
        dai.approve(address(omniBridgeFacet), 10_000 * 10**dai.decimals());

        omniBridgeFacet.startBridgeTokensViaOmniBridge(validBridgeData);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(omniBridgeFacet), 10_000 * 10**usdc.decimals());

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_L1_ADDRESS;

        uint256 amountOut = 1000 * 10**dai.decimals();

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
                address(omniBridgeFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        omniBridgeFacet.swapAndStartBridgeTokensViaOmniBridge(bridgeData, swapData);

        vm.stopPrank();
    }
}
