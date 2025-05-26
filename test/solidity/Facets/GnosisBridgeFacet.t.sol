// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibSwap, TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { GnosisBridgeFacet } from "lifi/Facets/GnosisBridgeFacet.sol";
import { IGnosisBridgeRouter } from "lifi/Interfaces/IGnosisBridgeRouter.sol";
import { TransferFromFailed } from "lifi/Errors/GenericErrors.sol";

// Stub GnosisBridgeFacet Contract
contract TestGnosisBridgeFacet is GnosisBridgeFacet {
    constructor(
        IGnosisBridgeRouter _xDaiBridge
    ) GnosisBridgeFacet(_xDaiBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GnosisBridgeFacetTest is TestBaseFacet {
    // EVENTS

    // These values are for Mainnet
    address internal constant GNOSIS_BRIDGE_ROUTER =
        0x9a873656c19Efecbfb4f9FAb5B7acdeAb466a0B0;
    address internal constant ADDRESS_USDS =
        0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    // -----
    ERC20 internal usds;
    uint256 internal defaultUSDSAmount;

    TestGnosisBridgeFacet internal gnosisBridgeFacet;

    function setUp() public {
        customBlockNumberForForking = 22566858;
        initTestBase();
        defaultUSDSAmount = defaultDAIAmount;

        usds = ERC20(ADDRESS_USDS);

        deal(ADDRESS_USDS, USER_SENDER, defaultUSDSAmount);

        gnosisBridgeFacet = new TestGnosisBridgeFacet(
            IGnosisBridgeRouter(GNOSIS_BRIDGE_ROUTER)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = gnosisBridgeFacet
            .startBridgeTokensViaGnosisBridge
            .selector;
        functionSelectors[1] = gnosisBridgeFacet
            .swapAndStartBridgeTokensViaGnosisBridge
            .selector;
        functionSelectors[2] = gnosisBridgeFacet.addDex.selector;
        functionSelectors[3] = gnosisBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(gnosisBridgeFacet), functionSelectors);

        gnosisBridgeFacet = TestGnosisBridgeFacet(address(diamond));

        gnosisBridgeFacet.addDex(address(uniswap));
        gnosisBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        gnosisBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        gnosisBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(gnosisBridgeFacet), "GnosisFacet");

        bridgeData.bridge = "gnosis";
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = defaultDAIAmount;
        bridgeData.destinationChainId = 100;

        setDefaultSwapData();
    }

    function setDefaultSwapData() internal {
        delete swapData;
        // Swap USDC -> DAI
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
                receivingAssetId: ADDRESS_DAI,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    path,
                    address(gnosisBridgeFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        gnosisBridgeFacet.startBridgeTokensViaGnosisBridge(bridgeData);
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            gnosisBridgeFacet.swapAndStartBridgeTokensViaGnosisBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            gnosisBridgeFacet.swapAndStartBridgeTokensViaGnosisBridge(
                bridgeData,
                swapData
            );
        }
    }

    // DAI case
    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(defaultDAIAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval
        dai.approve(address(gnosisBridgeFacet), bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(gnosisBridgeFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // DAI case
    function testBase_CanBridgeToken_WithUSDS()
        public
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(
            ADDRESS_USDS,
            USER_SENDER,
            -int256(defaultDAIAmount)
        )
        assertBalanceChange(ADDRESS_USDS, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_USDS;

        usds.approve(address(gnosisBridgeFacet), bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(gnosisBridgeFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        usdc.approve(
            address(gnosisBridgeFacet),
            10_000 * 10 ** usdc.decimals()
        );

        setDefaultSwapData();
        bridgeData.hasSourceSwaps = true;

        gnosisBridgeFacet.swapAndStartBridgeTokensViaGnosisBridge(
            bridgeData,
            swapData
        );

        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        vm.startPrank(USER_SENDER);

        dai.approve(address(address(gnosisBridgeFacet)), defaultDAIAmount);

        dai.transfer(USER_RECEIVER, dai.balanceOf(USER_SENDER));

        vm.expectRevert(TransferFromFailed.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** dai.decimals();

        // approval
        dai.approve(address(gnosisBridgeFacet), amount);

        bridgeData.minAmount = amount;

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(gnosisBridgeFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}
