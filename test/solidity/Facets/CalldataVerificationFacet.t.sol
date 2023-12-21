// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { CalldataVerificationFacet } from "lifi/Facets/CalldataVerificationFacet.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";
import { CelerIM, CelerIMFacetBase } from "lifi/Helpers/CelerIMFacetBase.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { GenericSwapFacet } from "lifi/Facets/GenericSwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestBase } from "../utils/TestBase.sol";
import { MsgDataTypes } from "celer-network/contracts/message/libraries/MessageSenderLib.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
import "forge-std/console.sol";

contract CallVerificationFacetTest is TestBase {
    using LibBytes for bytes;

    CalldataVerificationFacet internal calldataVerificationFacet;
    HopFacet.HopData internal validHopData;

    error CalldataCollision();
    error IllegalCalldataSize();
    error IllegalSelector();

    function setUp() public {
        calldataVerificationFacet = new CalldataVerificationFacet();
        vm.warp(1703185326);
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

        // produce valid HopData
        validHopData = HopFacet.HopData({
            bonderFee: 0.001 ether,
            amountOutMin: 0.1 ether,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0.099 ether,
            destinationDeadline: block.timestamp + 60 * 20,
            relayer: address(12374528),
            relayerFee: 0.0001 ether,
            nativeFee: 0.0001 ether
        });
    }

    function test_CanExtractBridgeData() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        console.logBytes(callData);

        ILiFi.BridgeData memory returnedData = calldataVerificationFacet
            .extractBridgeData(callData);

        checkBridgeData(returnedData);
    }

    function test_CanExtractSwapData() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        LibSwap.SwapData[] memory returnedData = calldataVerificationFacet
            .extractSwapData(callData);

        checkSwapData(returnedData);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        returnedData = calldataVerificationFacet.extractSwapData(
            standardizedCallData
        );

        checkSwapData(returnedData);
    }

    function test_CanExtractBridgeAndSwapData() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(callData);

        checkBridgeData(returnedBridgeData);
        checkSwapData(returnedSwapData);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (returnedBridgeData, returnedSwapData) = calldataVerificationFacet
            .extractData(standardizedCallData);

        checkBridgeData(returnedBridgeData);
        checkSwapData(returnedSwapData);
    }

    function test_CanExtractBridgeAndSwapDataNoSwaps() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(callData);

        checkBridgeData(returnedBridgeData);
        assertEq(returnedSwapData.length, 0);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (returnedBridgeData, returnedSwapData) = calldataVerificationFacet
            .extractData(standardizedCallData);

        checkBridgeData(returnedBridgeData);
        assertEq(returnedSwapData.length, 0);
    }

    function test_CanExtractMainParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
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

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        (
            bridge,
            sendingAssetId,
            receiver,
            minAmount,
            destinationChainId,
            hasSourceSwaps,
            hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(
            standardizedCallData
        );

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, bridgeData.sendingAssetId);
        assertEq(minAmount, bridgeData.minAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);
    }

    function test_CanExtractGenericSwapParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacet.swapTokensGeneric.selector,
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

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (
            sendingAssetId,
            amount,
            receiver,
            receivingAssetId,
            receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(
            standardizedCallData
        );

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1 ether);
    }

    function test_RevertOnInvalidGenericSwapParameters() public {
        // Build malicious calldata
        bytes32 transactionId = bytes32(uint(0xc0));
        address wrongReceiver = address(1337);
        uint64 destinationChainId = 1;
        address sndAssetId = address(3);
        uint256 amt = 1000;
        uint64 nonce = 1001;
        uint32 maxSlippage = 1002;

        bytes memory maliciousData = abi.encodeWithSelector(
            HopFacetPacked.startBridgeTokensViaHopL2NativeMin.selector,
            transactionId,
            wrongReceiver,
            destinationChainId,
            sndAssetId,
            amt,
            nonce,
            maxSlippage
        );

        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacet.swapTokensGeneric.selector,
            transactionId,
            "acme",
            "acme",
            payable(address(1234)),
            1 ether,
            swapData
        );

        callData = bytes.concat(callData, maliciousData);

        vm.expectRevert(IllegalCalldataSize.selector);
        calldataVerificationFacet.extractGenericSwapParameters(callData);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        vm.expectRevert(IllegalCalldataSize.selector);
        calldataVerificationFacet.extractGenericSwapParameters(
            standardizedCallData
        );

        // Change the selector to something else
        callData = abi.encode(
            bytes4(0xffffffff),
            callData.slice(4, callData.length - 4)
        );

        vm.expectRevert(IllegalSelector.selector);
        calldataVerificationFacet.extractGenericSwapParameters(callData);
    }

    function test_CanExtractMainParametersWithSwap() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            HopFacet.swapAndStartBridgeTokensViaHop.selector,
            bridgeData,
            swapData,
            validHopData
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

        console.logBytes(callData);

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(minAmount, swapData[0].fromAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (
            bridge,
            sendingAssetId,
            receiver,
            minAmount,
            destinationChainId,
            hasSourceSwaps,
            hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(
            standardizedCallData
        );

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
            HyphenFacet.startBridgeTokensViaHyphen.selector,
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

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        validCall = calldataVerificationFacet.validateCalldata(
            standardizedCallData,
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            bridgeData.receiver,
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
        invalidCall = calldataVerificationFacet.validateCalldata(
            standardizedCallData,
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

    function test_CanValidateAmarokDestinationCalldata() public {
        AmarokFacet.AmarokData memory amarokData = AmarokFacet.AmarokData({
            callData: bytes("foobarbytes"),
            callTo: USER_RECEIVER,
            relayerFee: 0,
            slippageTol: 0,
            delegate: USER_RECEIVER,
            destChainDomainId: 1234,
            payFeeWithSendingAsset: false
        });

        bytes memory callData = abi.encodeWithSelector(
            AmarokFacet.startBridgeTokensViaAmarok.selector,
            bridgeData,
            amarokData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            AmarokFacet.swapAndStartBridgeTokensViaAmarok.selector,
            bridgeData,
            swapData,
            amarokData
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

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callDataWithSwap
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_CanValidateStargateDestinationCalldata() public {
        StargateFacet.StargateData memory sgData = StargateFacet.StargateData({
            srcPoolId: 1,
            dstPoolId: 2,
            minAmountLD: 3,
            dstGasForCall: 4,
            lzFee: 5,
            refundAddress: payable(address(0x1234)),
            callTo: abi.encode(USER_RECEIVER),
            callData: bytes("foobarbytes")
        });

        bytes memory callData = abi.encodeWithSelector(
            StargateFacet.startBridgeTokensViaStargate.selector,
            bridgeData,
            sgData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            StargateFacet.swapAndStartBridgeTokensViaStargate.selector,
            bridgeData,
            swapData,
            sgData
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

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callDataWithSwap
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_CanValidateCelerIMDestinationCalldata() public {
        CelerIM.CelerIMData memory cimData = CelerIM.CelerIMData({
            maxSlippage: 1,
            nonce: 2,
            callTo: abi.encode(USER_RECEIVER),
            callData: bytes("foobarbytes"),
            messageBusFee: 3,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });

        bytes memory callData = abi.encodeWithSelector(
            CelerIMFacetBase.startBridgeTokensViaCelerIM.selector,
            bridgeData,
            cimData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            CelerIMFacetBase.swapAndStartBridgeTokensViaCelerIM.selector,
            bridgeData,
            swapData,
            cimData
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

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_RevertOnEncodeCollision() public {
        // Disguise a transactionId as an offset for the bridgeData
        bytes32 transactionId = bytes32(uint(0x100));

        // Build malicious calldata
        address wrongReceiver = address(1337);
        uint64 destinationChainId = 1;
        address sendingAssetId = address(3);
        uint256 amount = 1000;
        uint64 nonce = 1001;
        uint32 maxSlippage = 1002;

        bytes memory _calldata = abi.encodeWithSelector(
            HopFacetPacked.startBridgeTokensViaHopL2NativeMin.selector,
            transactionId,
            wrongReceiver,
            destinationChainId,
            sendingAssetId,
            amount,
            nonce,
            maxSlippage
        );

        bytes memory bridgeDataEncoded = abi.encode(bridgeData);

        // Concatenate the two
        _calldata = abi.encodePacked(_calldata, bridgeDataEncoded);

        // Should revert on decode
        vm.expectRevert(CalldataCollision.selector);
        calldataVerificationFacet.extractMainParameters(_calldata);
        vm.expectRevert(CalldataCollision.selector);
        calldataVerificationFacet.extractBridgeData(_calldata);
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
