// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { Test } from "forge-std/Test.sol";
import { CCIPFacet } from "lifi/Facets/CCIPFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IRouterClient } from "@chainlink-ccip/v0.8/ccip/interfaces/IRouterClient.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub CCIPFacet Contract
contract TestCCIPFacet is CCIPFacet {
    constructor(IRouterClient _routerClient) CCIPFacet(_routerClient) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract FooSwap is Test {
    function swap(
        ERC20 inToken,
        ERC20 outToken,
        uint256 inAmount,
        uint256 outAmount
    ) external {
        inToken.transferFrom(msg.sender, address(this), inAmount);
        deal(address(outToken), msg.sender, outAmount);
    }
}

contract CCIPFacetTest is Test, DiamondTest {
    // These values are for BSC Testnet
    address internal constant USDC_ADDRESS =
        0x64544969ed7EBf5f083679233325356EbE738930;
    address internal constant CCIP_TEST_TOKEN_ADDRESS =
        0x79a4Fc27f69323660f5Bfc12dEe21c3cC14f5901; // CCIP Burn & Mint Test Token
    address internal constant ROUTER_CLIENT =
        0x677311Fd2cCc511Bbc0f581E8d9a07B033D5E840;
    uint256 internal constant DSTCHAIN_ID = 11155111; // Sepolia

    // -----

    LiFiDiamond internal diamond;
    TestCCIPFacet internal ccipFacet;
    ERC20 internal usdc;
    ERC20 internal ccipTestToken;
    ILiFi.BridgeData internal validBridgeData;
    CCIPFacet.CCIPData internal validCCIPData;
    FooSwap internal fooSwap;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_BSC_TESTNET");
        uint256 blockNumber = 33259557;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        ccipFacet = new TestCCIPFacet(IRouterClient(ROUTER_CLIENT));
        ccipTestToken = ERC20(CCIP_TEST_TOKEN_ADDRESS);
        usdc = ERC20(USDC_ADDRESS);
        fooSwap = new FooSwap();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = ccipFacet.startBridgeTokensViaCCIP.selector;
        functionSelectors[1] = ccipFacet
            .swapAndStartBridgeTokensViaCCIP
            .selector;
        functionSelectors[2] = ccipFacet.initCCIP.selector;
        functionSelectors[3] = ccipFacet.addDex.selector;
        functionSelectors[4] = ccipFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(ccipFacet), functionSelectors);

        CCIPFacet.ChainSelector[]
            memory configs = new CCIPFacet.ChainSelector[](2);
        configs[0] = CCIPFacet.ChainSelector(97, 13264668187771770619); // BSC Testnet
        configs[1] = CCIPFacet.ChainSelector(11155111, 16015286601757825753); // Sepolia

        ccipFacet = TestCCIPFacet(address(diamond));
        ccipFacet.initCCIP(configs);

        ccipFacet.addDex(address(fooSwap));
        ccipFacet.setFunctionApprovalBySignature(fooSwap.swap.selector);

        vm.label(CCIP_TEST_TOKEN_ADDRESS, "CCIP Test Token");
        vm.label(USDC_ADDRESS, "USDC Token");
        vm.label(ROUTER_CLIENT, "CCIP Router");

        validBridgeData = ILiFi.BridgeData({
            transactionId: "ccipId",
            bridge: "ccip",
            integrator: "",
            referrer: address(0),
            sendingAssetId: CCIP_TEST_TOKEN_ADDRESS,
            receiver: address(this),
            minAmount: 10 * 10 ** ccipTestToken.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validCCIPData = CCIPFacet.CCIPData("", "");
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        deal(
            address(ccipTestToken),
            address(this),
            10 * 10 ** ccipTestToken.decimals()
        );

        ccipTestToken.approve(
            address(ccipFacet),
            10_000 * 10 ** ccipTestToken.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        ccipFacet.startBridgeTokensViaCCIP(bridgeData, validCCIPData);
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        deal(
            address(ccipTestToken),
            address(this),
            10 * 10 ** ccipTestToken.decimals()
        );

        ccipTestToken.approve(
            address(ccipFacet),
            10_000 * 10 ** ccipTestToken.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        ccipFacet.startBridgeTokensViaCCIP(bridgeData, validCCIPData);
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        deal(
            address(ccipTestToken),
            address(this),
            10 * 10 ** ccipTestToken.decimals()
        );

        ccipTestToken.approve(
            address(ccipFacet),
            10_000 * 10 ** ccipTestToken.decimals()
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        ccipFacet.startBridgeTokensViaCCIP(bridgeData, validCCIPData);
    }

    function testCanBridgeERC20Tokens() public {
        deal(
            address(ccipTestToken),
            address(this),
            10 * 10 ** ccipTestToken.decimals()
        );

        ccipTestToken.approve(
            address(ccipFacet),
            10_000 * 10 ** ccipTestToken.decimals()
        );

        ccipFacet.startBridgeTokensViaCCIP(validBridgeData, validCCIPData);
    }

    function testCanSwapAndBridgeTokens() public {
        usdc.approve(address(ccipFacet), 10_000 * 10 ** usdc.decimals());
        deal(
            address(ccipTestToken),
            address(this),
            10 * 10 ** ccipTestToken.decimals()
        );

        ccipTestToken.approve(
            address(ccipFacet),
            10_000 * 10 ** ccipTestToken.decimals()
        );

        uint256 inAmount = 10_000 * 10 ** usdc.decimals();
        uint256 outAmount = 10_000 * 10 ** ccipTestToken.decimals();

        // Calculate DAI amount
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(fooSwap),
            address(fooSwap),
            USDC_ADDRESS,
            CCIP_TEST_TOKEN_ADDRESS,
            inAmount,
            abi.encodeWithSelector(
                fooSwap.swap.selector,
                ERC20(USDC_ADDRESS),
                ERC20(CCIP_TEST_TOKEN_ADDRESS),
                inAmount,
                outAmount
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        ccipFacet.swapAndStartBridgeTokensViaCCIP(
            bridgeData,
            swapData,
            validCCIPData
        );

        vm.stopPrank();
    }
}
