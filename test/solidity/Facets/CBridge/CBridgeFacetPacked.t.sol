// // SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ContractCallNotAllowed, ExternalCallFailed, UnAuthorized } from "lifi/Errors/GenericErrors.sol";
import { TestBase } from "../../utils/TestBase.sol";
import { MockLiquidityBridge } from "../../utils/MockLiquidityBridge.sol";

contract CBridgeFacetPackedTest is TestBase {
    address internal constant CBRIDGE_ROUTER =
        0x1619DE6B6B20eD217a58d00f37B9d47C7663feca;
    address internal constant USDT_ADDRESS =
        0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address internal constant USDC_ADDRESS =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant WHALE =
        0xF3F094484eC6901FfC9681bCb808B96bAFd0b8a8; // usdt + ETH
    address internal constant RECEIVER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    ICBridge internal cbridge;
    CBridgeFacetPacked internal cBridgeFacetPacked;
    CBridgeFacetPacked internal standAlone;

    bytes32 internal transactionId;
    uint64 internal destinationChainId;
    uint64 internal nonce;
    uint32 internal maxSlippage;

    uint256 internal amountNative;
    bytes internal packedNative;

    uint256 internal amountUSDT;
    bytes internal packedUSDT;

    uint256 internal amountUSDC;
    bytes internal packedUSDC;

    event CBridgeRefund(
        address indexed _assetAddress,
        address indexed _to,
        uint256 amount
    );

    function setUp() public override {
        customBlockNumberForForking = 58467500;
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        initTestBase();

        /// Perpare CBridgeFacetPacked
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        cbridge = ICBridge(CBRIDGE_ROUTER);
        cBridgeFacetPacked = new CBridgeFacetPacked(cbridge, address(this));
        standAlone = new CBridgeFacetPacked(cbridge, address(this));

        deal(ADDRESS_USDC, address(WHALE), 100000 * 10 ** usdc.decimals());

        bytes4[] memory functionSelectors = new bytes4[](9);
        functionSelectors[0] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[1] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeNativeMin
            .selector;
        functionSelectors[2] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeERC20Packed
            .selector;
        functionSelectors[3] = cBridgeFacetPacked
            .startBridgeTokensViaCBridgeERC20Min
            .selector;
        functionSelectors[4] = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[5] = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed
            .selector;
        functionSelectors[6] = cBridgeFacetPacked
            .decode_startBridgeTokensViaCBridgeNativePacked
            .selector;
        functionSelectors[7] = cBridgeFacetPacked
            .decode_startBridgeTokensViaCBridgeERC20Packed
            .selector;
        functionSelectors[8] = cBridgeFacetPacked.triggerRefund.selector;

        addFacet(
            address(diamond),
            address(cBridgeFacetPacked),
            functionSelectors
        );
        cBridgeFacetPacked = CBridgeFacetPacked(payable(address(diamond)));

        /// Perpare parameters
        transactionId = "someID";
        destinationChainId = 137;
        maxSlippage = 5000;

        // Native params
        amountNative = 1 ether;
        packedNative = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                nonce,
                maxSlippage
            );

        // usdt params
        amountUSDT = 100 * 10 ** usdt.decimals();
        packedUSDT = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                ADDRESS_USDT,
                amountUSDT,
                nonce,
                maxSlippage
            );

        // usdc params
        amountUSDC = 100 * 10 ** usdc.decimals();
        packedUSDC = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                ADDRESS_USDC,
                amountUSDC,
                nonce,
                maxSlippage
            );

        // Prepare approvals
        address[] memory tokens = new address[](2);
        tokens[0] = ADDRESS_USDT;
        tokens[1] = ADDRESS_USDC;
        vm.startPrank(address(cBridgeFacetPacked));
        usdt.approve(CBRIDGE_ROUTER, type(uint256).max);
        usdc.approve(CBRIDGE_ROUTER, type(uint256).max);
        vm.stopPrank();
        standAlone.setApprovalForBridge(tokens);

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(cBridgeFacetPacked),
            "CBridgeFacetPacked"
        );
    }

    function testStartBridgeTokensViaCBridgeNativePacked() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(diamond).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert NativeBridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNativePacked_StandAlone() public {
        vm.startPrank(WHALE);
        (bool success, ) = address(standAlone).call{ value: amountNative }(
            packedNative
        );
        if (!success) {
            revert NativeBridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeNativeMin() public {
        vm.startPrank(WHALE);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeNativeMin{
            value: amountNative
        }(
            transactionId,
            RECEIVER,
            uint64(destinationChainId),
            nonce,
            maxSlippage
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed_USDT() public {
        vm.startPrank(WHALE);
        usdt.approve(address(diamond), amountUSDT);
        (bool success, ) = address(diamond).call(packedUSDT);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed_StandAlone_USDT()
        public
    {
        vm.startPrank(WHALE);
        usdt.approve(address(standAlone), amountUSDT);
        (bool success, ) = address(standAlone).call(packedUSDT);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Min_USDT() public {
        vm.startPrank(WHALE);
        usdt.approve(address(diamond), amountUSDT);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Min(
            transactionId,
            RECEIVER,
            uint64(destinationChainId),
            ADDRESS_USDT,
            amountUSDT,
            nonce,
            maxSlippage
        );
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed_USDC() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        (bool success, ) = address(diamond).call(packedUSDC);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Packed_StandAlone_USDC()
        public
    {
        vm.startPrank(WHALE);
        usdc.approve(address(standAlone), amountUSDC);
        (bool success, ) = address(standAlone).call(packedUSDC);
        if (!success) {
            revert ERC20BridgeFailed();
        }
        vm.stopPrank();
    }

    function testStartBridgeTokensViaCBridgeERC20Min_USDC() public {
        vm.startPrank(WHALE);
        usdc.approve(address(diamond), amountUSDC);
        cBridgeFacetPacked.startBridgeTokensViaCBridgeERC20Min(
            transactionId,
            RECEIVER,
            uint64(destinationChainId),
            ADDRESS_USDC,
            amountUSDC,
            nonce,
            maxSlippage
        );
        vm.stopPrank();
    }

    function testEncodeNativeValidation() public {
        // destinationChainId
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max),
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max) + 1,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            137,
            uint64(type(uint32).max),
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeNativePacked(
            transactionId,
            RECEIVER,
            137,
            uint64(type(uint32).max) + 1,
            maxSlippage
        );
    }

    function testEncodeERC20Validation() public {
        // destinationChainId
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max),
            ADDRESS_USDT,
            amountUSDT,
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            uint64(type(uint32).max) + 1,
            ADDRESS_USDT,
            amountUSDT,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            ADDRESS_USDT,
            uint256(type(uint128).max),
            nonce,
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            ADDRESS_USDT,
            uint256(type(uint128).max) + 1,
            nonce,
            maxSlippage
        );

        // nonce
        // > max allowed
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            ADDRESS_USDT,
            amountUSDT,
            uint64(type(uint32).max),
            maxSlippage
        );
        // > too big
        vm.expectRevert();
        cBridgeFacetPacked.encode_startBridgeTokensViaCBridgeERC20Packed(
            transactionId,
            RECEIVER,
            137,
            ADDRESS_USDT,
            amountUSDT,
            uint64(type(uint32).max) + 1,
            maxSlippage
        );
    }

    function test_CanEncodeAndDecodeCBridgeNativeCall() public {
        bytes memory encoded = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeNativePacked(
                transactionId,
                RECEIVER,
                destinationChainId,
                nonce,
                maxSlippage
            );

        (
            ILiFi.BridgeData memory decodedBridgeData,
            CBridgeFacet.CBridgeData memory decodedCBridgeData
        ) = cBridgeFacetPacked.decode_startBridgeTokensViaCBridgeNativePacked(
                encoded
            );
        assertEq(
            decodedBridgeData.transactionId,
            transactionId,
            "transactionId does not match"
        );
        assertEq(
            decodedBridgeData.receiver,
            RECEIVER,
            "Receiver does not match"
        );
        assertEq(
            decodedBridgeData.destinationChainId,
            destinationChainId,
            "destinationChainId does not match"
        );
        assertEq(
            decodedCBridgeData.maxSlippage,
            maxSlippage,
            "maxSlippage does not match"
        );
        assertEq(decodedCBridgeData.nonce, nonce, "nonce does not match");
    }

    function test_CanEncodeAndDecodeCBridgeERC20Call() public {
        bytes memory encoded = cBridgeFacetPacked
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                transactionId,
                RECEIVER,
                destinationChainId,
                ADDRESS_USDT,
                amountUSDT,
                nonce,
                maxSlippage
            );
        (
            ILiFi.BridgeData memory decodedBridgeData,
            CBridgeFacet.CBridgeData memory decodedCBridgeData
        ) = cBridgeFacetPacked.decode_startBridgeTokensViaCBridgeERC20Packed(
                encoded
            );
        assertEq(
            decodedBridgeData.transactionId,
            transactionId,
            "transactionId does not match"
        );
        assertEq(
            decodedBridgeData.receiver,
            RECEIVER,
            "Receiver does not match"
        );
        assertEq(
            decodedBridgeData.destinationChainId,
            destinationChainId,
            "destinationChainId does not match"
        );
        assertEq(
            decodedBridgeData.sendingAssetId,
            ADDRESS_USDT,
            "sendingAssetId does not match"
        );
        assertEq(
            decodedBridgeData.minAmount,
            amountUSDT,
            "minAmount does not match"
        );
        assertEq(
            decodedCBridgeData.maxSlippage,
            maxSlippage,
            "maxSlippage does not match"
        );
        assertEq(decodedCBridgeData.nonce, nonce, "nonce does not match");
    }

    function test_CanTriggerRefund() public {
        uint256 refundAmount = 0.1 ether;
        address userReceiver = 0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
        deal(CBRIDGE_ROUTER, refundAmount); // fund router

        uint256 preRefundBalance = address(userReceiver).balance;

        // replace bridge
        vm.allowCheatcodes(CBRIDGE_ROUTER);
        MockLiquidityBridge lb = new MockLiquidityBridge();
        vm.etch(CBRIDGE_ROUTER, address(lb).code);

        // refund
        standAlone.triggerRefund(
            payable(CBRIDGE_ROUTER), // Celer Liquidity Bridge
            abi.encodeWithSelector(
                MockLiquidityBridge.mockWithdraw.selector,
                refundAmount
            ), // Calldata
            address(0), // Native asset
            payable(userReceiver), // Address to refund to
            refundAmount
        );

        // validate
        uint256 postRefundBalance = address(userReceiver).balance;
        assertEq(
            postRefundBalance - preRefundBalance,
            refundAmount,
            "Refund amount should be correct"
        );
    }

    function test_TriggerRefundSucceedsWhenCalledByOwnerWithExplicitReceiver()
        public
        assertBalanceChange(ADDRESS_USDT, USER_RECEIVER, 100_000)
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        address callTo = CBRIDGE_ROUTER;
        bytes memory callData = abi.encodeWithSignature("someFunction()");
        address assetAddress = ADDRESS_USDT;
        address to = USER_RECEIVER;
        uint256 amount = 100_000;

        deal(ADDRESS_USDT, address(standAlone), amount);
        uint256 cBridgeBalanceBefore = ERC20(ADDRESS_USDT).balanceOf(
            address(standAlone)
        );

        vm.mockCall(callTo, callData, abi.encode(true));

        vm.expectEmit(true, true, true, true, address(standAlone));
        emit CBridgeRefund(assetAddress, to, amount);

        standAlone.triggerRefund(
            payable(callTo),
            callData,
            assetAddress,
            to,
            amount
        );

        uint256 cBridgeBalanceAfter = ERC20(ADDRESS_USDT).balanceOf(
            address(standAlone)
        );

        assertEq(cBridgeBalanceBefore - cBridgeBalanceAfter, amount);

        vm.stopPrank();
    }

    function test_TriggerRefundSucceedsWhenCalledByOwnerWithoutExplicitReceiver()
        public
        assertBalanceChange(ADDRESS_USDT, USER_DIAMOND_OWNER, 100_000)
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        address callTo = CBRIDGE_ROUTER;
        bytes memory callData = abi.encodeWithSignature("someFunction()");
        address assetAddress = ADDRESS_USDT;
        address to = address(0);
        uint256 amount = 100_000;

        deal(ADDRESS_USDT, address(standAlone), amount);
        uint256 cBridgeBalanceBefore = ERC20(ADDRESS_USDT).balanceOf(
            address(standAlone)
        );

        vm.mockCall(callTo, callData, abi.encode(true));

        vm.expectEmit(true, true, true, true, address(standAlone));
        emit CBridgeRefund(assetAddress, USER_DIAMOND_OWNER, amount);

        standAlone.triggerRefund(
            payable(callTo),
            callData,
            assetAddress,
            to,
            amount
        );

        uint256 cBridgeBalanceAfter = ERC20(ADDRESS_USDT).balanceOf(
            address(standAlone)
        );

        assertEq(cBridgeBalanceBefore - cBridgeBalanceAfter, amount);

        vm.stopPrank();
    }

    function testRevert_TriggerRefundFailsWhenCalledByNonOwner() public {
        vm.startPrank(USER_SENDER);

        address callTo = CBRIDGE_ROUTER;
        bytes memory callData = abi.encodeWithSignature("someFunction()");
        address assetAddress = ADDRESS_USDT;
        address to = USER_RECEIVER;
        uint256 amount = 100 * 10 ** usdt.decimals();

        vm.expectRevert(UnAuthorized.selector);

        standAlone.triggerRefund(
            payable(callTo),
            callData,
            assetAddress,
            to,
            amount
        );

        vm.stopPrank();
    }

    function testRevert_TriggerRefundFailsWhenTryingToCallDiffrentContractThanCBridgeRouter()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        address callTo = address(0xdeadbeef);
        bytes memory callData = abi.encodeWithSignature("someFunction()");
        address assetAddress = ADDRESS_USDT;
        address to = USER_RECEIVER;
        uint256 amount = 100 * 10 ** usdt.decimals();

        vm.expectRevert(ContractCallNotAllowed.selector);

        standAlone.triggerRefund(
            payable(callTo),
            callData,
            assetAddress,
            to,
            amount
        );

        vm.stopPrank();
    }

    function testRevert_TriggerRefundFailsWhenCallToCBridgeRouterFails()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        address callTo = CBRIDGE_ROUTER; // must match the expected `CBRIDGE_ROUTER` address
        bytes memory callData = abi.encodeWithSignature("someFunction()");
        address assetAddress = ADDRESS_USDT;
        address to = USER_RECEIVER;
        uint256 amount = 100 * 10 ** usdt.decimals();

        vm.expectRevert(ExternalCallFailed.selector);

        standAlone.triggerRefund(
            payable(callTo),
            callData,
            assetAddress,
            to,
            amount
        );

        vm.stopPrank();
    }
}
