// // SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "ds-test/test.sol";
import { AcrossFacetV3 } from "lifi/Facets/AcrossFacetV3.sol";
import { AcrossFacetPackedV3, TransferrableOwnership } from "lifi/Facets/AcrossFacetPackedV3.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { console, TestBase } from "../utils/TestBase.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LiFiDiamond } from "../utils/DiamondTest.sol";

import { UnAuthorized } from "src/Errors/GenericErrors.sol";

contract TestClaimContract {
    using SafeERC20 for IERC20;

    IERC20 internal usdt = IERC20(0xdAC17F958D2ee523a2206206994597C13D831ec7);

    // sends 100 USDT to msg.sender
    function claimRewards() external {
        usdt.safeTransfer(msg.sender, 100 * 10 ** 6);
    }

    function willFail() external pure {
        revert();
    }
}

contract AcrossFacetPackedV3Test is TestBase {
    using SafeERC20 for IERC20;

    address internal constant ACROSS_SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address internal ACROSS_MERKLE_DISTRIBUTOR =
        0xE50b2cEAC4f60E840Ae513924033E753e2366487;
    address internal ADDRESS_ACX_TOKEN =
        0x44108f0223A3C3028F5Fe7AEC7f9bb2E66beF82F;

    bytes internal WITHDRAW_REWARDS_CALLDATA =
        abi.encodeWithSignature("claimRewards()");
    bytes internal WILL_FAIL_CALLDATA = abi.encodeWithSignature("willFail()");

    // hex"6be65179000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000025caeae03fa5e8a977e00000000000000000000000000000000000000000000000000000000000000010000000000000000000000001231deb6f5749ef6ce6943a275a1d3e7486f4eae00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000001055b9ce9b3807a4c1c9fc153177c53f06a40ba12d85ce795dde69d6eef999a7282c5ebbef91605a598965d1b963839cd0e36ac96ddcf53c200b1dd078301fb60991645e735d8523c0ddcee94e99db3d6cfc776becceb9babb4eee7d809b0a713436657df91f4ec9632556d4568a8604f76803fcf31a7f2297154dbf15fe4dedd4119740befa50ec31eecdc2407e7e294d5347166c79a062cf1b5e23908d76a10be7444d231b26cbed964c0d15c4aaa6fe4993becd1258cc2fa21a0d6ac29d89b57c9229e5ae3e0bd5587e19598f18679e9cb7e83196b39cbbf526076002219b9f74ff541139196c51f181c06194141c0b7d7af034a186a7bf862c7513e5398ccfa151bc3c6ff4689f723450d099644a46b6dbe639ff9ead83bf219648344cabfab2aa64aaa9f3eda6a4c824313a3e5005591c2e954f87e3b9f2228e87cf346f13c19136eca2ce03070ad5a063196e28955317b796ac7122bea188a8a615982531e84b5577546abc99c21005b2c0bd40700159702d4bf99334d3a3bb4cb8482085aefceb8f2e73ecff885d542e44e69206a0c27e6d2cc0401db980cc5c1e67c984b3f0ec51e1e15d3311d4feed306df497d582f55e1bd8e67a4336d1e8614fdf5fbfbcbe4ddc694d5b97547584ec24c28f8bce7a6a724213dc6a92282e7409d1453a960df1a25d1db6799308467dc975a70d97405e48138f20e914f3d44e5b06dd";

    IAcrossSpokePool internal spokepool;
    AcrossFacetPackedV3 internal acrossFacetPackedV3;
    AcrossFacetPackedV3 internal acrossStandAlone;
    AcrossFacetV3.AcrossV3Data internal validAcrossData;
    AcrossFacetPackedV3.PackedParameters internal packedParameters;
    TestClaimContract internal claimContract;

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
        customBlockNumberForForking = 19960294;

        initTestBase();

        /// Deploy contracts
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        spokepool = IAcrossSpokePool(ACROSS_SPOKE_POOL);
        acrossFacetPackedV3 = new AcrossFacetPackedV3(
            spokepool,
            ADDRESS_WRAPPED_NATIVE,
            address(this)
        );
        acrossStandAlone = new AcrossFacetPackedV3(
            spokepool,
            ADDRESS_WRAPPED_NATIVE,
            address(this)
        );
        claimContract = new TestClaimContract();

        bytes4[] memory functionSelectors = new bytes4[](9);
        functionSelectors[0] = AcrossFacetPackedV3
            .setApprovalForBridge
            .selector;
        functionSelectors[1] = AcrossFacetPackedV3
            .startBridgeTokensViaAcrossV3NativePacked
            .selector;
        functionSelectors[2] = AcrossFacetPackedV3
            .startBridgeTokensViaAcrossV3NativeMin
            .selector;
        functionSelectors[3] = AcrossFacetPackedV3
            .startBridgeTokensViaAcrossV3ERC20Packed
            .selector;
        functionSelectors[4] = AcrossFacetPackedV3
            .startBridgeTokensViaAcrossV3ERC20Min
            .selector;
        functionSelectors[5] = AcrossFacetPackedV3
            .encode_startBridgeTokensViaAcrossV3NativePacked
            .selector;
        functionSelectors[6] = AcrossFacetPackedV3
            .encode_startBridgeTokensViaAcrossV3ERC20Packed
            .selector;
        functionSelectors[7] = AcrossFacetPackedV3
            .decode_startBridgeTokensViaAcrossV3NativePacked
            .selector;
        functionSelectors[8] = AcrossFacetPackedV3
            .decode_startBridgeTokensViaAcrossV3ERC20Packed
            .selector;

        // add facet to diamond
        addFacet(diamond, address(acrossFacetPackedV3), functionSelectors);
        acrossFacetPackedV3 = AcrossFacetPackedV3(payable(address(diamond)));

        /// Prepare parameters
        transactionId = "someID";
        destinationChainId = 137;

        // define valid AcrossData
        uint32 quoteTimestamp = uint32(block.timestamp);
        validAcrossData = AcrossFacetV3.AcrossV3Data({
            receiverAddress: USER_RECEIVER,
            refundAddress: USER_SENDER, // Set to match the depositor
            receivingAssetId: ADDRESS_USDC_POL,
            outputAmount: (defaultUSDCAmount * 9) / 10,
            exclusiveRelayer: address(0),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 1000),
            exclusivityDeadline: 0,
            message: ""
        });

        packedParameters = AcrossFacetPackedV3.PackedParameters({
            transactionId: transactionId,
            receiver: USER_RECEIVER,
            destinationChainId: destinationChainId,
            receivingAssetId: ADDRESS_USDC_POL,
            outputAmount: (defaultUSDCAmount * 9) / 10,
            exclusiveRelayer: address(0),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 1000),
            exclusivityDeadline: 0,
            message: "",
            depositor: USER_SENDER // Add depositor field
        });

        vm.label(ACROSS_SPOKE_POOL, "SpokePool_PROX");
        vm.label(0x08C21b200eD06D2e32cEC91a770C3FcA8aD5F877, "SpokePool_IMPL");
        vm.label(ADDRESS_USDT, "USDT_TOKEN");
        vm.label(ACROSS_MERKLE_DISTRIBUTOR, "ACROSS_MERKLE_DISTRIBUTOR");

        // Native params
        amountNative = 1 ether;
        packedNativeCalldata = acrossFacetPackedV3
            .encode_startBridgeTokensViaAcrossV3NativePacked(packedParameters);

        // usdt params
        amountUSDT = 100 * 10 ** usdt.decimals();
        packedUSDTCalldata = acrossFacetPackedV3
            .encode_startBridgeTokensViaAcrossV3ERC20Packed(
                packedParameters,
                ADDRESS_USDT,
                amountUSDT
            );

        deal(ADDRESS_USDT, USER_SENDER, amountUSDT);

        // usdc params
        amountUSDC = 100 * 10 ** usdc.decimals();
        packedParameters.outputAmount = (amountUSDC * 9) / 10;
        packedUSDCCalldata = acrossFacetPackedV3
            .encode_startBridgeTokensViaAcrossV3ERC20Packed(
                packedParameters,
                ADDRESS_USDC,
                amountUSDC
            );

        // fund claim rewards contract
        deal(ADDRESS_USDT, address(claimContract), amountUSDT);

        // Prepare approvals
        address[] memory tokens = new address[](2);
        tokens[0] = ADDRESS_USDT;
        tokens[1] = ADDRESS_USDC;

        // set token approvals for standalone contract via admin function
        acrossStandAlone.setApprovalForBridge(tokens);

        // set token approvals for facet via cheatcode (in production we will do this via script)
        vm.startPrank(address(acrossFacetPackedV3));
        LibAsset.maxApproveERC20(
            IERC20(ADDRESS_USDT),
            ACROSS_SPOKE_POOL,
            type(uint256).max
        );
        usdc.approve(ACROSS_SPOKE_POOL, type(uint256).max);
        vm.stopPrank();
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
        acrossFacetPackedV3.startBridgeTokensViaAcrossV3NativeMin{
            value: amountNative
        }(packedParameters);

        vm.stopPrank();
    }

    function test_canBridgeNativeTokensViaMinFunction_Standalone() public {
        vm.startPrank(USER_SENDER);
        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        acrossStandAlone.startBridgeTokensViaAcrossV3NativeMin{
            value: amountNative
        }(packedParameters);

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
        (bool success, bytes memory reason) = address(diamond).call(
            packedUSDCCalldata
        );
        if (!success) {
            revert(LibUtil.getRevertMsg(reason));
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
        acrossFacetPackedV3.startBridgeTokensViaAcrossV3ERC20Min(
            packedParameters,
            ADDRESS_USDC,
            amountUSDC
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
        acrossFacetPackedV3.startBridgeTokensViaAcrossV3ERC20Min(
            packedParameters,
            ADDRESS_USDT,
            amountUSDT
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
        acrossStandAlone.startBridgeTokensViaAcrossV3ERC20Min(
            packedParameters,
            ADDRESS_USDC,
            amountUSDC
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
        acrossStandAlone.startBridgeTokensViaAcrossV3ERC20Min(
            packedParameters,
            ADDRESS_USDT,
            amountUSDT
        );

        vm.stopPrank();
    }

    function assertEqAcrossData(
        AcrossFacetV3.AcrossV3Data memory original,
        AcrossFacetV3.AcrossV3Data memory decoded
    ) public {
        assertEq(original.receivingAssetId == decoded.receivingAssetId, true);
        assertEq(original.outputAmount == decoded.outputAmount, true);
        assertEq(original.fillDeadline == decoded.fillDeadline, true);
        assertEq(original.quoteTimestamp == decoded.quoteTimestamp, true);
        assertEq(original.refundAddress == decoded.refundAddress, true); // Add check for refundAddress/depositor
        assertEq(
            keccak256(abi.encode(original.message)) ==
                keccak256(abi.encode(decoded.message)),
            true
        );
    }

    function assertEqBridgeData(BridgeData memory original) public {
        assertEq(original.transactionId == transactionId, true);
        assertEq(original.receiver == USER_RECEIVER, true);
        assertEq(original.destinationChainId == destinationChainId, true);
    }

    function test_canEncodeAndDecodeNativePackedCalldata() public {
        (
            BridgeData memory bridgeData,
            AcrossFacetV3.AcrossV3Data memory acrossData
        ) = acrossFacetPackedV3
                .decode_startBridgeTokensViaAcrossV3NativePacked(
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
            AcrossFacetV3.AcrossV3Data memory acrossData
        ) = acrossFacetPackedV3.decode_startBridgeTokensViaAcrossV3ERC20Packed(
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
        packedParameters.destinationChainId = uint64(type(uint32).max) + 1; // invalid destinationChainId

        vm.expectRevert(
            "destinationChainId value passed too big to fit in uint32"
        );

        acrossFacetPackedV3.encode_startBridgeTokensViaAcrossV3NativePacked(
            packedParameters
        );
    }

    function test_revert_cannotEncodeDestinationChainIdAboveUint32Max_ERC20()
        public
    {
        packedParameters.destinationChainId = uint64(type(uint32).max) + 1; // invalid destinationChainId

        vm.expectRevert(
            "destinationChainId value passed too big to fit in uint32"
        );

        acrossFacetPackedV3.encode_startBridgeTokensViaAcrossV3ERC20Packed(
            packedParameters,
            ADDRESS_USDC,
            amountUSDC
        );
    }

    function test_revert_cannotUseMinAmountAboveUint128Max_ERC20() public {
        uint256 invalidInputAmount = uint256(type(uint128).max) + 1;

        vm.expectRevert("inputAmount value passed too big to fit in uint128");

        acrossFacetPackedV3.encode_startBridgeTokensViaAcrossV3ERC20Packed(
            packedParameters,
            ADDRESS_USDC,
            invalidInputAmount
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

    function test_WillRevertIfExecuteCallAndWithdrawFails() public {
        vm.expectRevert();
        acrossStandAlone.executeCallAndWithdraw(
            address(claimContract),
            WILL_FAIL_CALLDATA,
            ADDRESS_USDT,
            address(this),
            amountUSDT
        );
    }

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

    function test_contractIsSetUpCorrectly() public {
        acrossFacetPackedV3 = new AcrossFacetPackedV3(
            IAcrossSpokePool(ACROSS_SPOKE_POOL),
            ADDRESS_WRAPPED_NATIVE,
            address(this)
        );

        assertEq(
            address(acrossFacetPackedV3.spokePool()) == ACROSS_SPOKE_POOL,
            true
        );
        assertEq(
            acrossFacetPackedV3.wrappedNative() == ADDRESS_WRAPPED_NATIVE,
            true
        );
    }
}
