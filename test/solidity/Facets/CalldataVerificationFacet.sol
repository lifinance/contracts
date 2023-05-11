// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { CalldataVerificationFacet } from "lifi/Facets/CalldataVerificationFacet.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestBase } from "../utils/TestBase.sol";

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
            hasDestinationCall: false
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

    function test_CatExtractBridgeAndSwapData() public {
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

    function test_CanExtractMainParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff"); // Add extra bytes because Hyphen does not have call specific data
        (
            address returnedReceiver,
            uint256 returnedMinAmount,
            uint256 returnedDestinationChainId,
            ILiFi.BridgeData memory returnedBridgeData
        ) = calldataVerificationFacet.extractMainParameters(fullCalldata);

        checkBridgeData(returnedBridgeData);
        assertEq(returnedReceiver, bridgeData.receiver);
        assertEq(returnedMinAmount, bridgeData.minAmount);
        assertEq(returnedDestinationChainId, bridgeData.destinationChainId);
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
