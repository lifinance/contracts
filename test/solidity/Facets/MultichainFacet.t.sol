// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console, InvalidAmount, ERC20 } from "../utils/TestBase.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized } from "src/Errors/GenericErrors.sol";
import { IMultichainRouter } from "lifi/Interfaces/IMultichainRouter.sol";
import { MultichainFacet, IMultichainToken } from "lifi/Facets/MultichainFacet.sol";

// import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub MultichainFacet Contract
contract TestMultichainFacet is MultichainFacet {
    constructor() {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MultichainFacetTest is TestBase {
    address internal constant ANYSWAPV4ROUTER = 0x6b7a87899490EcE95443e979cA9485CBE7E71522;
    address internal constant ADDRESS_ANYUSDC = 0x7EA2be2df7BA6E54B1A9C70676f668455E329d29;
    address internal constant ADDRESS_ANYWETH = 0x2AC03BF434db503f6f5F85C3954773731Fc3F056;
    address internal constant USER_TESTTOKEN_WHALE = 0x5E583B6a1686f7Bc09A6bBa66E852A7C80d36F00;

    // events
    event LogSwapout(address indexed account, address indexed bindaddr, uint256 amount);
    event LogAnySwapOut(
        address indexed token,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 fromChainID,
        uint256 toChainID
    );

    TestMultichainFacet internal multichainFacet;
    address[] public routers;
    MultichainFacet.MultichainData internal multichainData;
    ERC20 internal testToken;
    ERC20 internal underlyingToken;

    function setUp() public {
        initTestBase();

        // get test token (cannot just test with USDC or DAI)
        testToken = ERC20(ADDRESS_ANYUSDC);

        multichainFacet = new TestMultichainFacet();

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = multichainFacet.startBridgeTokensViaMultichain.selector;
        functionSelectors[1] = multichainFacet.swapAndStartBridgeTokensViaMultichain.selector;
        functionSelectors[2] = bytes4(keccak256("registerBridge(address,bool)"));
        functionSelectors[3] = bytes4(keccak256("registerBridge(address[],bool[])"));
        functionSelectors[4] = multichainFacet.addDex.selector;
        functionSelectors[5] = multichainFacet.initMultichain.selector;
        functionSelectors[6] = multichainFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(multichainFacet), functionSelectors);
        multichainFacet = TestMultichainFacet(address(diamond));
        routers = [
            ANYSWAPV4ROUTER,
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B // AnyswapV6Router
        ];
        multichainFacet.initMultichain(routers);

        multichainFacet.addDex(address(uniswap));
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForETH.selector);
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        setFacetAddressInTestBase(address(multichainFacet));

        // adjust bridgeData
        bridgeData.integrator = "multichain";
        bridgeData.sendingAssetId = ADDRESS_ANYUSDC; //anyUSDC
        bridgeData.destinationChainId = 250;
        bridgeData.minAmount = 50 * 10**testToken.decimals();

        // produce valid HopData
        multichainData = MultichainFacet.MultichainData({ router: ANYSWAPV4ROUTER });

        // get underlying token and approve
        vm.startPrank(USER_TESTTOKEN_WHALE);
        underlyingToken = ERC20(IMultichainToken(ADDRESS_ANYUSDC).underlying());
        underlyingToken.approve(address(multichainFacet), bridgeData.minAmount);
        vm.stopPrank();
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            multichainFacet.startBridgeTokensViaMultichain{ value: bridgeData.minAmount }(bridgeData, multichainData);
        } else {
            multichainFacet.startBridgeTokensViaMultichain(bridgeData, multichainData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            multichainFacet.swapAndStartBridgeTokensViaMultichain{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData,
                multichainData
            );
        } else {
            multichainFacet.swapAndStartBridgeTokensViaMultichain(bridgeData, swapData, multichainData);
        }
    }

    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(ADDRESS_ANYUSDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        //reference: https://etherscan.io/tx/0x46a6cfe25b91f9795b08ffee39a3230b4a36c2f8fdcd67b14dfa95f2da681d28
        vm.expectEmit(true, true, true, true, multichainData.router);
        emit LogAnySwapOut(
            address(testToken),
            address(multichainFacet),
            bridgeData.receiver,
            bridgeData.minAmount,
            1,
            bridgeData.destinationChainId
        );

        vm.startPrank(USER_TESTTOKEN_WHALE);
        multichainFacet.startBridgeTokensViaMultichain(bridgeData, multichainData);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens()
        public
        override
        assertBalanceChange(address(0), USER_SENDER, -(1 ether))
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        //reference: https://etherscan.io/tx/0x46a6cfe25b91f9795b08ffee39a3230b4a36c2f8fdcd67b14dfa95f2da681d28
        bridgeData.sendingAssetId = ADDRESS_ANYWETH;
        bridgeData.minAmount = 1 ether;

        multichainData = MultichainFacet.MultichainData(routers[2]);

        vm.expectEmit(true, true, true, true, multichainData.router);
        emit LogAnySwapOut(
            ADDRESS_ANYWETH,
            address(multichainFacet),
            bridgeData.receiver,
            bridgeData.minAmount,
            1,
            bridgeData.destinationChainId
        );

        vm.startPrank(USER_SENDER);
        multichainFacet.startBridgeTokensViaMultichain{ value: bridgeData.minAmount }(bridgeData, multichainData);
        vm.stopPrank();
    }

    // function testCanBridgeNativeTokens2() public {
    //     vm.startPrank(USER_SENDER);

    //     //! only works with AnyswapV6Router
    //     //reference: https://etherscan.io/tx/0x46a6cfe25b91f9795b08ffee39a3230b4a36c2f8fdcd67b14dfa95f2da681d28
    //     uint256 targetChainId = 250;
    //     uint256 amountToBeBridged = 100 * 10**18;

    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
    //         "",
    //         "multichain",
    //         "",
    //         address(0),
    //         address(testToken),
    //         USER_RECEIVER,
    //         amountToBeBridged,
    //         targetChainId,
    //         false,
    //         false
    //     );

    //     MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(routers[2]);

    //     vm.expectEmit(true, true, true, true, data.router);
    //     emit LogAnySwapOut(
    //         address(testToken),
    //         address(multichainFacet),
    //         bridgeData.receiver,
    //         bridgeData.minAmount,
    //         1,
    //         bridgeData.destinationChainId
    //     );

    //     multichainFacet.startBridgeTokensViaMultichain{ value: amountToBeBridged }(bridgeData, data);
    //     vm.stopPrank();
    // }

    // function testCanBridgeWrappedTokens() public {
    //     //reference: https://etherscan.io/tx/0x7c9bea12ec9b6cd2de01830b7037275461fc95d642ed777437cd9f187fe046c4
    //     ERC20 testToken = ERC20(0x22648C12acD87912EA1710357B1302c6a4154Ebc); //anyUSDT
    //     address testTokenWhale = 0x5754284f345afc66a98fbB0a0Afe71e0F007B949; // USDT Whale
    //     uint256 targetChainId = 250;
    //     uint256 amountToBeBridged = 1000 * 10**testToken.decimals();

    //     ERC20 underlyingToken = ERC20(IMultichainToken(address(testToken)).underlying());
    //     vm.startPrank(testTokenWhale);

    //     SafeERC20.safeIncreaseAllowance(IERC20(address(underlyingToken)), address(multichain), amountToBeBridged);

    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
    //         "",
    //         "multichain",
    //         "",
    //         address(0),
    //         address(testToken),
    //         USDC_WHALE,
    //         amountToBeBridged,
    //         targetChainId,
    //         false,
    //         false
    //     );

    //     MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(routers[0]);

    //     vm.expectEmit(true, true, true, true, data.router);
    //     emit LogAnySwapOut(
    //         address(testToken),
    //         address(multichain),
    //         bridgeData.receiver,
    //         bridgeData.minAmount,
    //         1,
    //         bridgeData.destinationChainId
    //     );

    //     multichain.startBridgeTokensViaMultichain(bridgeData, data);
    //     vm.stopPrank();
    // }

    // function testCanBridgeMultichainTokens() public {
    //     // Multichain tokens are specific tokens that are bridged by calling a function in the
    //     // token contract itself (instead of going through a router contract)
    //     ERC20 testToken = ERC20(0x55aF5865807b196bD0197e0902746F31FBcCFa58); // BOO token
    //     address testTokenWhale = 0x27F82c89b5380Da1A39A8f4F2b56145256A98D34;

    //     vm.startPrank(testTokenWhale);
    //     testToken.approve(address(multichain), 10_000 * 10**testToken.decimals());
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
    //         "",
    //         "multichain",
    //         "",
    //         address(0),
    //         address(testToken),
    //         USDC_WHALE,
    //         10_000 * 10**usdc.decimals(),
    //         100,
    //         false,
    //         false
    //     );
    //     MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(address(testToken));

    //     vm.expectEmit(true, true, true, true, address(testToken));
    //     emit LogSwapout(address(multichain), bridgeData.receiver, bridgeData.minAmount);

    //     multichain.startBridgeTokensViaMultichain(bridgeData, data);
    //     vm.stopPrank();
    // }

    // function testCanSwapAndBridgeTokens() public {
    //     vm.startPrank(DAI_WHALE);
    //     address anyUSDC = 0x7EA2be2df7BA6E54B1A9C70676f668455E329d29;

    //     // Swap DAI -> USDC
    //     address[] memory path = new address[](2);
    //     path[0] = DAI_ADDRESS;
    //     path[1] = USDC_ADDRESS;

    //     uint256 amountOut = 1_000 * 10**usdc.decimals();

    //     // Calculate DAI amount
    //     uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
    //     uint256 amountIn = amounts[0];

    //     dai.approve(address(multichain), amountIn);

    //     // special case for Multichain:
    //     // in bridgeData we will store the anyXXX (e.g. anyUSDC) token address as sendingAssetId
    //     // instead of the USDC address. This is a workaround.
    //     ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
    //         "",
    //         "multichain",
    //         "",
    //         address(0),
    //         anyUSDC,
    //         DAI_WHALE,
    //         amountOut,
    //         100,
    //         true,
    //         false
    //     );

    //     MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(routers[0]);

    //     LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
    //     swapData[0] = LibSwap.SwapData(
    //         address(uniswap),
    //         address(uniswap),
    //         DAI_ADDRESS,
    //         USDC_ADDRESS,
    //         amountIn,
    //         abi.encodeWithSelector(
    //             uniswap.swapExactTokensForTokens.selector,
    //             amountIn,
    //             amountOut,
    //             path,
    //             address(multichain),
    //             block.timestamp + 20 minutes
    //         ),
    //         true
    //     );

    //     vm.expectEmit(true, true, true, true, data.router);
    //     emit LogAnySwapOut(
    //         bridgeData.sendingAssetId,
    //         address(multichain),
    //         bridgeData.receiver,
    //         bridgeData.minAmount,
    //         1, //srcChainId
    //         bridgeData.destinationChainId
    //     );
    //     vm.expectEmit(true, true, true, true, address(multichain));
    //     emit LiFiTransferStarted(bridgeData);

    //     multichain.swapAndStartBridgeTokensViaMultichain(bridgeData, swapData, data);
    //     vm.stopPrank();
    // }

    // function testFailWhenUsingNotWhitelistedRouter() public {
    //     // re-deploy multichain facet with adjusted router whitelist
    //     diamond = createDiamond();
    //     routers = [
    //         0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
    //         0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B // AnyswapV6Router
    //     ];
    //     multichain = new TestMultichainFacet();

    //     bytes4[] memory functionSelectors = new bytes4[](5);
    //     functionSelectors[0] = multichain.startBridgeTokensViaMultichain.selector;
    //     functionSelectors[1] = multichain.swapAndStartBridgeTokensViaMultichain.selector;
    //     functionSelectors[2] = multichain.addDex.selector;
    //     functionSelectors[3] = multichain.setFunctionApprovalBySignature.selector;
    //     functionSelectors[4] = multichain.initMultichain.selector;

    //     addFacet(diamond, address(multichain), functionSelectors);

    //     multichain = TestMultichainFacet(address(diamond));
    //     multichain.addDex(address(uniswap));
    //     multichain.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
    //     multichain.initMultichain(routers);

    //     // this test case should fail now since the router is not whitelisted
    //     testCanBridgeTokens();
    // }
}
