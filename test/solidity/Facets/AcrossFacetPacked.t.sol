// // SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";
import { AcrossFacetPacked } from "lifi/Facets/AcrossFacetPacked.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { TestBase } from "../utils/TestBase.sol";
import { MockFailingContract } from "../utils/MockFailingContract.sol";

import { UnAuthorized } from "src/Errors/GenericErrors.sol";

contract TestClaimContract {
    using SafeERC20 for IERC20;

    IERC20 internal usdt = IERC20(0xdAC17F958D2ee523a2206206994597C13D831ec7);

    // sends 100 USDT to msg.sender
    function claimRewards() external {
        usdt.safeTransfer(msg.sender, 100 * 10 ** 6);
    }
}

contract AcrossFacetPackedTest is TestBase {
    using SafeERC20 for IERC20;

    bytes public constant ACROSS_REFERRER_DELIMITER = hex"d00dfeeddeadbeef";
    address public constant ACROSS_REFERRER_ADDRESS =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
    address internal constant ACROSS_SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address internal constant ACROSS_MERKLE_DISTRIBUTOR =
        0xE50b2cEAC4f60E840Ae513924033E753e2366487;
    address internal constant ADDRESS_ACX_TOKEN =
        0x44108f0223A3C3028F5Fe7AEC7f9bb2E66beF82F;

    bytes internal constant WITHDRAW_REWARDS_CALLDATA =
        abi.encodeWithSignature("claimRewards()");

    IAcrossSpokePool internal across;
    AcrossFacetPacked internal acrossFacetPacked;
    AcrossFacetPacked internal acrossStandAlone;
    AcrossFacet.AcrossData internal validAcrossData;
    TestClaimContract internal claimContract;

    bytes32 internal transactionId;
    uint64 internal destinationChainId;

    uint256 internal amountNative;
    bytes internal packedNativeCalldata;

    uint256 internal amountUSDT;
    bytes internal packedUSDTCalldata;

    uint256 internal amountUSDC;
    bytes internal packedUSDCCalldata;

    event LiFiAcrossTransfer(bytes8 _transactionId);

    function setUp() public {
        customBlockNumberForForking = 19145375;

        initTestBase();

        /// Deploy contracts
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        across = IAcrossSpokePool(ACROSS_SPOKE_POOL);
        acrossFacetPacked = new AcrossFacetPacked(
            across,
            ADDRESS_WRAPPED_NATIVE,
            address(this)
        );
        acrossStandAlone = new AcrossFacetPacked(
            across,
            ADDRESS_WRAPPED_NATIVE,
            address(this)
        );
        claimContract = new TestClaimContract();

        bytes4[] memory functionSelectors = new bytes4[](9);
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
            message: "bla",
            maxCount: type(uint256).max
        });

        vm.label(ACROSS_SPOKE_POOL, "SpokePool");
        vm.label(ADDRESS_USDT, "USDT_TOKEN");
        vm.label(ACROSS_MERKLE_DISTRIBUTOR, "ACROSS_MERKLE_DISTRIBUTOR");

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

        // fund claim rewards contract
        deal(ADDRESS_USDT, address(claimContract), amountUSDT);

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
            revert NativeBridgeFailed();
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
            revert NativeBridgeFailed();
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
            revert NativeBridgeFailed();
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
            revert NativeBridgeFailed();
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
            revert NativeBridgeFailed();
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
            revert NativeBridgeFailed();
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

    function test_canExecuteCallAndWithdraw() public {
        acrossStandAlone.executeCallAndWithdraw(
            address(claimContract),
            WITHDRAW_REWARDS_CALLDATA,
            ADDRESS_USDT,
            address(this),
            amountUSDT
        );
    }

    /// @notice Fails to execute extra call and withdraw from non-owner.
    /// @dev It calls executeCallAndWithdraw from address that is not OWNER_ADDRESS.
    function test_revert_WillNotExecuteCallAndWithdrawForNonOwner() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(UnAuthorized.selector);

        acrossStandAlone.executeCallAndWithdraw(
            ACROSS_MERKLE_DISTRIBUTOR,
            WITHDRAW_REWARDS_CALLDATA,
            ADDRESS_ACX_TOKEN,
            address(this),
            amountUSDT
        );
        vm.stopPrank();
    }

    function testRevert_FailIfCallToExternalContractFails() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        MockFailingContract failingContract = new MockFailingContract();

        vm.expectRevert(AcrossFacetPacked.WithdrawFailed.selector);

        acrossStandAlone.executeCallAndWithdraw(
            address(failingContract),
            WITHDRAW_REWARDS_CALLDATA,
            ADDRESS_USDT,
            address(this),
            amountUSDT
        );

        vm.startPrank(USER_DIAMOND_OWNER);
    }
}
