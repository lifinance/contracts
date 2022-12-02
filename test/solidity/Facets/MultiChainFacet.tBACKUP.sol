// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { MultichainFacet, IMultichainToken } from "lifi/Facets/MultichainFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { IMultichainRouter } from "lifi/Interfaces/IMultichainRouter.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Stub CBridgeFacet Contract
contract TestMultichainFacet is MultichainFacet {
    constructor() {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MultiBACKUPchainFacetTest is DSTest, DiamondTest {
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant USDC_WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
    address internal constant DAI_WHALE = 0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD;
    address internal constant ANYSWAPV4ROUTER = 0x6b7a87899490EcE95443e979cA9485CBE7E71522;

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
    event LiFiTransferStarted(ILiFi.BridgeData bridgeData);

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestMultichainFacet internal multichain;
    ERC20 internal usdc;
    ERC20 internal dai;
    UniswapV2Router02 internal uniswap;
    address[] public routers;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = vm.envUint("FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        routers = [
            ANYSWAPV4ROUTER,
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B // AnyswapV6Router
        ];
        multichain = new TestMultichainFacet();
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = multichain.startBridgeTokensViaMultichain.selector;
        functionSelectors[1] = multichain.swapAndStartBridgeTokensViaMultichain.selector;
        functionSelectors[2] = multichain.addDex.selector;
        functionSelectors[3] = multichain.setFunctionApprovalBySignature.selector;
        functionSelectors[4] = multichain.initMultichain.selector;

        addFacet(diamond, address(multichain), functionSelectors);

        multichain = TestMultichainFacet(address(diamond));
        multichain.addDex(address(uniswap));
        multichain.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        multichain.initMultichain(routers);
    }

    function testCanBridgeTokens() public {
        //reference: https://etherscan.io/tx/0x46a6cfe25b91f9795b08ffee39a3230b4a36c2f8fdcd67b14dfa95f2da681d28
        ERC20 testToken = ERC20(0x7EA2be2df7BA6E54B1A9C70676f668455E329d29); //anyUSDC
        address testTokenWhale = 0x5E583B6a1686f7Bc09A6bBa66E852A7C80d36F00;
        uint256 targetChainId = 250;
        uint256 amountToBeBridged = 1000 * 10**testToken.decimals();

        ERC20 underlyingToken = ERC20(IMultichainToken(address(testToken)).underlying());

        vm.startPrank(testTokenWhale);

        underlyingToken.approve(address(multichain), amountToBeBridged);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "multichain",
            "",
            address(0),
            address(testToken),
            USDC_WHALE,
            amountToBeBridged,
            targetChainId,
            false,
            false
        );

        MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(ANYSWAPV4ROUTER);

        vm.expectEmit(true, true, true, true, data.router);
        emit LogAnySwapOut(
            address(testToken),
            address(multichain),
            bridgeData.receiver,
            bridgeData.minAmount,
            1,
            bridgeData.destinationChainId
        );

        multichain.startBridgeTokensViaMultichain(bridgeData, data);
        vm.stopPrank();
    }

    function testCanBridgeNativeTokens() public {
        //! only works with AnyswapV6Router
        //reference: https://etherscan.io/tx/0x46a6cfe25b91f9795b08ffee39a3230b4a36c2f8fdcd67b14dfa95f2da681d28
        uint256 targetChainId = 250;
        uint256 amountToBeBridged = 1000 * 10**18;
        address testToken = 0x0615Dbba33Fe61a31c7eD131BDA6655Ed76748B1; // anyETH

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "multichain",
            "",
            address(0),
            testToken,
            USDC_WHALE,
            amountToBeBridged,
            targetChainId,
            false,
            false
        );

        MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(routers[2]);

        vm.expectEmit(true, true, true, true, data.router);
        emit LogAnySwapOut(
            address(testToken),
            address(multichain),
            bridgeData.receiver,
            bridgeData.minAmount,
            1,
            bridgeData.destinationChainId
        );

        multichain.startBridgeTokensViaMultichain{ value: amountToBeBridged }(bridgeData, data);
        vm.stopPrank();
    }

    function testCanBridgeWrappedTokens() public {
        //reference: https://etherscan.io/tx/0x7c9bea12ec9b6cd2de01830b7037275461fc95d642ed777437cd9f187fe046c4
        ERC20 testToken = ERC20(0x22648C12acD87912EA1710357B1302c6a4154Ebc); //anyUSDT
        address testTokenWhale = 0x5754284f345afc66a98fbB0a0Afe71e0F007B949; // USDT Whale
        uint256 targetChainId = 250;
        uint256 amountToBeBridged = 1000 * 10**testToken.decimals();

        ERC20 underlyingToken = ERC20(IMultichainToken(address(testToken)).underlying());
        vm.startPrank(testTokenWhale);

        SafeERC20.safeIncreaseAllowance(IERC20(address(underlyingToken)), address(multichain), amountToBeBridged);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "multichain",
            "",
            address(0),
            address(testToken),
            USDC_WHALE,
            amountToBeBridged,
            targetChainId,
            false,
            false
        );

        MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(routers[0]);

        vm.expectEmit(true, true, true, true, data.router);
        emit LogAnySwapOut(
            address(testToken),
            address(multichain),
            bridgeData.receiver,
            bridgeData.minAmount,
            1,
            bridgeData.destinationChainId
        );

        multichain.startBridgeTokensViaMultichain(bridgeData, data);
        vm.stopPrank();
    }

    function testCanBridgeMultichainTokens() public {
        // Multichain tokens are specific tokens that are bridged by calling a function in the
        // token contract itself (instead of going through a router contract)
        ERC20 testToken = ERC20(0x55aF5865807b196bD0197e0902746F31FBcCFa58); // BOO token
        address testTokenWhale = 0x27F82c89b5380Da1A39A8f4F2b56145256A98D34;

        vm.startPrank(testTokenWhale);
        testToken.approve(address(multichain), 10_000 * 10**testToken.decimals());
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "multichain",
            "",
            address(0),
            address(testToken),
            USDC_WHALE,
            10_000 * 10**usdc.decimals(),
            100,
            false,
            false
        );
        MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(address(testToken));

        vm.expectEmit(true, true, true, true, address(testToken));
        emit LogSwapout(address(multichain), bridgeData.receiver, bridgeData.minAmount);

        multichain.startBridgeTokensViaMultichain(bridgeData, data);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(DAI_WHALE);
        address anyUSDC = 0x7EA2be2df7BA6E54B1A9C70676f668455E329d29;

        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        uint256 amountOut = 1_000 * 10**usdc.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        dai.approve(address(multichain), amountIn);

        // special case for Multichain:
        // in bridgeData we will store the anyXXX (e.g. anyUSDC) token address as sendingAssetId
        // instead of the USDC address. This is a workaround.
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "multichain",
            "",
            address(0),
            anyUSDC,
            DAI_WHALE,
            amountOut,
            100,
            true,
            false
        );

        MultichainFacet.MultichainData memory data = MultichainFacet.MultichainData(routers[0]);

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
                address(multichain),
                block.timestamp + 20 minutes
            ),
            true
        );

        vm.expectEmit(true, true, true, true, data.router);
        emit LogAnySwapOut(
            bridgeData.sendingAssetId,
            address(multichain),
            bridgeData.receiver,
            bridgeData.minAmount,
            1, //srcChainId
            bridgeData.destinationChainId
        );
        vm.expectEmit(true, true, true, true, address(multichain));
        emit LiFiTransferStarted(bridgeData);

        multichain.swapAndStartBridgeTokensViaMultichain(bridgeData, swapData, data);
        vm.stopPrank();
    }

    function testFailWhenUsingNotWhitelistedRouter() public {
        // re-deploy multichain facet with adjusted router whitelist
        diamond = createDiamond();
        routers = [
            0x55aF5865807b196bD0197e0902746F31FBcCFa58, // TestMultichainToken
            0x7782046601e7b9B05cA55A3899780CE6EE6B8B2B // AnyswapV6Router
        ];
        multichain = new TestMultichainFacet();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = multichain.startBridgeTokensViaMultichain.selector;
        functionSelectors[1] = multichain.swapAndStartBridgeTokensViaMultichain.selector;
        functionSelectors[2] = multichain.addDex.selector;
        functionSelectors[3] = multichain.setFunctionApprovalBySignature.selector;
        functionSelectors[4] = multichain.initMultichain.selector;

        addFacet(diamond, address(multichain), functionSelectors);

        multichain = TestMultichainFacet(address(diamond));
        multichain.addDex(address(uniswap));
        multichain.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        multichain.initMultichain(routers);

        // this test case should fail now since the router is not whitelisted
        testCanBridgeTokens();
    }
}
