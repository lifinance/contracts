// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibSwap, TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { CentrifugeFacet } from "lifi/Facets/CentrifugeFacet.sol";
import { ICentrifugeTokenBridge } from "lifi/Interfaces/ICentrifugeTokenBridge.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { TransferFromFailed, InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Mock Centrifuge TokenBridge for testing
contract MockCentrifugeTokenBridge is ICentrifugeTokenBridge {
    function send(
        address token,
        uint256 amount,
        bytes32,
        uint256,
        address
    ) external payable returns (bytes memory) {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        return bytes("");
    }
}

// Stub CentrifugeFacet Contract
contract TestCentrifugeFacet is CentrifugeFacet, TestWhitelistManagerBase {
    constructor(
        ICentrifugeTokenBridge _tokenBridge
    ) CentrifugeFacet(_tokenBridge) {}
}

contract CentrifugeFacetTest is TestBaseFacet {
    TestCentrifugeFacet internal centrifugeFacet;
    MockCentrifugeTokenBridge internal mockTokenBridge;
    CentrifugeFacet.CentrifugeData internal validCentrifugeData;

    function setUp() public {
        customBlockNumberForForking = 24826000;
        initTestBase();

        mockTokenBridge = new MockCentrifugeTokenBridge();

        centrifugeFacet = new TestCentrifugeFacet(
            ICentrifugeTokenBridge(address(mockTokenBridge))
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = centrifugeFacet
            .startBridgeTokensViaCentrifuge
            .selector;
        functionSelectors[1] = centrifugeFacet
            .swapAndStartBridgeTokensViaCentrifuge
            .selector;
        functionSelectors[2] = centrifugeFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = centrifugeFacet
            .removeAllowedContractSelector
            .selector;

        addFacet(diamond, address(centrifugeFacet), functionSelectors);

        centrifugeFacet = TestCentrifugeFacet(address(diamond));

        centrifugeFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapExactTokensForTokens.selector
        );
        centrifugeFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapExactTokensForETH.selector
        );
        centrifugeFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapTokensForExactETH.selector
        );
        centrifugeFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(centrifugeFacet),
            "CentrifugeFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "centrifuge";
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = defaultDAIAmount;
        bridgeData.destinationChainId = 137;

        // produce valid CentrifugeData
        validCentrifugeData = CentrifugeFacet.CentrifugeData({
            receiver: bytes32(uint256(uint160(USER_RECEIVER)))
        });

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
                    address(centrifugeFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        centrifugeFacet.startBridgeTokensViaCentrifuge(
            bridgeData,
            validCentrifugeData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            centrifugeFacet.swapAndStartBridgeTokensViaCentrifuge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validCentrifugeData);
        } else {
            centrifugeFacet.swapAndStartBridgeTokensViaCentrifuge(
                bridgeData,
                swapData,
                validCentrifugeData
            );
        }
    }

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

        dai.approve(address(centrifugeFacet), bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(centrifugeFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        usdc.approve(
            address(centrifugeFacet),
            10_000 * 10 ** usdc.decimals()
        );

        setDefaultSwapData();
        bridgeData.hasSourceSwaps = true;

        centrifugeFacet.swapAndStartBridgeTokensViaCentrifuge(
            bridgeData,
            swapData,
            validCentrifugeData
        );

        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        vm.startPrank(USER_SENDER);

        dai.approve(address(centrifugeFacet), defaultDAIAmount);

        dai.transfer(USER_RECEIVER, dai.balanceOf(USER_SENDER));

        vm.expectRevert(TransferFromFailed.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** dai.decimals();

        dai.approve(address(centrifugeFacet), amount);

        bridgeData.minAmount = amount;

        vm.expectEmit(true, true, true, true, address(centrifugeFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestCentrifugeFacet(ICentrifugeTokenBridge(address(0)));
    }
}
