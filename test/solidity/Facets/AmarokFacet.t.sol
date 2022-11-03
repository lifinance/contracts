// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IConnextHandler } from "lifi/Interfaces/IConnextHandler.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub AmarokFacet Contract
contract TestAmarokFacet is AmarokFacet {
    constructor(IConnextHandler _connextHandler, uint32 _srcChainDomain)
        AmarokFacet(_connextHandler, _srcChainDomain)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AmarokFacetTest is DSTest, DiamondTest {
    // These values are for Goerli
    address internal constant USDC_ADDRESS = 0x98339D8C260052B7ad81c28c16C0b98420f2B46a;
    address internal constant USDC_HOLDER = 0x9Dc99fAf98d363Ec0909D1f5C3627dDdEA2a85D4;
    address internal constant TOKEN_ADDRESS = 0x7ea6eA49B0b0Ae9c5db7907d139D9Cd3439862a1;
    address internal constant TOKEN_HOLDER = 0x54BAA998771639628ffC0206c3b916c466b79c89;
    address internal constant CONNEXT_HANDLER = 0xB4C1340434920d70aD774309C75f9a4B679d801e;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    uint32 internal constant DOMAIN = 1735353714;
    uint256 internal constant DSTCHAIN_ID = 420;
    uint32 internal constant DSTCHAIN_DOMAIN = 1735356532;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestAmarokFacet internal amarokFacet;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal token;
    ILiFi.BridgeData internal validBridgeData;
    AmarokFacet.AmarokData internal validAmarokData;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_GOERLI");
        uint256 blockNumber = 7487011;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        amarokFacet = new TestAmarokFacet(IConnextHandler(CONNEXT_HANDLER), DOMAIN);
        usdc = ERC20(USDC_ADDRESS);
        token = ERC20(TOKEN_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = amarokFacet.startBridgeTokensViaAmarok.selector;
        functionSelectors[1] = amarokFacet.swapAndStartBridgeTokensViaAmarok.selector;
        functionSelectors[2] = amarokFacet.setAmarokDomain.selector;
        functionSelectors[3] = amarokFacet.addDex.selector;
        functionSelectors[4] = amarokFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(amarokFacet), functionSelectors);

        amarokFacet = TestAmarokFacet(address(diamond));
        amarokFacet.setAmarokDomain(DSTCHAIN_ID, DSTCHAIN_DOMAIN);

        amarokFacet.addDex(address(uniswap));
        amarokFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        amarokFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "amarok",
            integrator: "",
            referrer: address(0),
            sendingAssetId: TOKEN_ADDRESS,
            receiver: TOKEN_HOLDER,
            minAmount: 10 * 10**token.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validAmarokData = AmarokFacet.AmarokData("", false, false, address(0), 0, 0, 9995, 0);
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(TOKEN_HOLDER);

        token.approve(address(amarokFacet), 10_000 * 10**token.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        amarokFacet.startBridgeTokensViaAmarok(bridgeData, validAmarokData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(TOKEN_HOLDER);

        token.approve(address(amarokFacet), 10_000 * 10**token.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        amarokFacet.startBridgeTokensViaAmarok(bridgeData, validAmarokData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSenderHasNoEnoughAmount() public {
        vm.startPrank(TOKEN_HOLDER);

        token.approve(address(amarokFacet), 10_000 * 10**token.decimals());

        token.transfer(USDC_HOLDER, token.balanceOf(TOKEN_HOLDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, 10 * 10**token.decimals(), 0));
        amarokFacet.startBridgeTokensViaAmarok(validBridgeData, validAmarokData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenSendingNativeAsset() public {
        vm.startPrank(TOKEN_HOLDER);

        token.approve(address(amarokFacet), 10_000 * 10**token.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 3e18;

        vm.expectRevert(NativeAssetNotSupported.selector);
        amarokFacet.startBridgeTokensViaAmarok(bridgeData, validAmarokData);

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(TOKEN_HOLDER);

        token.approve(address(amarokFacet), 10_000 * 10**token.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        amarokFacet.startBridgeTokensViaAmarok(bridgeData, validAmarokData);

        vm.stopPrank();
    }

    function testCanBridgeTokens() public {
        vm.startPrank(TOKEN_HOLDER);
        token.approve(address(amarokFacet), 10_000 * 10**token.decimals());

        amarokFacet.startBridgeTokensViaAmarok(validBridgeData, validAmarokData);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(address(amarokFacet), 10_000 * 10**usdc.decimals());

        // Swap USDC to TOKEN
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = TOKEN_ADDRESS;

        uint256 amountOut = 10 * 10**token.decimals();

        // Calculate TOKEN amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            TOKEN_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(amarokFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        amarokFacet.swapAndStartBridgeTokensViaAmarok(bridgeData, swapData, validAmarokData);

        vm.stopPrank();
    }
}
