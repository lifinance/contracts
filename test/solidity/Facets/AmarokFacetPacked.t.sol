// // SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "ds-test/test.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import { AmarokFacetPacked } from "lifi/Facets/AmarokFacetPacked.sol";
import { IConnextHandler } from "lifi/Interfaces/IConnextHandler.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { console, TestBase } from "../utils/TestBase.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LiFiDiamond } from "../utils/DiamondTest.sol";

contract AmarokFacetPackedTest is TestBase {
    using SafeERC20 for IERC20;

    address internal constant CONNEXT_HANDLER =
        0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6;
    address internal ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    uint256 internal BSC_CHAIN_ID = 56;

    IConnextHandler internal amarok;
    ERC20 internal usdt;
    AmarokFacetPacked internal amarokFacetPacked;
    AmarokFacetPacked internal amarokStandAlone;
    AmarokFacet.AmarokData internal validAmarokData;
    uint256 internal defaultRelayerFee;

    bytes32 transactionId;
    uint64 destinationChainId;

    uint256 amountUSDT;
    bytes packedUSDTCalldataPayFeeWithNative;
    bytes packedUSDTCalldataPayFeeWithAsset;

    // uint256 amountUSDC;
    // bytes packedUSDCCalldata;

    event LiFiAmarokTransfer(bytes8 _transactionId);

    function setUp() public {
        customBlockNumberForForking = 19145375;

        initTestBase();

        usdt = ERC20(ADDRESS_USDT);

        /// Prepare AmarokFacetPacked (as facet & as standalone contract to test both modes)
        diamond = createDiamond();
        amarok = IConnextHandler(CONNEXT_HANDLER);
        amarokFacetPacked = new AmarokFacetPacked(amarok, address(this));
        amarokStandAlone = new AmarokFacetPacked(amarok, address(this));

        bytes4[] memory functionSelectors = new bytes4[](9);
        functionSelectors[0] = amarokFacetPacked.setApprovalForBridge.selector;
        functionSelectors[1] = amarokFacetPacked
            .startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset
            .selector;
        functionSelectors[2] = amarokFacetPacked
            .startBridgeTokensViaAmarokERC20PackedPayFeeWithNative
            .selector;
        functionSelectors[3] = amarokFacetPacked
            .startBridgeTokensViaAmarokERC20MinPayFeeWithAsset
            .selector;
        functionSelectors[4] = amarokFacetPacked
            .startBridgeTokensViaAmarokERC20MinPayFeeWithNative
            .selector;
        functionSelectors[5] = amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset
            .selector;
        functionSelectors[6] = amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative
            .selector;
        functionSelectors[7] = amarokFacetPacked
            .decode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset
            .selector;
        functionSelectors[8] = amarokFacetPacked
            .decode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative
            .selector;

        // add facet to diamond
        addFacet(diamond, address(amarokFacetPacked), functionSelectors);
        amarokFacetPacked = AmarokFacetPacked(payable(address(diamond)));

        /// Prepare parameters
        transactionId = "someID";
        destinationChainId = 137;

        defaultRelayerFee = 800000;

        // define valid AmarokData
        validAmarokData = AmarokFacet.AmarokData({
            callData: "",
            callTo: USER_RECEIVER,
            relayerFee: defaultRelayerFee,
            slippageTol: 300, // 3%
            delegate: USER_RECEIVER,
            destChainDomainId: 6450786, // BSC
            payFeeWithSendingAsset: true
        });

        vm.label(CONNEXT_HANDLER, "ConnextHandler");
        vm.label(ADDRESS_USDT, "USDT_TOKEN");

        // usdt params
        amountUSDT = 100 * 10 ** usdt.decimals();
        packedUSDTCalldataPayFeeWithNative = amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                validAmarokData.destChainDomainId,
                validAmarokData.slippageTol
            );

        packedUSDTCalldataPayFeeWithAsset = amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                validAmarokData.destChainDomainId,
                validAmarokData.slippageTol,
                defaultRelayerFee
            );

        deal(ADDRESS_USDT, USER_SENDER, amountUSDT);

        // Prepare approvals
        address[] memory tokens = new address[](2);
        tokens[0] = ADDRESS_USDT;
        tokens[1] = ADDRESS_USDC;

        // set token approvals for standalone contract via admin function
        amarokStandAlone.setApprovalForBridge(tokens);

        // set token approvals for facet via cheatcode (in production we will do this via script)
        vm.startPrank(address(amarokFacetPacked));
        LibAsset.maxApproveERC20(
            IERC20(ADDRESS_USDT),
            CONNEXT_HANDLER,
            type(uint256).max
        );
        usdc.approve(CONNEXT_HANDLER, type(uint256).max);
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Facet_PayFeeWithAsset()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDT);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(diamond).call(
            packedUSDTCalldataPayFeeWithAsset
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Facet_PayFeeWithNative()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDT);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(diamond).call{ value: defaultRelayerFee }(
            packedUSDTCalldataPayFeeWithNative
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Facet_PayFeeWithAsset()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDT);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet through diamond
        AmarokFacetPacked(address(diamond))
            .startBridgeTokensViaAmarokERC20MinPayFeeWithAsset(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                validAmarokData.destChainDomainId,
                validAmarokData.slippageTol,
                validAmarokData.relayerFee
            );

        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Facet_PayFeeWithNative()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDT);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet through diamond
        AmarokFacetPacked(address(diamond))
            .startBridgeTokensViaAmarokERC20MinPayFeeWithNative{
            value: defaultRelayerFee
        }(
            transactionId,
            USER_RECEIVER,
            ADDRESS_USDT,
            amountUSDT,
            validAmarokData.destChainDomainId,
            validAmarokData.slippageTol
        );

        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Standalone_PayFeeWithAsset()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(
            address(amarokStandAlone),
            amountUSDT
        );

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(amarokStandAlone));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet directly (standalone)
        (bool success, ) = address(amarokStandAlone).call(
            packedUSDTCalldataPayFeeWithAsset
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Standalone_PayFeeWithNative()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(
            address(amarokStandAlone),
            amountUSDT
        );

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(amarokStandAlone));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet directly (standalone)
        (bool success, ) = address(amarokStandAlone).call{
            value: defaultRelayerFee
        }(packedUSDTCalldataPayFeeWithNative);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Standalone_PayFeeWithAsset()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(
            address(amarokStandAlone),
            amountUSDT
        );

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(amarokStandAlone));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet directly (standalone)
        AmarokFacetPacked(address(amarokStandAlone))
            .startBridgeTokensViaAmarokERC20MinPayFeeWithAsset(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                validAmarokData.destChainDomainId,
                validAmarokData.slippageTol,
                validAmarokData.relayerFee
            );

        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Standalone_PayFeeWithNative()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(
            address(amarokStandAlone),
            amountUSDT
        );

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(amarokStandAlone));
        emit LiFiAmarokTransfer(bytes8(transactionId));

        // call facet through diamond
        AmarokFacetPacked(address(amarokStandAlone))
            .startBridgeTokensViaAmarokERC20MinPayFeeWithNative{
            value: defaultRelayerFee
        }(
            transactionId,
            USER_RECEIVER,
            ADDRESS_USDT,
            amountUSDT,
            validAmarokData.destChainDomainId,
            validAmarokData.slippageTol
        );

        vm.stopPrank();
    }

    function assertEqAmarokData(
        AmarokFacet.AmarokData memory original,
        AmarokFacet.AmarokData memory decoded
    ) public {
        assertEq(original.callTo == decoded.callTo, true);
        assertEq(original.slippageTol == decoded.slippageTol, true);
        assertEq(original.delegate == decoded.delegate, true);
        assertEq(
            original.destChainDomainId == decoded.destChainDomainId,
            true
        );
    }

    function assertEqBridgeData(BridgeData memory original) public {
        assertEq(original.transactionId == transactionId, true);
        assertEq(original.receiver == USER_RECEIVER, true);
        assertEq(original.destinationChainId == BSC_CHAIN_ID, true);
        assertEq(original.sendingAssetId == ADDRESS_USDT, true);
        assertEq(original.minAmount == amountUSDT, true);
    }

    function test_canEncodeAndDecodeERC20PackedCalldata_PayFeesWithNative()
        public
    {
        (
            BridgeData memory bridgeData,
            AmarokFacet.AmarokData memory amarokData
        ) = amarokFacetPacked
                .decode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative(
                    packedUSDTCalldataPayFeeWithNative
                );

        // validate bridgeData
        assertEqBridgeData(bridgeData);

        // validate amarokData
        assertEqAmarokData(validAmarokData, amarokData);
        assertEq(amarokData.payFeeWithSendingAsset == false, true);
    }

    function test_canEncodeAndDecodeERC20PackedCalldata_PayFeesWithAsset()
        public
    {
        (
            BridgeData memory bridgeData,
            AmarokFacet.AmarokData memory amarokData
        ) = amarokFacetPacked
                .decode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset(
                    packedUSDTCalldataPayFeeWithAsset
                );

        // validate bridgeData
        assertEqBridgeData(bridgeData);

        // validate amarokData
        assertEqAmarokData(validAmarokData, amarokData);
        assertEq(amarokData.payFeeWithSendingAsset == true, true);
        assertEq(amarokData.relayerFee == defaultRelayerFee, true);
    }

    function test_revert_cannotUseRelayerFeeAboveUint128Max_ERC20() public {
        uint256 invalidRelayerFee = uint256(type(uint128).max) + 1;

        vm.expectRevert("relayerFee value passed too big to fit in uint128");

        amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                validAmarokData.destChainDomainId,
                validAmarokData.slippageTol,
                invalidRelayerFee
            );
    }

    function test_revert_cannotUseMinAmountAboveUint128Max_ERC20() public {
        uint256 invalidMinAmount = uint256(type(uint128).max) + 1;

        vm.expectRevert("minAmount value passed too big to fit in uint128");

        amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                invalidMinAmount,
                validAmarokData.destChainDomainId,
                validAmarokData.slippageTol,
                validAmarokData.relayerFee
            );

        vm.expectRevert("minAmount value passed too big to fit in uint128");

        amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                invalidMinAmount,
                validAmarokData.destChainDomainId,
                validAmarokData.slippageTol
            );
    }

    function test_revert_cannotUseSlippageTolAboveUint32Max_ERC20() public {
        uint256 invalidSlippageTol = uint256(type(uint32).max) + 1;

        vm.expectRevert("slippageTol value passed too big to fit in uint32");

        amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithAsset(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                validAmarokData.destChainDomainId,
                invalidSlippageTol,
                validAmarokData.relayerFee
            );

        vm.expectRevert("slippageTol value passed too big to fit in uint32");

        amarokFacetPacked
            .encode_startBridgeTokensViaAmarokERC20PackedPayFeeWithNative(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                validAmarokData.destChainDomainId,
                invalidSlippageTol
            );
    }
}
