// // SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "ds-test/test.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";
import { AcrossFacetPacked } from "lifi/Facets/AcrossFacetPacked.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { TestBase } from "../utils/TestBase.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LiFiDiamond } from "../utils/DiamondTest.sol";
import { console2 } from "forge-std/console2.sol";

contract AcrossFacetPackedTest is TestBase {
    using SafeERC20 for IERC20;

    bytes public constant ACROSS_REFERRER_DELIMITER = hex"d00dfeeddeadbeef";
    address public constant ACROSS_REFERRER_ADDRESS =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
    address internal constant ACROSS_SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address internal ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    IAcrossSpokePool internal across;
    ERC20 internal usdt;
    AcrossFacetPacked internal acrossFacetPacked;
    AcrossFacetPacked internal acrossStandAlone;
    AcrossFacet.AcrossData internal validAcrossData;

    bytes32 transactionId;
    uint64 destinationChainId;

    uint256 amountNative;
    bytes packedNativeCalldata;

    uint256 amountUSDT;
    bytes packedUSDTCalldata;

    uint256 amountUSDC;
    bytes packedUSDCCalldata;

    event LiFiAcrossTransfer(bytes8 _transactionId);

    function setUp() public {
        customBlockNumberForForking = 19145375;

        initTestBase();

        usdt = ERC20(ADDRESS_USDT);

        /// Prepare AcrossFacetPacked (as facet & as standalone contract to test both modes)
        diamond = createDiamond();
        across = IAcrossSpokePool(ACROSS_SPOKE_POOL);
        acrossFacetPacked = new AcrossFacetPacked(
            across,
            ADDRESS_WETH,
            address(this)
        );
        acrossStandAlone = new AcrossFacetPacked(
            across,
            ADDRESS_WETH,
            address(this)
        );

        bytes4[] memory functionSelectors = new bytes4[](10);
        functionSelectors[0] = acrossFacetPacked.setApprovalForBridge.selector;
        functionSelectors[1] = acrossFacetPacked
            .startBridgeTokensViaAcrossNativePacked
            .selector;
        functionSelectors[2] = acrossFacetPacked
            .startBridgeTokensViaAcrossNativeMin
            .selector;
        functionSelectors[3] = acrossFacetPacked
            .startBridgeTokensViaAcrossERC20Packed
            .selector;
        functionSelectors[4] = acrossFacetPacked
            .startBridgeTokensViaAcrossERC20Min
            .selector;
        functionSelectors[5] = acrossFacetPacked
            .encode_startBridgeTokensViaAcrossNativePacked
            .selector;
        functionSelectors[6] = acrossFacetPacked
            .encode_startBridgeTokensViaAcrossERC20Packed
            .selector;
        functionSelectors[7] = acrossFacetPacked
            .decode_startBridgeTokensViaAcrossNativePacked
            .selector;
        functionSelectors[8] = acrossFacetPacked
            .decode_startBridgeTokensViaAcrossERC20Packed
            .selector;
        functionSelectors[9] = acrossFacetPacked.containsReferrerId.selector;

        // add facet to diamond
        addFacet(diamond, address(acrossFacetPacked), functionSelectors);
        acrossFacetPacked = AcrossFacetPacked(payable(address(diamond)));

        /// Prepare parameters
        transactionId = "someID";
        destinationChainId = 137;

        // define valid AcrossData
        validAcrossData = AcrossFacet.AcrossData({
            relayerFeePct: 0,
            quoteTimestamp: uint32(block.timestamp),
            message: "",
            maxCount: type(uint256).max
        });

        vm.label(ACROSS_SPOKE_POOL, "SpokePool");
        vm.label(ADDRESS_USDT, "USDT_TOKEN");

        // Native params
        amountNative = 1 ether;
        packedNativeCalldata = acrossFacetPacked
            .encode_startBridgeTokensViaAcrossNativePacked(
                transactionId,
                USER_RECEIVER,
                destinationChainId,
                validAcrossData.relayerFeePct,
                validAcrossData.quoteTimestamp,
                validAcrossData.maxCount,
                validAcrossData.message
            );
        packedNativeCalldata = addReferrerIdToCalldata(packedNativeCalldata);

        // usdt params
        amountUSDT = 100 * 10 ** usdt.decimals();
        packedUSDTCalldata = acrossFacetPacked
            .encode_startBridgeTokensViaAcrossERC20Packed(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDT,
                amountUSDT,
                destinationChainId,
                validAcrossData.relayerFeePct,
                validAcrossData.quoteTimestamp,
                validAcrossData.message,
                validAcrossData.maxCount
            );
        packedUSDTCalldata = addReferrerIdToCalldata(packedUSDTCalldata);

        deal(ADDRESS_USDT, USER_SENDER, amountUSDT);

        // usdc params
        amountUSDC = 100 * 10 ** usdc.decimals();
        packedUSDCCalldata = acrossFacetPacked
            .encode_startBridgeTokensViaAcrossERC20Packed(
                transactionId,
                USER_RECEIVER,
                ADDRESS_USDC,
                amountUSDC,
                destinationChainId,
                validAcrossData.relayerFeePct,
                validAcrossData.quoteTimestamp,
                validAcrossData.message,
                validAcrossData.maxCount
            );
        packedUSDCCalldata = addReferrerIdToCalldata(packedUSDCCalldata);

        // Prepare approvals
        address[] memory tokens = new address[](2);
        tokens[0] = ADDRESS_USDT;
        tokens[1] = ADDRESS_USDC;

        // set token approvals for standalone contract via admin function
        acrossStandAlone.setApprovalForBridge(tokens);

        // set token approvals for facet via cheatcode (in production we will do this via script)
        vm.startPrank(address(acrossFacetPacked));
        LibAsset.maxApproveERC20(
            IERC20(ADDRESS_USDT),
            ACROSS_SPOKE_POOL,
            type(uint256).max
        );
        usdc.approve(ACROSS_SPOKE_POOL, type(uint256).max);
        vm.stopPrank();
    }

    function addReferrerIdToCalldata(
        bytes memory callData
    ) internal pure returns (bytes memory) {
        return
            bytes.concat(
                callData,
                ACROSS_REFERRER_DELIMITER,
                bytes20(ACROSS_REFERRER_ADDRESS)
            );
    }

    function test_canBridgeNativeTokensViaPackedFunction_Facet() public {
        vm.startPrank(USER_SENDER);
        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(diamond).call{ value: amountNative }(
            packedNativeCalldata
        );
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeNativeTokensViaPackedFunction_Standalone() public {
        vm.startPrank(USER_SENDER);
        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(acrossStandAlone).call{
            value: amountNative
        }(packedNativeCalldata);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeNativeTokensViaMinFunction_Facet() public {
        vm.startPrank(USER_SENDER);
        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        acrossFacetPacked.startBridgeTokensViaAcrossNativeMin{
            value: amountNative
        }(
            transactionId,
            USER_RECEIVER,
            destinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );

        vm.stopPrank();
    }

    function test_canBridgeNativeTokensViaMinFunction_Standalone() public {
        vm.startPrank(USER_SENDER);
        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        acrossStandAlone.startBridgeTokensViaAcrossNativeMin{
            value: amountNative
        }(
            transactionId,
            USER_RECEIVER,
            destinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );

        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Facet_USDC() public {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDC).safeApprove(address(diamond), amountUSDC);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(diamond).call(packedUSDCCalldata);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Facet_USDT() public {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDT * 100);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(diamond).call(packedUSDTCalldata);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Standalone_USDC()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDC).safeApprove(
            address(acrossStandAlone),
            amountUSDC
        );

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(acrossStandAlone).call(packedUSDCCalldata);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaPackedFunction_Standalone_USDT()
        public
    {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(
            address(acrossStandAlone),
            amountUSDT
        );
        // usdt.approve(address(diamond), amountUSDT);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(acrossStandAlone).call(packedUSDTCalldata);
        if (!success) {
            revert();
        }
        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Facet_USDC() public {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        usdc.approve(address(diamond), amountUSDC);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        acrossFacetPacked.startBridgeTokensViaAcrossERC20Min(
            transactionId,
            ADDRESS_USDC,
            amountUSDC,
            USER_RECEIVER,
            destinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );

        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Facet_USDT() public {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDT);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        acrossFacetPacked.startBridgeTokensViaAcrossERC20Min(
            transactionId,
            ADDRESS_USDT,
            amountUSDT,
            USER_RECEIVER,
            destinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );

        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Standalone_USDC() public {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        usdc.approve(address(acrossStandAlone), amountUSDC);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        acrossStandAlone.startBridgeTokensViaAcrossERC20Min(
            transactionId,
            ADDRESS_USDC,
            amountUSDC,
            USER_RECEIVER,
            destinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );

        vm.stopPrank();
    }

    function test_canBridgeERC20TokensViaMinFunction_Standalone_USDT() public {
        vm.startPrank(USER_SENDER);

        // approve diamond to spend sender's tokens
        IERC20(ADDRESS_USDT).safeApprove(
            address(acrossStandAlone),
            amountUSDT
        );

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        acrossStandAlone.startBridgeTokensViaAcrossERC20Min(
            transactionId,
            ADDRESS_USDT,
            amountUSDT,
            USER_RECEIVER,
            destinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );

        vm.stopPrank();
    }

    function assertEqAcrossData(
        AcrossFacet.AcrossData memory original,
        AcrossFacet.AcrossData memory decoded
    ) public {
        assertEq(original.relayerFeePct == decoded.relayerFeePct, true);
        assertEq(original.quoteTimestamp == decoded.quoteTimestamp, true);
        assertEq(
            keccak256(abi.encode(original.message)) ==
                keccak256(abi.encode(decoded.message)),
            true
        );
        assertEq(original.relayerFeePct == decoded.relayerFeePct, true);
    }

    function assertEqBridgeData(BridgeData memory original) public {
        assertEq(original.transactionId == transactionId, true);
        assertEq(original.receiver == USER_RECEIVER, true);
        assertEq(original.destinationChainId == destinationChainId, true);
    }

    function test_canEncodeAndDecodeNativePackedCalldata() public {
        (
            BridgeData memory bridgeData,
            AcrossFacet.AcrossData memory acrossData
        ) = acrossFacetPacked.decode_startBridgeTokensViaAcrossNativePacked(
                packedNativeCalldata
            );

        // validate bridgeData
        assertEqBridgeData(bridgeData);

        // validate acrossData
        assertEqAcrossData(validAcrossData, acrossData);
    }

    function test_canEncodeAndDecodeERC20PackedCalldata() public {
        (
            BridgeData memory bridgeData,
            AcrossFacet.AcrossData memory acrossData
        ) = acrossFacetPacked.decode_startBridgeTokensViaAcrossERC20Packed(
                packedUSDCCalldata
            );

        // validate bridgeData
        assertEqBridgeData(bridgeData);
        assertEq(bridgeData.minAmount == amountUSDC, true);
        assertEq(bridgeData.sendingAssetId == ADDRESS_USDC, true);

        // validate acrossData
        assertEqAcrossData(validAcrossData, acrossData);
    }

    function test_revert_cannotEncodeDestinationChainIdAboveUint32Max_Native()
        public
    {
        uint64 invalidDestinationChainId = uint64(type(uint32).max) + 1;

        vm.expectRevert(
            "destinationChainId value passed too big to fit in uint32"
        );

        acrossFacetPacked.encode_startBridgeTokensViaAcrossNativePacked(
            transactionId,
            USER_RECEIVER,
            invalidDestinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.maxCount,
            validAcrossData.message
        );
    }

    function test_revert_cannotEncodeDestinationChainIdAboveUint32Max_ERC20()
        public
    {
        uint64 invalidDestinationChainId = uint64(type(uint32).max) + 1;

        // USDC
        vm.expectRevert(
            "destinationChainId value passed too big to fit in uint32"
        );

        acrossFacetPacked.encode_startBridgeTokensViaAcrossERC20Packed(
            transactionId,
            USER_RECEIVER,
            ADDRESS_USDC,
            amountUSDC,
            invalidDestinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );
    }

    function test_revert_cannotUseMinAmountAboveUint128Max_ERC20() public {
        uint256 invalidMinAmount = uint256(type(uint128).max) + 1;

        vm.expectRevert("minAmount value passed too big to fit in uint128");

        acrossFacetPacked.encode_startBridgeTokensViaAcrossERC20Packed(
            transactionId,
            USER_RECEIVER,
            ADDRESS_USDT,
            invalidMinAmount,
            destinationChainId,
            validAcrossData.relayerFeePct,
            validAcrossData.quoteTimestamp,
            validAcrossData.message,
            validAcrossData.maxCount
        );
    }

    function test_canIdentifyReferrerIdInCalldataWithArbitraryAddresses()
        public
    {
        // test with arbitrary address as referrer address after delimiter
        bytes
            memory callData = hex"5a39b10a6e8101a9437d9f3329dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000102165db2957ebf7c65cc292cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd00dfeeddeadbeefdAC17F958D2ee523a2206206994597C13D831ec7";

        bool result = acrossFacetPacked.containsReferrerId(callData);

        assertTrue(result);

        // test with address(0) as referrer address after delimiter
        bytes
            memory callData2 = hex"5a39b10a6e8101a9437d9f3329dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000102165db2957ebf7c65cc292cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd00dfeeddeadbeef0000000000000000000000000000000000000000";

        bool result2 = acrossFacetPacked.containsReferrerId(callData2);

        assertTrue(result2);
    }

    function test_doesNotRecognizeIncorrectReferrerDelimiter() public {
        // use a wrong delimiter (d00dfeaddeadbeef instead of the correct value d00dfeeddeadbeef)
        bytes
            memory callData = hex"5a39b10a6e8101a9437d9f3329dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000102165db2957ebf7c65cc292cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd00dfeaddeadbeefdAC17F958D2ee523a2206206994597C13D831ec7";

        bool result = acrossFacetPacked.containsReferrerId(callData);

        assertFalse(result);

        // use delimiter in wrong position (d00dfeaddeadbeef instead of the correct value d00dfeeddeadbeef)
        bytes
            memory callData2 = hex"5a39b10a6e8101a9437d9f3329dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000102165db2957ebf7c65cc292cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd00dfeeddeadbeef32eb23bad9bddb5cf81426f78279a53c6c3b71";

        bool result2 = acrossFacetPacked.containsReferrerId(callData2);

        assertFalse(result2);
    }
}
