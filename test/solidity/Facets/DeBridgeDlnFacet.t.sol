// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20, LibSwap } from "../utils/TestBaseFacet.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";
import { IDlnSource } from "lifi/Interfaces/IDlnSource.sol";

// Stub DeBridgeDlnFacet Contract
contract TestDeBridgeDlnFacet is DeBridgeDlnFacet {
    constructor(IDlnSource _dlnSource) DeBridgeDlnFacet(_dlnSource) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract DeBridgeDlnFacetTest is TestBaseFacet {
    DeBridgeDlnFacet.DeBridgeDlnData internal validDeBridgeDlnData;
    TestDeBridgeDlnFacet internal deBridgeDlnFacet;
    IDlnSource internal DLN_SOURCE =
        IDlnSource(0xeF4fB24aD0916217251F553c0596F8Edc630EB66);
    uint256 internal FIXED_FEE;

    function setUp() public {
        customBlockNumberForForking = 19279222;
        initTestBase();

        deBridgeDlnFacet = new TestDeBridgeDlnFacet(DLN_SOURCE);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = deBridgeDlnFacet
            .startBridgeTokensViaDeBridgeDln
            .selector;
        functionSelectors[1] = deBridgeDlnFacet
            .swapAndStartBridgeTokensViaDeBridgeDln
            .selector;
        functionSelectors[2] = deBridgeDlnFacet.addDex.selector;
        functionSelectors[3] = deBridgeDlnFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(deBridgeDlnFacet), functionSelectors);
        deBridgeDlnFacet = TestDeBridgeDlnFacet(address(diamond));
        deBridgeDlnFacet.addDex(ADDRESS_UNISWAP);
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(deBridgeDlnFacet),
            "DeBridgeDlnFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "deBridgeDln";
        bridgeData.destinationChainId = 137;

        // produce valid DeBridgeDlnData
        validDeBridgeDlnData = DeBridgeDlnFacet.DeBridgeDlnData({
            receivingAssetId: abi.encodePacked(
                0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
            ), // Polygon USDC
            receiver: abi.encodePacked(USER_RECEIVER),
            minAmountOut: (defaultUSDCAmount * 95) / 100
        });

        vm.label(address(DLN_SOURCE), "DLN_SOURCE");
        FIXED_FEE = DLN_SOURCE.globalFixedNativeFee();
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            deBridgeDlnFacet.startBridgeTokensViaDeBridgeDln{
                value: bridgeData.minAmount + FIXED_FEE
            }(bridgeData, validDeBridgeDlnData);
        } else {
            deBridgeDlnFacet.startBridgeTokensViaDeBridgeDln{
                value: FIXED_FEE
            }(bridgeData, validDeBridgeDlnData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            deBridgeDlnFacet.swapAndStartBridgeTokensViaDeBridgeDln{
                value: defaultNativeAmount + FIXED_FEE
            }(bridgeData, swapData, validDeBridgeDlnData);
        } else {
            deBridgeDlnFacet.swapAndStartBridgeTokensViaDeBridgeDln{
                value: FIXED_FEE
            }(bridgeData, swapData, validDeBridgeDlnData);
        }
    }

    function test_CanSwapAndBridgeTokensFromNative()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialETHBalance = USER_SENDER.balance;

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        address[] memory path = new address[](2);

        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(true);

        // check balances after call
        assertEq(
            USER_SENDER.balance,
            initialETHBalance - swapData[0].fromAmount - FIXED_FEE
        );
    }
}
