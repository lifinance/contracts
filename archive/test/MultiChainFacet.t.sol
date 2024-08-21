// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20, LiFiDiamond } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner, NotInitialized, AlreadyInitialized } from "src/Errors/GenericErrors.sol";
import { IMultichainToken } from "src/Interfaces/IMultichainToken.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";

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

contract MultichainFacetTest is TestBaseFacet {
    address internal constant ANYSWAPV4ROUTER =
        0x6b7a87899490EcE95443e979cA9485CBE7E71522;
    address internal constant ANYSWAPV6ROUTER =
        0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B;
    address internal constant ADDRESS_ANYUSDC =
        0x7EA2be2df7BA6E54B1A9C70676f668455E329d29;
    address internal constant ADDRESS_ANYDAI =
        0x739ca6D71365a08f584c8FC4e1029045Fa8ABC4B;
    address internal constant ADDRESS_ANYETH =
        0x2AC03BF434db503f6f5F85C3954773731Fc3F056;
    address internal constant USER_TESTTOKEN_WHALE =
        0x5E583B6a1686f7Bc09A6bBa66E852A7C80d36F00;

    // events
    event LogSwapout(
        address indexed account,
        address indexed bindaddr,
        uint256 amount
    );
    event LogAnySwapOut(
        address indexed token,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 fromChainID,
        uint256 toChainID
    );
    event MultichainRoutersUpdated(address[] routers, bool[] allowed);
    event MultichainInitialized();
    event AnyMappingUpdated(MultichainFacet.AnyMapping[] mappings);

    TestMultichainFacet internal multichainFacet;
    address[] internal routers;
    bool[] internal allowed;
    MultichainFacet.MultichainData internal multichainData;
    ERC20 internal testToken;
    ERC20 internal underlyingToken;
    MultichainFacet.AnyMapping[] internal addressMappings;

    function setUp() public {
        // set custom block number for forking
        customBlockNumberForForking = 15588208;

        initTestBase();

        // get test token (cannot just test with USDC or DAI)
        testToken = ERC20(ADDRESS_ANYUSDC);

        multichainFacet = new TestMultichainFacet();

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = multichainFacet
            .startBridgeTokensViaMultichain
            .selector;
        functionSelectors[1] = multichainFacet
            .swapAndStartBridgeTokensViaMultichain
            .selector;
        functionSelectors[2] = multichainFacet.registerRouters.selector;
        functionSelectors[3] = multichainFacet.addDex.selector;
        functionSelectors[4] = multichainFacet.initMultichain.selector;
        functionSelectors[5] = multichainFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[6] = multichainFacet.updateAddressMappings.selector;

        addFacet(diamond, address(multichainFacet), functionSelectors);

        // initiate facet with router addresses
        multichainFacet = TestMultichainFacet(address(diamond));
        routers = [
            ANYSWAPV4ROUTER,
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            ANYSWAPV6ROUTER
        ];
        allowed = [true, true, true];

        multichainFacet.initMultichain(ADDRESS_ANYETH, routers);

        // add token address mappings
        addressMappings.push(
            MultichainFacet.AnyMapping({
                tokenAddress: ADDRESS_USDC,
                anyTokenAddress: ADDRESS_ANYUSDC
            })
        );
        addressMappings.push(
            MultichainFacet.AnyMapping({
                tokenAddress: ADDRESS_DAI,
                anyTokenAddress: ADDRESS_ANYDAI
            })
        );

        multichainFacet.updateAddressMappings(addressMappings);

        multichainFacet.addDex(address(uniswap));
        multichainFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        multichainFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        multichainFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        setFacetAddressInTestBase(address(multichainFacet), "MultichainFacet");

        // adjust bridgeData
        bridgeData.bridge = "multichain";
        bridgeData.sendingAssetId = ADDRESS_USDC; //anyUSDC
        bridgeData.destinationChainId = 56;

        // produce valid HopData
        multichainData = MultichainFacet.MultichainData({
            router: ANYSWAPV4ROUTER
        });

        // get underlying token and approve
        vm.startPrank(USER_TESTTOKEN_WHALE);
        underlyingToken = ERC20(
            IMultichainToken(ADDRESS_ANYUSDC).underlying()
        );
        underlyingToken.approve(
            address(multichainFacet),
            bridgeData.minAmount
        );
        vm.stopPrank();
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            multichainFacet.startBridgeTokensViaMultichain{
                value: bridgeData.minAmount
            }(bridgeData, multichainData);
        } else {
            multichainFacet.startBridgeTokensViaMultichain(
                bridgeData,
                multichainData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            multichainFacet.swapAndStartBridgeTokensViaMultichain{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, multichainData);
        } else {
            multichainFacet.swapAndStartBridgeTokensViaMultichain(
                bridgeData,
                swapData,
                multichainData
            );
        }
    }

    function testBase_CanBridgeNativeTokens()
        public
        override
        assertBalanceChange(address(0), USER_SENDER, -(1 ether))
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        multichainData.router = ANYSWAPV6ROUTER;
        super.testBase_CanBridgeNativeTokens();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        multichainData.router = ANYSWAPV6ROUTER;
        super.testBase_CanSwapAndBridgeNativeTokens();
    }

    function testCanBridgeMultichainTokens() public {
        // Multichain tokens are specific tokens that are bridged by calling a function in the
        // token contract itself (instead of going through a router contract)
        ERC20 testToken3 = ERC20(0x55aF5865807b196bD0197e0902746F31FBcCFa58); // BOO token
        address testToken3Whale = 0x27F82c89b5380Da1A39A8f4F2b56145256A98D34;
        uint256 amountToBeBridged = 10_000 * 10 ** testToken3.decimals();

        vm.startPrank(testToken3Whale);
        testToken3.approve(address(multichainFacet), amountToBeBridged);

        bridgeData.sendingAssetId = address(testToken3);
        bridgeData.minAmount = amountToBeBridged;

        multichainData = MultichainFacet.MultichainData(address(testToken3));

        vm.expectEmit(true, true, true, true, address(testToken3));
        emit LogSwapout(
            address(multichainFacet),
            bridgeData.receiver,
            bridgeData.minAmount
        );

        multichainFacet.startBridgeTokensViaMultichain(
            bridgeData,
            multichainData
        );
        vm.stopPrank();
    }

    function testFailWhenUsingNotWhitelistedRouter() public {
        // re-deploy multichain facet with adjusted router whitelist
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        routers = [
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B // AnyswapV6Router
        ];
        multichainFacet = new TestMultichainFacet();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = multichainFacet
            .startBridgeTokensViaMultichain
            .selector;
        functionSelectors[1] = multichainFacet
            .swapAndStartBridgeTokensViaMultichain
            .selector;
        functionSelectors[2] = multichainFacet.addDex.selector;
        functionSelectors[3] = multichainFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[4] = multichainFacet.initMultichain.selector;

        addFacet(diamond, address(multichainFacet), functionSelectors);

        multichainFacet = TestMultichainFacet(address(diamond));
        multichainFacet.addDex(address(uniswap));
        multichainFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        multichainFacet.initMultichain(ADDRESS_ANYETH, routers);

        // this test case should fail now since the router is not whitelisted
        testBase_CanBridgeTokens();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** testToken.decimals();

        // approval
        underlyingToken.approve(address(multichainFacet), amount);

        bridgeData.minAmount = amount;

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testFail_revert_UsingNonWhitelistedRouter() public {
        // re-deploy multichain facet with adjusted router whitelist
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        routers = [
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B // AnyswapV6Router
        ];
        multichainFacet = new TestMultichainFacet();

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = multichainFacet
            .startBridgeTokensViaMultichain
            .selector;
        functionSelectors[1] = multichainFacet
            .swapAndStartBridgeTokensViaMultichain
            .selector;
        functionSelectors[2] = bytes4(
            keccak256("registerBridge(address,bool)")
        );
        functionSelectors[3] = bytes4(
            keccak256("registerBridge(address[],bool[])")
        );
        functionSelectors[4] = multichainFacet.addDex.selector;
        functionSelectors[5] = multichainFacet.initMultichain.selector;
        functionSelectors[6] = multichainFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(multichainFacet), functionSelectors);

        multichainFacet = TestMultichainFacet(address(diamond));
        routers = [
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            ANYSWAPV6ROUTER
        ];
        multichainFacet.initMultichain(ADDRESS_ANYETH, routers);

        // this test case should fail now since the ANYSWAPV4ROUTER router is not whitelisted
        testBase_CanBridgeTokens();
    }

    function test_OwnerCanRegisterNewRouters() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit MultichainRoutersUpdated(routers, allowed);

        multichainFacet.registerRouters(routers, allowed);
    }

    function test_revert_RegisterRoutersNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        multichainFacet.registerRouters(routers, allowed);
    }

    function test_OwnerCanInitializeFacet() public {
        LiFiDiamond diamond2 = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        vm.startPrank(USER_DIAMOND_OWNER);

        TestMultichainFacet multichainFacet2 = new TestMultichainFacet();
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = multichainFacet
            .startBridgeTokensViaMultichain
            .selector;
        functionSelectors[1] = multichainFacet
            .swapAndStartBridgeTokensViaMultichain
            .selector;
        functionSelectors[2] = bytes4(
            keccak256("registerBridge(address,bool)")
        );
        functionSelectors[3] = bytes4(
            keccak256("registerBridge(address[],bool[])")
        );
        functionSelectors[4] = multichainFacet.addDex.selector;
        functionSelectors[5] = multichainFacet.initMultichain.selector;
        functionSelectors[6] = multichainFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond2, address(multichainFacet2), functionSelectors);

        multichainFacet2 = TestMultichainFacet(address(diamond2));

        vm.expectEmit(true, true, true, true, address(multichainFacet2));
        emit MultichainInitialized();
        multichainFacet2.initMultichain(ADDRESS_ANYETH, routers);
    }

    function test_canRegisterNewAnyTokenAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(multichainFacet));
        emit AnyMappingUpdated(addressMappings);

        multichainFacet.updateAddressMappings(addressMappings);
    }

    function test_revert_RegisterAnyTokenAddressesNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        multichainFacet.updateAddressMappings(addressMappings);
    }
}
