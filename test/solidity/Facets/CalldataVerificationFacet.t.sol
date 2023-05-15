// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { CalldataVerificationFacet } from "lifi/Facets/CalldataVerificationFacet.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestBase } from "../utils/TestBase.sol";
import "forge-std/console.sol";

contract CallVerificationFacetTest is TestBase {
    CalldataVerificationFacet internal calldataVerificationFacet;

    function setUp() public {
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
    }

    function test_CanExtractBridgeData() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        ILiFi.BridgeData memory returnedData = calldataVerificationFacet
            .extractBridgeData(fullCalldata);

        checkBridgeData(returnedData);
    }

    function test_CanExtractSwapData() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        LibSwap.SwapData[] memory returnedData = calldataVerificationFacet
            .extractSwapData(fullCalldata);

        checkSwapData(returnedData);
    }

    function test_CanExtractBridgeAndSwapData() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(fullCalldata);

        checkBridgeData(returnedBridgeData);
        checkSwapData(returnedSwapData);
    }

    function test_CanExtractBridgeAndSwapDataNoSwaps() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(fullCalldata);

        checkBridgeData(returnedBridgeData);
        assertEq(returnedSwapData.length, 0);
    }

    function test_CanExtractMainParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        (
            string memory bridge,
            address sendingAssetId,
            address receiver,
            uint256 minAmount,
            uint256 destinationChainId,
            bool hasSourceSwaps,
            bool hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(fullCalldata);

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, bridgeData.sendingAssetId);
        assertEq(minAmount, bridgeData.minAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);
    }

    function test_CanExtractMainParametersWithSwap() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        (
            string memory bridge,
            address sendingAssetId,
            address receiver,
            uint256 minAmount,
            uint256 destinationChainId,
            bool hasSourceSwaps,
            bool hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(fullCalldata);

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

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        bool validCall = calldataVerificationFacet.validateCalldata(
            fullCalldata,
            bridgeData.receiver,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            bridgeData.destinationChainId
        );
        bool invalidCall = calldataVerificationFacet.validateCalldata(
            fullCalldata,
            address(0xb33f),
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            bridgeData.destinationChainId
        );
        assertTrue(validCall);
        assertFalse(invalidCall);
    }

    function test_CanValidateDestinationCalldata() public {
        AmarokFacet.AmarokData memory amarokData = AmarokFacet.AmarokData({
            callData: bytes("foobarbytes"),
            callTo: address(0xdeadbeef),
            relayerFee: 0,
            slippageTol: 0,
            delegate: address(0xdeadbeef),
            destChainDomainId: 1234
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
            bytes("foobarbytes")
        );
        bool validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                callDataWithSwap,
                bytes("foobarbytes")
            );

        bool badCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
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
