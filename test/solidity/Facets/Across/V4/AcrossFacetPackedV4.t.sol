// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";
import { AcrossFacetPackedV4 } from "lifi/Facets/AcrossFacetPackedV4.sol";
import { IAcrossSpokePoolV4 } from "lifi/Interfaces/IAcrossSpokePoolV4.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { TestBase } from "../../../utils/TestBase.sol";
import { UnAuthorized, InvalidConfig } from "src/Errors/GenericErrors.sol";

contract TestClaimContract {
    using SafeERC20 for IERC20;

    IERC20 internal usdt = IERC20(0xdAC17F958D2ee523a2206206994597C13D831ec7);

    error ClaimFailed();

    // sends 100 USDT to msg.sender
    function claimRewards() external {
        usdt.safeTransfer(msg.sender, 100 * 10 ** 6);
    }

    function willFail() external pure {
        revert ClaimFailed();
    }
}

contract AcrossFacetPackedV4Test is TestBase {
    using SafeERC20 for IERC20;

    error InvalidDestinationChainId();
    error InvalidInputAmount();
    error InvalidCalldataLength();

    address internal constant ACROSS_SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address internal constant ACROSS_MERKLE_DISTRIBUTOR =
        0xE50b2cEAC4f60E840Ae513924033E753e2366487;
    address internal constant ADDRESS_ACX_TOKEN =
        0x44108f0223A3C3028F5Fe7AEC7f9bb2E66beF82F;

    bytes internal constant WITHDRAW_REWARDS_CALLDATA =
        abi.encodeWithSignature("claimRewards()");
    bytes internal constant WILL_FAIL_CALLDATA =
        abi.encodeWithSignature("willFail()");

    IAcrossSpokePoolV4 internal spokepool;
    AcrossFacetPackedV4 internal acrossFacetPackedV4;
    AcrossFacetPackedV4 internal acrossStandAlone;
    AcrossFacetV4.AcrossV4Data internal validAcrossData;
    AcrossFacetPackedV4.PackedParameters internal packedParameters;
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
        customBlockNumberForForking = 22993652;

        initTestBase();

        /// Deploy contracts
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        spokepool = IAcrossSpokePoolV4(ACROSS_SPOKE_POOL);
        acrossFacetPackedV4 = new AcrossFacetPackedV4(
            spokepool,
            _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE),
            address(this)
        );
        acrossStandAlone = new AcrossFacetPackedV4(
            spokepool,
            _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE),
            address(this)
        );
        claimContract = new TestClaimContract();

        bytes4[] memory functionSelectors = new bytes4[](9);
        functionSelectors[0] = AcrossFacetPackedV4
            .setApprovalForBridge
            .selector;
        functionSelectors[1] = AcrossFacetPackedV4
            .startBridgeTokensViaAcrossV4NativePacked
            .selector;
        functionSelectors[2] = AcrossFacetPackedV4
            .startBridgeTokensViaAcrossV4NativeMin
            .selector;
        functionSelectors[3] = AcrossFacetPackedV4
            .startBridgeTokensViaAcrossV4ERC20Packed
            .selector;
        functionSelectors[4] = AcrossFacetPackedV4
            .startBridgeTokensViaAcrossV4ERC20Min
            .selector;
        functionSelectors[5] = AcrossFacetPackedV4
            .encode_startBridgeTokensViaAcrossV4NativePacked
            .selector;
        functionSelectors[6] = AcrossFacetPackedV4
            .encode_startBridgeTokensViaAcrossV4ERC20Packed
            .selector;
        functionSelectors[7] = AcrossFacetPackedV4
            .decode_startBridgeTokensViaAcrossV4NativePacked
            .selector;
        functionSelectors[8] = AcrossFacetPackedV4
            .decode_startBridgeTokensViaAcrossV4ERC20Packed
            .selector;

        // add facet to diamond
        addFacet(diamond, address(acrossFacetPackedV4), functionSelectors);
        acrossFacetPackedV4 = AcrossFacetPackedV4(payable(address(diamond)));

        /// Prepare parameters
        transactionId = "someID";
        destinationChainId = 137;

        // define valid AcrossData
        uint32 quoteTimestamp = uint32(block.timestamp - 1);
        validAcrossData = AcrossFacetV4.AcrossV4Data({
            receiverAddress: _convertAddressToBytes32(USER_RECEIVER),
            refundAddress: _convertAddressToBytes32(USER_SENDER), // Set to match the depositor
            sendingAssetId: _convertAddressToBytes32(ADDRESS_USDC),
            receivingAssetId: _convertAddressToBytes32(ADDRESS_USDC_POL),
            outputAmount: (defaultUSDCAmount * 99) / 100, // 99%
            outputAmountMultiplier: uint64(1000000000000000000), // 100.00%
            exclusiveRelayer: bytes32(0),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 1000),
            exclusivityParameter: 0,
            message: ""
        });

        packedParameters = AcrossFacetPackedV4.PackedParameters({
            transactionId: transactionId,
            receiver: _convertAddressToBytes32(USER_RECEIVER),
            depositor: _convertAddressToBytes32(USER_SENDER),
            destinationChainId: destinationChainId,
            receivingAssetId: _convertAddressToBytes32(ADDRESS_USDC_POL),
            outputAmount: (defaultUSDCAmount * 99) / 100,
            exclusiveRelayer: bytes32(0),
            quoteTimestamp: quoteTimestamp,
            fillDeadline: uint32(quoteTimestamp + 1000),
            exclusivityParameter: 0,
            message: ""
        });

        vm.label(ACROSS_SPOKE_POOL, "SpokePool_PROX");
        vm.label(0x08C21b200eD06D2e32cEC91a770C3FcA8aD5F877, "SpokePool_IMPL");
        vm.label(ADDRESS_USDT, "USDT_TOKEN");
        vm.label(ACROSS_MERKLE_DISTRIBUTOR, "ACROSS_MERKLE_DISTRIBUTOR");

        // Native params
        amountNative = 1 ether;
        packedNativeCalldata = acrossFacetPackedV4
            .encode_startBridgeTokensViaAcrossV4NativePacked(packedParameters);

        // usdt params
        amountUSDT = 100 * 10 ** usdt.decimals();
        packedUSDTCalldata = acrossFacetPackedV4
            .encode_startBridgeTokensViaAcrossV4ERC20Packed(
                packedParameters,
                _convertAddressToBytes32(ADDRESS_USDT),
                amountUSDT
            );

        deal(ADDRESS_USDT, USER_SENDER, amountUSDT);

        // usdc params
        amountUSDC = 100 * 10 ** usdc.decimals();
        packedParameters.outputAmount = (amountUSDC * 99) / 100;
        packedUSDCCalldata = acrossFacetPackedV4
            .encode_startBridgeTokensViaAcrossV4ERC20Packed(
                packedParameters,
                _convertAddressToBytes32(ADDRESS_USDC),
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
        vm.startPrank(address(acrossFacetPackedV4));
        LibAsset.maxApproveERC20(
            IERC20(ADDRESS_USDT),
            ACROSS_SPOKE_POOL,
            type(uint256).max
        );
        usdc.approve(ACROSS_SPOKE_POOL, type(uint256).max);
        vm.stopPrank();
    }

    function testRevert_WhenInvalidConfig() public {
        // Test with zero spokepool
        vm.expectRevert(InvalidConfig.selector);
        new AcrossFacetPackedV4(
            IAcrossSpokePoolV4(address(0)),
            _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE),
            address(this)
        );

        // Test with zero wrapped native
        vm.expectRevert(InvalidConfig.selector);
        new AcrossFacetPackedV4(
            IAcrossSpokePoolV4(ACROSS_SPOKE_POOL),
            bytes32(0),
            address(this)
        );

        // Test with zero owner
        vm.expectRevert(InvalidConfig.selector);
        new AcrossFacetPackedV4(
            IAcrossSpokePoolV4(ACROSS_SPOKE_POOL),
            _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE),
            address(0)
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
        acrossFacetPackedV4.startBridgeTokensViaAcrossV4NativeMin{
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
        acrossStandAlone.startBridgeTokensViaAcrossV4NativeMin{
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
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), 0);
        IERC20(ADDRESS_USDT).safeApprove(address(diamond), amountUSDT);

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(diamond).call(packedUSDTCalldata);
        if (!success) {
            revert ERC20BridgeFailed();
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
            revert ERC20BridgeFailed();
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

        // check that event is emitted correctly
        vm.expectEmit(true, true, true, true, address(acrossStandAlone));
        emit LiFiAcrossTransfer(bytes8(transactionId));

        // call facet through diamond
        (bool success, ) = address(acrossStandAlone).call(packedUSDTCalldata);
        if (!success) {
            revert ERC20BridgeFailed();
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
        acrossFacetPackedV4.startBridgeTokensViaAcrossV4ERC20Min(
            packedParameters,
            _convertAddressToBytes32(ADDRESS_USDC),
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
        acrossFacetPackedV4.startBridgeTokensViaAcrossV4ERC20Min(
            packedParameters,
            _convertAddressToBytes32(ADDRESS_USDT),
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
        acrossStandAlone.startBridgeTokensViaAcrossV4ERC20Min(
            packedParameters,
            _convertAddressToBytes32(ADDRESS_USDC),
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
        acrossStandAlone.startBridgeTokensViaAcrossV4ERC20Min(
            packedParameters,
            _convertAddressToBytes32(ADDRESS_USDT),
            amountUSDT
        );

        vm.stopPrank();
    }

    function assertEqAcrossData(
        AcrossFacetV4.AcrossV4Data memory original,
        AcrossFacetV4.AcrossV4Data memory decoded
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
        assertEq(
            _convertAddressToBytes32(original.receiver) ==
                _convertAddressToBytes32(USER_RECEIVER),
            true
        );
        assertEq(original.destinationChainId == destinationChainId, true);
    }

    function test_canEncodeAndDecodeNativePackedCalldata() public {
        (
            BridgeData memory bridgeData,
            AcrossFacetV4.AcrossV4Data memory acrossData
        ) = acrossFacetPackedV4
                .decode_startBridgeTokensViaAcrossV4NativePacked(
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
            AcrossFacetV4.AcrossV4Data memory acrossData
        ) = acrossFacetPackedV4.decode_startBridgeTokensViaAcrossV4ERC20Packed(
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
            AcrossFacetPackedV4.InvalidDestinationChainId.selector
        );

        acrossFacetPackedV4.encode_startBridgeTokensViaAcrossV4NativePacked(
            packedParameters
        );
    }

    function test_revert_cannotEncodeDestinationChainIdAboveUint32Max_ERC20()
        public
    {
        packedParameters.destinationChainId = uint64(type(uint32).max) + 1; // invalid destinationChainId

        vm.expectRevert(
            AcrossFacetPackedV4.InvalidDestinationChainId.selector
        );

        acrossFacetPackedV4.encode_startBridgeTokensViaAcrossV4ERC20Packed(
            packedParameters,
            _convertAddressToBytes32(ADDRESS_USDC),
            amountUSDC
        );
    }

    function testRevert_cannotUseMinAmountAboveUint128Max_ERC20() public {
        uint256 invalidInputAmount = uint256(type(uint128).max) + 1;

        vm.expectRevert(AcrossFacetPackedV4.InvalidInputAmount.selector);

        acrossFacetPackedV4.encode_startBridgeTokensViaAcrossV4ERC20Packed(
            packedParameters,
            _convertAddressToBytes32(ADDRESS_USDC),
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

    function testRevert_WillRevertIfExecuteCallAndWithdrawFails() public {
        vm.expectRevert();
        acrossStandAlone.executeCallAndWithdraw(
            address(claimContract),
            WILL_FAIL_CALLDATA,
            ADDRESS_USDT,
            address(this),
            amountUSDT
        );
    }

    function testRevert_WillNotExecuteCallAndWithdrawForNonOwner() public {
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
        acrossFacetPackedV4 = new AcrossFacetPackedV4(
            IAcrossSpokePoolV4(ACROSS_SPOKE_POOL),
            _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE),
            address(this)
        );

        assertEq(
            address(acrossFacetPackedV4.SPOKEPOOL()) == ACROSS_SPOKE_POOL,
            true
        );
        assertEq(
            acrossFacetPackedV4.WRAPPED_NATIVE() ==
                _convertAddressToBytes32(ADDRESS_WRAPPED_NATIVE),
            true
        );
    }

    /// @notice Converts an address to a bytes32
    /// @param _address The address to convert
    function _convertAddressToBytes32(
        address _address
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_address)));
    }

    /// @notice  Compare two bytes32 values
    /// @param _a The first bytes32 to compare
    /// @param _b The second bytes32 to compare
    function _compareBytes32(
        bytes32 _a,
        bytes32 _b
    ) internal pure returns (bool) {
        return keccak256(abi.encode(_a)) == keccak256(abi.encode(_b));
    }

    function testRevert_WillFailIfNativeCalldataLengthIsTooShort() public {
        // Create calldata that is shorter than the required 188 bytes
        bytes memory shortCalldata = new bytes(187); // 1 byte short

        vm.expectRevert(InvalidCalldataLength.selector);

        acrossFacetPackedV4.decode_startBridgeTokensViaAcrossV4NativePacked(
            shortCalldata
        );
    }

    function testRevert_WillFailIfERC20CalldataLengthIsTooShort() public {
        // Create calldata that is shorter than the required 236 bytes
        bytes memory shortCalldata = new bytes(235); // 1 byte short

        vm.expectRevert(InvalidCalldataLength.selector);

        acrossFacetPackedV4.decode_startBridgeTokensViaAcrossV4ERC20Packed(
            shortCalldata
        );
    }
}
