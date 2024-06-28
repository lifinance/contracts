// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test, DSTest } from "forge-std/Test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { GasZipFacet } from "lifi/Facets/GasZipFacet.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed } from "lifi/Errors/GenericErrors.sol";

import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { TestHelpers, MockUniswapDEX, NonETHReceiver } from "../utils/TestHelpers.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";
import { GnosisBridgeFacet } from "lifi/Facets/GnosisBridgeFacet.sol";
import { IXDaiBridge } from "lifi/Interfaces/IXDaiBridge.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";

// Stub GenericSwapFacet Contract
contract TestGasZipFacet is GasZipFacet {
    constructor(address gasZipRouter) GasZipFacet(gasZipRouter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function removeDex(address _dex) external {
        LibAllowList.removeAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GasZipProtocolTest is DSTest, DiamondTest, TestHelpers {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x9E22ebeC84c7e4C4bD6D4aE7FF6f4D436D6D8390;
    address internal ADDRESS_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal ADDRESS_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal ADDRESS_DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal ADDRESS_UNISWAP =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant XDAI_BRIDGE =
        0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;

    LiFiDiamond internal diamond;
    TestGasZipFacet internal gasZipFacet;
    ERC20 internal usdc;
    ERC20 internal dai;
    UniswapV2Router02 internal uniswap;
    FeeCollector internal feeCollector;

    uint256 public defaultDestinationChains = 96;
    address public defaultRecipientAddress = address(12345);
    address public defaultRefundAddress = address(56789);
    uint256 public defaultNativeAmount = 0.0006 ether;
    uint256 public defaultUSDCAmount;

    event Deposit(address from, uint256 chains, uint256 amount, address to);

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 20173181;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        // deploy contracts
        diamond = createDiamond();
        gasZipFacet = new TestGasZipFacet(GAS_ZIP_ROUTER_MAINNET);
        usdc = ERC20(ADDRESS_USDC);
        dai = ERC20(ADDRESS_DAI);
        uniswap = UniswapV2Router02(ADDRESS_UNISWAP);
        feeCollector = new FeeCollector(address(this));

        defaultUSDCAmount = 10 * 10 ** usdc.decimals(); // 10 USDC

        // add gasZipFacet to diamond
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = gasZipFacet.depositToGasZipNative.selector;
        functionSelectors[1] = gasZipFacet.depositToGasZipERC20.selector;
        functionSelectors[2] = gasZipFacet.addDex.selector;
        functionSelectors[3] = gasZipFacet.removeDex.selector;
        functionSelectors[4] = gasZipFacet
            .setFunctionApprovalBySignature
            .selector;
        addFacet(diamond, address(gasZipFacet), functionSelectors);

        gasZipFacet = TestGasZipFacet(payable(address(diamond)));

        // whitelist uniswap dex with function selectors
        gasZipFacet.addDex(address(uniswap));
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector
        );

        vm.label(address(gasZipFacet), "LiFiDiamond");
        vm.label(ADDRESS_WETH, "WETH_TOKEN");
        vm.label(ADDRESS_USDC, "USDC_TOKEN");
        vm.label(ADDRESS_UNISWAP, "UNISWAP_V2_ROUTER");
    }

    function test_canDepositNative() public {
        // set up expected event
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZipFacet),
            defaultDestinationChains,
            defaultNativeAmount,
            defaultRecipientAddress
        );

        // deposit via GasZip periphery contract
        gasZipFacet.depositToGasZipNative{ value: defaultNativeAmount }(
            defaultNativeAmount,
            defaultDestinationChains,
            defaultRecipientAddress
        );
    }

    function test_canCollectERC20FeesThenSwapToERC20ThenDepositThenBridge()
        public
    {
        // Testcase:
        // 1. pay 1 USDC fee to FeeCollector in USDC
        // 2. swap remaining (9) USDC to DAI
        // 3. deposit 2 DAI to gasZip
        // 4. bridge remaining DAI to Gnosis using GnosisBridgeFacet

        deal(ADDRESS_USDC, address(this), defaultUSDCAmount);

        // get swapData for feeCollection
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](3);
        uint256 feeCollectionAmount = 1 * 10 ** usdc.decimals(); // 1 USD

        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            ADDRESS_USDC,
            ADDRESS_USDC,
            defaultUSDCAmount,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_USDC,
                feeCollectionAmount,
                0,
                address(this)
            ),
            true
        );

        // get swapData for swap
        uint256 swapInputAmount = defaultUSDCAmount - feeCollectionAmount;
        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(
            swapInputAmount,
            path
        );
        uint256 swapOutputAmount = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
            swapInputAmount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                swapInputAmount,
                swapOutputAmount,
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            false // not required since tokens are already in diamond
        );

        // // get swapData for gas zip
        uint256 gasZipERC20Amount = 2 * 10 ** dai.decimals();
        (
            LibSwap.SwapData memory gasZipSwapData,

        ) = _getUniswapCalldataForERC20ToNativeSwap(
                ADDRESS_DAI,
                gasZipERC20Amount
            );

        swapData[2] = LibSwap.SwapData(
            address(gasZipFacet),
            address(gasZipFacet),
            ADDRESS_DAI,
            ADDRESS_DAI,
            gasZipERC20Amount,
            abi.encodeWithSelector(
                gasZipFacet.depositToGasZipERC20.selector,
                gasZipSwapData,
                defaultDestinationChains,
                defaultRecipientAddress
            ),
            false // not required since tokens are already in the diamond
        );

        // get BridgeData
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "GnosisBridge",
            integrator: "",
            referrer: address(0),
            sendingAssetId: ADDRESS_DAI,
            receiver: defaultRecipientAddress,
            minAmount: swapOutputAmount - gasZipERC20Amount,
            destinationChainId: 100,
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // whitelist gasZipFacet and FeeCollector
        gasZipFacet.addDex(address(gasZipFacet));
        gasZipFacet.setFunctionApprovalBySignature(
            gasZipFacet.depositToGasZipERC20.selector
        );
        gasZipFacet.addDex(address(feeCollector));
        gasZipFacet.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );

        // bridge using (standalone) GnosisBridgeFacet
        TestGnosisBridgeFacet gnosisBridgeFacet = _getGnosisBridgeFacet();

        // set approval for bridging
        usdc.approve(address(gnosisBridgeFacet), defaultUSDCAmount);

        gnosisBridgeFacet.swapAndStartBridgeTokensViaXDaiBridge(
            bridgeData,
            swapData
        );
    }

    function test_canDepositNativeThenSwapThenBridge() public {
        // Testcase:
        // 1. deposit small native amount to gasZip
        // 2. swap remaining native to DAI
        // 3. bridge remaining DAI to Gnosis using GnosisBridgeFacet

        uint256 nativeFromAmount = 1 ether;

        vm.deal(address(this), nativeFromAmount);

        uint256 nativeZipAmount = 1e14;

        // get swapData for gas zip
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(gasZipFacet),
            address(gasZipFacet),
            address(0),
            address(0),
            nativeZipAmount,
            abi.encodeWithSelector(
                gasZipFacet.depositToGasZipNative.selector,
                nativeZipAmount,
                defaultDestinationChains,
                defaultRecipientAddress
            ),
            false
        );

        // get swapData for swap
        uint256 swapInputAmount = nativeFromAmount - nativeZipAmount;

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_DAI;

        // Calculate expected amountOut
        uint256[] memory amounts = uniswap.getAmountsOut(
            swapInputAmount,
            path
        );
        uint256 swapOutputAmount = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            ADDRESS_DAI,
            swapInputAmount,
            abi.encodeWithSelector(
                uniswap.swapExactETHForTokens.selector,
                swapOutputAmount,
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            false // not required since tokens are already in diamond
        );

        // get BridgeData
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "GnosisBridge",
            integrator: "",
            referrer: address(0),
            sendingAssetId: ADDRESS_DAI,
            receiver: defaultRecipientAddress,
            minAmount: swapOutputAmount,
            destinationChainId: 100,
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // whitelist gasZipFacet and FeeCollector
        gasZipFacet.addDex(address(gasZipFacet));
        gasZipFacet.setFunctionApprovalBySignature(
            gasZipFacet.depositToGasZipNative.selector
        );

        // bridge using (standalone) GnosisBridgeFacet
        TestGnosisBridgeFacet gnosisBridgeFacet = _getGnosisBridgeFacet();

        gnosisBridgeFacet.swapAndStartBridgeTokensViaXDaiBridge{
            value: nativeFromAmount
        }(bridgeData, swapData);
    }

    function _getGnosisBridgeFacet()
        internal
        returns (TestGnosisBridgeFacet gnosisBridgeFacet)
    {
        gnosisBridgeFacet = new TestGnosisBridgeFacet(
            IXDaiBridge(XDAI_BRIDGE)
        );

        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = gnosisBridgeFacet
            .startBridgeTokensViaXDaiBridge
            .selector;
        functionSelectors[1] = gnosisBridgeFacet
            .swapAndStartBridgeTokensViaXDaiBridge
            .selector;

        addFacet(diamond, address(gnosisBridgeFacet), functionSelectors);

        gnosisBridgeFacet = TestGnosisBridgeFacet(address(diamond));
    }

    function _getUniswapCalldataForERC20ToNativeSwap(
        address sendingAssetId,
        uint256 fromAmount
    )
        internal
        view
        returns (LibSwap.SwapData memory swapData, uint256 amountOutMin)
    {
        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = sendingAssetId;
        path[1] = ADDRESS_WETH;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(fromAmount, path);
        amountOutMin = amounts[1];

        swapData = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            sendingAssetId,
            ADDRESS_WETH,
            fromAmount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector,
                fromAmount,
                amountOutMin,
                path,
                address(gasZipFacet),
                block.timestamp + 20 seconds
            ),
            false // not required since tokens are already in diamond
        );
    }
}

contract TestGnosisBridgeFacet is GnosisBridgeFacet {
    constructor(IXDaiBridge _xDaiBridge) GnosisBridgeFacet(_xDaiBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}
