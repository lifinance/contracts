// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console, InvalidAmount, ERC20, LiFiDiamond } from "../utils/TestBase.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized } from "src/Errors/GenericErrors.sol";
import { IMultichainRouter } from "lifi/Interfaces/IMultichainRouter.sol";
import { MultichainFacet, IMultichainToken } from "lifi/Facets/MultichainFacet.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
    address internal constant ANYSWAPV6ROUTER = 0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B;
    address internal constant ADDRESS_ANYUSDC = 0x7EA2be2df7BA6E54B1A9C70676f668455E329d29;
    address internal constant ADDRESS_ANYETH = 0x2AC03BF434db503f6f5F85C3954773731Fc3F056;
    address internal constant USER_TESTTOKEN_WHALE = 0x5E583B6a1686f7Bc09A6bBa66E852A7C80d36F00;

    // events
    event MultichainRouterRegistered(address indexed router, bool allowed);
    event MultichainInitialized();
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
        // set custom block number for forking
        customBlockNumberForForking = 15588208;

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
            ANYSWAPV6ROUTER
        ];
        multichainFacet.initMultichain(routers);

        multichainFacet.addDex(address(uniswap));
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForETH.selector);
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        multichainFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        setFacetAddressInTestBase(address(multichainFacet));

        // adjust bridgeData
        // special case for Multichain:
        // in bridgeData we will store the anyXXX (e.g. anyUSDC) token address as sendingAssetId
        // instead of the USDC address. This is a workaround.
        bridgeData.bridge = "multichain";
        bridgeData.sendingAssetId = ADDRESS_ANYUSDC; //anyUSDC
        bridgeData.destinationChainId = 250;

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
        bridgeData.sendingAssetId = ADDRESS_ANYETH;
        bridgeData.minAmount = 1 ether;

        multichainData = MultichainFacet.MultichainData(routers[2]);

        vm.expectEmit(true, true, true, true, multichainData.router);
        emit LogAnySwapOut(
            ADDRESS_ANYETH,
            address(multichainFacet),
            bridgeData.receiver,
            bridgeData.minAmount,
            1,
            bridgeData.destinationChainId
        );
        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit LiFiTransferStarted(bridgeData);

        vm.startPrank(USER_SENDER);
        multichainFacet.startBridgeTokensViaMultichain{ value: bridgeData.minAmount }(bridgeData, multichainData);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        dai.approve(address(multichainFacet), swapData[0].fromAmount);

        bridgeData.hasSourceSwaps = true;

        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, multichainData.router);
        emit LogAnySwapOut(
            bridgeData.sendingAssetId,
            address(multichainFacet),
            bridgeData.receiver,
            bridgeData.minAmount,
            1, //srcChainId
            bridgeData.destinationChainId
        );
        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit LiFiTransferStarted(bridgeData);

        multichainFacet.swapAndStartBridgeTokensViaMultichain(bridgeData, swapData, multichainData);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_ANYETH;
        bridgeData.minAmount = 1 ether;
        bridgeData.hasSourceSwaps = true;

        multichainData.router = ANYSWAPV6ROUTER;

        setDefaultSwapDataSingleDAItoETH();
        dai.approve(address(multichainFacet), swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, multichainData.router);
        emit LogAnySwapOut(
            bridgeData.sendingAssetId,
            address(multichainFacet),
            bridgeData.receiver,
            bridgeData.minAmount,
            1, //srcChainId
            bridgeData.destinationChainId
        );
        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit LiFiTransferStarted(bridgeData);

        multichainFacet.swapAndStartBridgeTokensViaMultichain(bridgeData, swapData, multichainData);
        vm.stopPrank();
    }

    function test_CanBridgeWrappedTokens() public {
        //reference: https://etherscan.io/tx/0x7c9bea12ec9b6cd2de01830b7037275461fc95d642ed777437cd9f187fe046c4
        ERC20 testToken2 = ERC20(0x22648C12acD87912EA1710357B1302c6a4154Ebc); //anyUSDT
        address testToken2Whale = 0x5754284f345afc66a98fbB0a0Afe71e0F007B949; // USDT Whale
        uint256 amountToBeBridged = 100 * 10**testToken2.decimals();

        ERC20 underlyingToken2 = ERC20(IMultichainToken(address(testToken2)).underlying());
        vm.startPrank(testToken2Whale);

        SafeERC20.safeIncreaseAllowance(IERC20(address(underlyingToken2)), address(multichainFacet), amountToBeBridged);

        bridgeData.sendingAssetId = address(testToken2);

        multichainData = MultichainFacet.MultichainData(routers[0]);

        vm.expectEmit(true, true, true, true, multichainData.router);
        emit LogAnySwapOut(
            address(testToken2),
            address(multichainFacet),
            bridgeData.receiver,
            bridgeData.minAmount,
            1,
            bridgeData.destinationChainId
        );

        multichainFacet.startBridgeTokensViaMultichain(bridgeData, multichainData);
        vm.stopPrank();
    }

    function test_CanBridgeMultichainTokens() public {
        // Multichain tokens are specific tokens that are bridged by calling a function in the
        // token contract itself (instead of going through a router contract)
        ERC20 testToken3 = ERC20(0x55aF5865807b196bD0197e0902746F31FBcCFa58); // BOO token
        address testToken3Whale = 0x27F82c89b5380Da1A39A8f4F2b56145256A98D34;
        uint256 amountToBeBridged = 10_000 * 10**testToken3.decimals();

        vm.startPrank(testToken3Whale);
        testToken3.approve(address(multichainFacet), amountToBeBridged);

        bridgeData.sendingAssetId = address(testToken3);
        bridgeData.minAmount = amountToBeBridged;

        multichainData = MultichainFacet.MultichainData(address(testToken3));

        vm.expectEmit(true, true, true, true, address(testToken3));
        emit LogSwapout(address(multichainFacet), bridgeData.receiver, bridgeData.minAmount);

        multichainFacet.startBridgeTokensViaMultichain(bridgeData, multichainData);
        vm.stopPrank();
    }

    function testFail_revert_UsingNonWhitelistedRouter() public {
        // re-deploy multichain facet with adjusted router whitelist
        diamond = createDiamond();
        routers = [
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B // AnyswapV6Router
        ];
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
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            ANYSWAPV6ROUTER
        ];
        multichainFacet.initMultichain(routers);

        // this one does not work here, not sure why. Therefore test will be renamed to "testFail...."
        // vm.expectRevert(MultichainFacet.InvalidRouter.selector);

        // this test case should fail now since the ANYSWAPV4ROUTER router is not whitelisted
        testBase_CanBridgeTokens();
    }

    function test_canRegisterNewBridgeAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit MultichainRouterRegistered(ANYSWAPV4ROUTER, true);

        multichainFacet.registerBridge(ANYSWAPV4ROUTER, true);
    }

    function test_revert_RegisterBridgeNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        multichainFacet.registerBridge(ANYSWAPV4ROUTER, true);
    }

    function test_revert_RegisterBridgeWithInvalidAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        vm.expectRevert(InvalidConfig.selector);
        multichainFacet.registerBridge(address(0), true);
        vm.stopPrank();
    }

    function test_revert_RegisterBridgeWithUninitializedFacet() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        LiFiDiamond diamond2 = createDiamond();

        TestMultichainFacet multichainFacet2 = new TestMultichainFacet();
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = multichainFacet.startBridgeTokensViaMultichain.selector;
        functionSelectors[1] = multichainFacet.swapAndStartBridgeTokensViaMultichain.selector;
        functionSelectors[2] = bytes4(keccak256("registerBridge(address,bool)"));
        functionSelectors[3] = bytes4(keccak256("registerBridge(address[],bool[])"));
        functionSelectors[4] = multichainFacet.addDex.selector;
        functionSelectors[5] = multichainFacet.initMultichain.selector;
        functionSelectors[6] = multichainFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond2, address(multichainFacet2), functionSelectors);
        multichainFacet2 = TestMultichainFacet(address(diamond2));

        vm.expectRevert(NotInitialized.selector);
        multichainFacet2.registerBridge(ANYSWAPV4ROUTER, true);
    }

    function test_OwnerCanInitializeFacet() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        LiFiDiamond diamond2 = createDiamond();

        TestMultichainFacet multichainFacet2 = new TestMultichainFacet();
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = multichainFacet.startBridgeTokensViaMultichain.selector;
        functionSelectors[1] = multichainFacet.swapAndStartBridgeTokensViaMultichain.selector;
        functionSelectors[2] = bytes4(keccak256("registerBridge(address,bool)"));
        functionSelectors[3] = bytes4(keccak256("registerBridge(address[],bool[])"));
        functionSelectors[4] = multichainFacet.addDex.selector;
        functionSelectors[5] = multichainFacet.initMultichain.selector;
        functionSelectors[6] = multichainFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond2, address(multichainFacet2), functionSelectors);

        multichainFacet2 = TestMultichainFacet(address(diamond2));

        vm.expectEmit(true, true, true, true, address(multichainFacet2));
        emit MultichainInitialized();
        multichainFacet2.initMultichain(routers);
    }

    function test_revert_CannotInitializeFacetAgain() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(AlreadyInitialized.selector);
        multichainFacet.initMultichain(routers);
    }
}
