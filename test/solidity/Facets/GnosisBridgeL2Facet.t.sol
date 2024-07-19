// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { InsufficientBalance } from "src/Errors/GenericErrors.sol";
import { GnosisBridgeL2Facet } from "lifi/Facets/GnosisBridgeL2Facet.sol";
import { IXDaiBridgeL2 } from "lifi/Interfaces/IXDaiBridgeL2.sol";

// Stub GnosisBridgeL2Facet Contract
contract TestGnosisBridgeL2Facet is GnosisBridgeL2Facet {
    constructor(IXDaiBridgeL2 _xDaiBridge) GnosisBridgeL2Facet(_xDaiBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GnosisBridgeL2FacetTest is TestBaseFacet {
    // EVENTS

    // These values are for Mainnet
    address internal constant XDAI_BRIDGE =
        0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6;
    // -----

    TestGnosisBridgeL2Facet internal gnosisBridgeL2Facet;

    function setUp() public {
        // Fork Gnosis chain
        customRpcUrlForForking = "ETH_NODE_URI_GNOSIS";
        customBlockNumberForForking = 26862566;
        ADDRESS_USDC = 0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83;
        ADDRESS_USDT = 0x4ECaBa5870353805a9F068101A40E0f32ed605C6;
        ADDRESS_DAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI
        ADDRESS_WETH = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
        ADDRESS_UNISWAP = 0x1C232F01118CB8B424793ae03F870aa7D0ac7f77;

        initTestBase();

        gnosisBridgeL2Facet = new TestGnosisBridgeL2Facet(
            IXDaiBridgeL2(XDAI_BRIDGE)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = gnosisBridgeL2Facet
            .startBridgeTokensViaXDaiBridge
            .selector;
        functionSelectors[1] = gnosisBridgeL2Facet
            .swapAndStartBridgeTokensViaXDaiBridge
            .selector;
        functionSelectors[2] = gnosisBridgeL2Facet.addDex.selector;
        functionSelectors[3] = gnosisBridgeL2Facet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(gnosisBridgeL2Facet), functionSelectors);

        gnosisBridgeL2Facet = TestGnosisBridgeL2Facet(address(diamond));

        gnosisBridgeL2Facet.addDex(address(uniswap));
        gnosisBridgeL2Facet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        gnosisBridgeL2Facet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        gnosisBridgeL2Facet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(gnosisBridgeL2Facet), "GnosisFacet");

        bridgeData.bridge = "gnosis";
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultDAIAmount;
        bridgeData.destinationChainId = 1;

        setDefaultSwapData();
    }

    function setDefaultSwapData() internal {
        delete swapData;
        // Swap USDC -> xDAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountOut = defaultDAIAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForETH.selector,
                    amountIn,
                    amountOut,
                    path,
                    address(gnosisBridgeL2Facet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            gnosisBridgeL2Facet.startBridgeTokensViaXDaiBridge{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData);
        } else {
            gnosisBridgeL2Facet.startBridgeTokensViaXDaiBridge{
                value: addToMessageValue
            }(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            gnosisBridgeL2Facet.swapAndStartBridgeTokensViaXDaiBridge{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData);
        } else {
            gnosisBridgeL2Facet.swapAndStartBridgeTokensViaXDaiBridge{
                value: addToMessageValue
            }(bridgeData, swapData);
        }
    }

    function testBase_CanBridgeTokens() public override {
        // facet does not support token bridging
    }

    function testBase_CanBridgeNativeTokens()
        public
        override
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((100 ether + addToMessageValue))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 100 ether;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        usdc.approve(
            address(gnosisBridgeL2Facet),
            10_000 * 10 ** usdc.decimals()
        );

        setDefaultSwapData();
        bridgeData.hasSourceSwaps = true;

        gnosisBridgeL2Facet.swapAndStartBridgeTokensViaXDaiBridge(
            bridgeData,
            swapData
        );

        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // skip
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        // this test case does not work for this facet since the facet just bridges whatever msg.value it finds
    }
}
