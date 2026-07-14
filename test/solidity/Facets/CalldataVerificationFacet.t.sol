// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { CalldataVerificationFacet } from "lifi/Facets/CalldataVerificationFacet.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";
import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";
import { StargateFacetV2 } from "lifi/Facets/StargateFacetV2.sol";
import { IStargate } from "lifi/Interfaces/IStargate.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestBaseLocal } from "../utils/TestBaseLocal.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { OFTComposeMsgCodec } from "lifi/Periphery/ReceiverStargateV2.sol";

contract CalldataVerificationFacetTest is TestBaseLocal {
    using LibBytes for bytes;
    using OFTComposeMsgCodec for address;

    CalldataVerificationFacet internal calldataVerificationFacet;

    error SliceOutOfBounds();

    function setUp() public {
        initTestBaseLocal();
        calldataVerificationFacet = new CalldataVerificationFacet();
        bridgeData = ILiFi.BridgeData({
            transactionId: keccak256("id"),
            bridge: "acme",
            integrator: "acme",
            referrer: address(0),
            sendingAssetId: address(123),
            receiver: address(456),
            minAmount: 1 ether,
            destinationChainId: 137,
            hasSourceSwaps: false,
            hasDestinationCall: true
        });

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(123),
                receivingAssetId: address(456),
                fromAmount: 1 ether,
                callData: abi.encodePacked("calldata"),
                requiresDeposit: true
            })
        );

        vm.label(
            address(calldataVerificationFacet),
            "CalldataVerificationFacet"
        );
    }

    function test_DeploysWithoutErrors() public {
        calldataVerificationFacet = new CalldataVerificationFacet();
    }

    function test_IgnoresExtraBytes() public view {
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4.selector,
            bridgeData,
            swapData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff");
        calldataVerificationFacet.extractBridgeData(fullCalldata);
        calldataVerificationFacet.extractSwapData(fullCalldata);
        calldataVerificationFacet.extractData(fullCalldata);
        calldataVerificationFacet.extractMainParameters(fullCalldata);
    }

    function test_CanExtractBridgeData() public {
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.startBridgeTokensViaAcrossV4.selector,
            bridgeData
        );

        ILiFi.BridgeData memory returnedData = calldataVerificationFacet
            .extractBridgeData(callData);

        checkBridgeData(returnedData);
    }

    function test_CanExtractSwapData() public {
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4.selector,
            bridgeData,
            swapData
        );

        LibSwap.SwapData[] memory returnedData = calldataVerificationFacet
            .extractSwapData(callData);

        checkSwapData(returnedData);
    }

    function test_CanExtractBridgeAndSwapData() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4.selector,
            bridgeData,
            swapData
        );

        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(callData);

        checkBridgeData(returnedBridgeData);
        checkSwapData(returnedSwapData);
    }

    function test_CanExtractBridgeAndSwapDataNoSwaps() public {
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.startBridgeTokensViaAcrossV4.selector,
            bridgeData
        );

        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(callData);

        checkBridgeData(returnedBridgeData);
        assertEq(returnedSwapData.length, 0);
    }

    function test_CanExtractNonEVMAddress() public {
        // produce valid MayanData
        MayanFacet.MayanData memory mayanData = MayanFacet.MayanData(
            bytes32("Just some address"),
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"00"
        );

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.startBridgeTokensViaMayan.selector,
            bridgeData,
            mayanData
        );

        bytes32 returnedNonEVMAddress = calldataVerificationFacet
            .extractNonEVMAddress(callData);

        assertEq(returnedNonEVMAddress, bytes32("Just some address"));
    }

    function test_CanExtractNonEVMAddressWithSwaps() public {
        bridgeData.hasSourceSwaps = true;

        // produce valid MayanData
        MayanFacet.MayanData memory mayanData = MayanFacet.MayanData(
            bytes32("Just some address"),
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"00"
        );

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.swapAndStartBridgeTokensViaMayan.selector,
            bridgeData,
            swapData,
            mayanData
        );

        bytes32 returnedNonEVMAddress = calldataVerificationFacet
            .extractNonEVMAddress(callData);

        assertEq(returnedNonEVMAddress, bytes32("Just some address"));
    }

    function testRevert_ExtractNonEVMAddressWithCorruptedOffset() public {
        // produce valid MayanData
        MayanFacet.MayanData memory mayanData = MayanFacet.MayanData(
            bytes32("Just some address"),
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"00"
        );

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.startBridgeTokensViaMayan.selector,
            bridgeData,
            mayanData
        );

        // BridgeData decodes fine on its own (it sits entirely within the first
        // 548 bytes), but truncating away the tail means the bridge-specific
        // data offset now points past the end of the buffer.
        callData = _safeSlice(callData, 0, 547);

        vm.expectRevert(InvalidCallData.selector);
        calldataVerificationFacet.extractNonEVMAddress(callData);
    }

    function testRevert_ExtractNonEVMAddressWithSwapsAndCorruptedOffset()
        public
    {
        bridgeData.hasSourceSwaps = true;

        // produce valid MayanData
        MayanFacet.MayanData memory mayanData = MayanFacet.MayanData(
            bytes32("Just some address"),
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"00"
        );

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.swapAndStartBridgeTokensViaMayan.selector,
            bridgeData,
            swapData,
            mayanData
        );

        callData = _safeSlice(callData, 0, 931);

        vm.expectRevert(InvalidCallData.selector);
        calldataVerificationFacet.extractNonEVMAddress(callData);
    }

    function testRevert_ExtractNonEVMAddressWithHugeOffset() public {
        // produce valid MayanData
        MayanFacet.MayanData memory mayanData = MayanFacet.MayanData(
            bytes32("Just some address"),
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"00"
        );

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.startBridgeTokensViaMayan.selector,
            bridgeData,
            mayanData
        );

        // overwrite the bridge-specific data offset (second param head slot,
        // bytes 36..68 of the buffer) with type(uint256).max so the bounds
        // check must catch it via InvalidCallData, not an overflow panic
        for (uint256 i = 36; i < 68; i++) {
            callData[i] = 0xff;
        }

        vm.expectRevert(InvalidCallData.selector);
        calldataVerificationFacet.extractNonEVMAddress(callData);
    }

    function test_CanExtractMainParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.startBridgeTokensViaAcrossV4.selector,
            bridgeData
        );

        (
            string memory bridge,
            address sendingAssetId,
            address receiver,
            uint256 minAmount,
            uint256 destinationChainId,
            bool hasSourceSwaps,
            bool hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(callData);

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, bridgeData.sendingAssetId);
        assertEq(minAmount, bridgeData.minAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);
    }

    // @dev Returns a slice of `data` starting at `start` with length `len`.
    // Uses memory-safe inline assembly to avoid the stack-too-deep issues.
    function _safeSlice(
        bytes memory data,
        uint256 start,
        uint256 len
    ) private pure returns (bytes memory result) {
        if (data.length < start + len) {
            revert SliceOutOfBounds();
        }
        assembly ("memory-safe") {
            // Load free memory pointer
            result := mload(0x40)
            // Store length in the first 32 bytes
            mstore(result, len)
            // Calculate the start pointers for source and destination copying
            let src := add(add(data, 32), start)
            let dest := add(result, 32)
            // Copy loop: copy 32 bytes per iteration
            for {
                let i := 0
            } lt(i, len) {
                i := add(i, 32)
            } {
                mstore(add(dest, i), mload(add(src, i)))
            }
            // Update free memory pointer with proper alignment
            mstore(0x40, add(dest, and(add(len, 31), not(31))))
        }
    }

    function test_RevertsOnInvalidGenericSwapCallData() public {
        // Prepare minimum callData for GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: address(123),
            receivingAssetId: address(456),
            fromAmount: 1,
            callData: "",
            requiresDeposit: false
        });

        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            keccak256(""),
            "",
            "",
            payable(address(1234)),
            1,
            swapData[0]
        );

        // Instead of using LibBytes.slice (which couses stack-too-deep issues),
        // use our custom safeSlice to reduce calldata to 483 bytes.
        callData = _safeSlice(callData, 0, 483);

        // Expect revert because the callData length is below the minimum threshold.
        vm.expectRevert(InvalidCallData.selector);
        calldataVerificationFacet.extractGenericSwapParameters(callData);
    }

    function test_CanExtractGenericSwapMinCallData() public {
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: address(123),
            receivingAssetId: address(456),
            fromAmount: 1,
            callData: "",
            requiresDeposit: false
        });
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            keccak256(""),
            "",
            "",
            payable(address(1234)),
            1,
            swapData[0]
        );

        (
            address sendingAssetId,
            uint256 amount,
            address receiver,
            address receivingAssetId,
            uint256 receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(callData);

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1);
    }

    function test_CanExtractGenericSwapV3SingleParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            keccak256("id"),
            "acme",
            "acme",
            payable(address(1234)),
            1 ether,
            swapData[0]
        );

        (
            address sendingAssetId,
            uint256 amount,
            address receiver,
            address receivingAssetId,
            uint256 receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(callData);

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1 ether);
    }

    function test_CanExtractGenericSwapV3MultipleParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20.selector,
            keccak256("id"),
            "acme",
            "acme",
            payable(address(1234)),
            1 ether,
            swapData
        );

        (
            address sendingAssetId,
            uint256 amount,
            address receiver,
            address receivingAssetId,
            uint256 receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(callData);

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1 ether);
    }

    function test_CanExtractMainParametersWithSwap() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4.selector,
            bridgeData,
            swapData
        );

        (
            string memory bridge,
            address sendingAssetId,
            address receiver,
            uint256 minAmount,
            uint256 destinationChainId,
            bool hasSourceSwaps,
            bool hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(callData);

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(minAmount, swapData[0].fromAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);
    }

    function test_CanValidateCalldata() public {
        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV4.startBridgeTokensViaAcrossV4.selector,
            bridgeData
        );

        bool validCall = calldataVerificationFacet.validateCalldata(
            callData,
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            bridgeData.receiver,
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
        bool invalidCall = calldataVerificationFacet.validateCalldata(
            callData,
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            address(0xb33f),
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
        assertTrue(validCall);
        assertFalse(invalidCall);
    }

    function test_CanValidateStargateV2DestinationCalldata() public {
        uint16 assetIdUSDC = 1;

        StargateFacetV2.StargateData memory stargateData = StargateFacetV2
            .StargateData({
                assetId: assetIdUSDC,
                sendParams: IStargate.SendParam({
                    dstEid: 30150,
                    to: USER_RECEIVER.addressToBytes32(),
                    amountLD: defaultUSDCAmount,
                    minAmountLD: (defaultUSDCAmount * 9e4) / 1e5,
                    extraOptions: "",
                    composeMsg: bytes("foobarbytes"),
                    oftCmd: OftCmdHelper.bus()
                }),
                fee: IStargate.MessagingFee({ nativeFee: 0, lzTokenFee: 0 }),
                refundAddress: payable(USER_REFUND)
            });

        bytes memory callData = abi.encodeWithSelector(
            StargateFacetV2.startBridgeTokensViaStargate.selector,
            bridgeData,
            stargateData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            StargateFacetV2.swapAndStartBridgeTokensViaStargate.selector,
            bridgeData,
            swapData,
            stargateData
        );

        bool validCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        bool validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                callDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        bool badCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function testRevert_WhenCallToAddressIsTooShort() public {
        uint16 assetIdUSDC = 1;

        StargateFacetV2.StargateData memory stargateData = StargateFacetV2
            .StargateData({
                assetId: assetIdUSDC,
                sendParams: IStargate.SendParam({
                    dstEid: 30150,
                    to: USER_RECEIVER.addressToBytes32(),
                    amountLD: defaultUSDCAmount,
                    minAmountLD: (defaultUSDCAmount * 9e4) / 1e5,
                    extraOptions: "",
                    composeMsg: bytes("foobarbytes"),
                    oftCmd: OftCmdHelper.bus()
                }),
                fee: IStargate.MessagingFee({ nativeFee: 0, lzTokenFee: 0 }),
                refundAddress: payable(USER_REFUND)
            });
        bytes memory callData = abi.encodeWithSelector(
            StargateFacetV2.startBridgeTokensViaStargate.selector,
            bridgeData,
            stargateData
        );

        bytes memory invalidCallTo = hex"1234"; // too short (length < 20)

        vm.expectRevert("Invalid callTo length; expected at least 20 bytes");

        calldataVerificationFacet.validateDestinationCalldata(
            callData,
            invalidCallTo,
            bytes("foobarbytes")
        );
    }

    function checkBridgeData(ILiFi.BridgeData memory data) internal {
        assertTrue(data.transactionId == bridgeData.transactionId);
        assertEq(data.bridge, bridgeData.bridge);
        assertEq(data.integrator, bridgeData.integrator);
    }

    function checkSwapData(LibSwap.SwapData[] memory data) internal {
        assertTrue(data[0].callTo == swapData[0].callTo);
        assertTrue(data[0].approveTo == swapData[0].approveTo);
        assertTrue(data[0].sendingAssetId == swapData[0].sendingAssetId);
        assertTrue(data[0].receivingAssetId == swapData[0].receivingAssetId);
    }
}

library OftCmdHelper {
    function taxi() internal pure returns (bytes memory) {
        return "";
    }

    function bus() internal pure returns (bytes memory) {
        return new bytes(1);
    }
}
