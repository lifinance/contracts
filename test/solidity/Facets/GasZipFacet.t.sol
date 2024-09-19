// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;
import { GasZipFacet } from "lifi/Facets/GasZipFacet.sol";
import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

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

contract GasZipFacetTest is TestBaseFacet {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x9E22ebeC84c7e4C4bD6D4aE7FF6f4D436D6D8390;

    TestGasZipFacet internal gasZipFacet;
    GasZipFacet.GasZipData internal gasZipData;

    uint256 public defaultDestinationChains = 96;
    address public defaultRecipientAddress = address(12345);
    address public defaultRefundAddress = address(56789);
    // uint256 public defaultNativeAmount = 0.0006 ether;

    event Deposit(address from, uint256 chains, uint256 amount, address to);

    function setUp() public {
        // set custom block no for mainnet forking
        customBlockNumberForForking = 17484106;

        initTestBase();

        // deploy contracts
        gasZipFacet = new TestGasZipFacet(GAS_ZIP_ROUTER_MAINNET);

        // add gasZipFacet to diamond
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = gasZipFacet.startBridgeTokensViaGasZip.selector;
        functionSelectors[1] = gasZipFacet
            .swapAndStartBridgeTokensViaGasZip
            .selector;
        functionSelectors[2] = gasZipFacet.addDex.selector;
        functionSelectors[3] = gasZipFacet.removeDex.selector;
        functionSelectors[4] = gasZipFacet
            .setFunctionApprovalBySignature
            .selector;
        addFacet(diamond, address(gasZipFacet), functionSelectors);

        gasZipFacet = TestGasZipFacet(payable(address(diamond)));

        // whitelist uniswap dex with function selectors
        gasZipFacet.addDex(address(uniswap));
        gasZipFacet.addDex(address(gasZipFacet));
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            gasZipFacet.depositToGasZipERC20.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            gasZipFacet.depositToGasZipNative.selector
        );

        setFacetAddressInTestBase(address(gasZipFacet), "GasZipFacet");

        // produce valid GasZipData
        gasZipData = GasZipFacet.GasZipData({
            gasZipChainId: 17 // Polygon (https://dev.gas.zip/gas/chain-support/outbound)
        });

        bridgeData.bridge = "GasZip";

        vm.label(address(gasZipFacet), "LiFiDiamond");
        vm.label(ADDRESS_WETH, "WETH_TOKEN");
        vm.label(ADDRESS_USDC, "USDC_TOKEN");
        vm.label(ADDRESS_UNISWAP, "UNISWAP_V2_ROUTER");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            gasZipFacet.startBridgeTokensViaGasZip{
                value: bridgeData.minAmount
            }(bridgeData, gasZipData);
        } else {
            gasZipFacet.startBridgeTokensViaGasZip(bridgeData, gasZipData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            gasZipFacet.swapAndStartBridgeTokensViaGasZip{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, gasZipData);
        } else {
            gasZipFacet.swapAndStartBridgeTokensViaGasZip(
                bridgeData,
                swapData,
                gasZipData
            );
        }
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // deactivated for this facet since we would have to update the calldata that swaps from ERC20 to native for every amount
    }

    function testBase_CanBridgeTokens() public override {
        // the startBridgeTokensViaGasZip can only be used for native tokens, therefore we need to adapt this test case
        vm.startPrank(USER_SENDER);

        // update bridgeData to use native
        bridgeData.sendingAssetId = address(0);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        // the startBridgeTokensViaGasZip can only be used for native tokens, therefore this test case is not applicable
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // the swapAndStartBridgeTokensViaGasZip can only be used for ERC20 tokens
        // therefore this test is expected to revert with InvalidCallData()
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WETH;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        usdc.approve(_facetTestContractAddress, amountIn);

        vm.expectRevert(InvalidCallData.selector);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultNativeAmount;

        // reset swap data
        setDefaultSwapDataSingleDAItoETH();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }
}
