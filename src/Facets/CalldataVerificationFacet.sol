// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { AmarokFacet } from "./AmarokFacet.sol";
import { StargateFacet } from "./StargateFacet.sol";
import { CelerIMFacetBase, CelerIM } from "../Helpers/CelerIMFacetBase.sol";
import { GenericSwapFacet } from "./GenericSwapFacet.sol";
import { StandardizedCallFacet } from "./StandardizedCallFacet.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import "forge-std/console.sol";

/// @title Calldata Verification Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for verifying calldata
/// @custom:version 1.1.1
contract CalldataVerificationFacet {
    using LibBytes for bytes;

    /// Errors ///
    error CalldataCollision();
    error IllegalCalldataSize();
    error IllegalSelector();

    /// @notice Extracts the bridge data from the calldata
    /// @param data The calldata to extract the bridge data from
    /// @return bridgeData The bridge data extracted from the calldata
    function extractBridgeData(
        bytes calldata data
    ) external returns (ILiFi.BridgeData memory bridgeData) {
        bridgeData = _extractBridgeData(data);
    }

    /// @notice Extracts the swap data from the calldata
    /// @param data The calldata to extract the swap data from
    /// @return swapData The swap data extracted from the calldata
    function extractSwapData(
        bytes calldata data
    ) external returns (LibSwap.SwapData[] memory swapData) {
        swapData = _extractSwapData(data);
    }

    /// @notice Extracts the bridge data and swap data from the calldata
    /// @param data The calldata to extract the bridge data and swap data from
    /// @return bridgeData The bridge data extracted from the calldata
    /// @return swapData The swap data extracted from the calldata
    function extractData(
        bytes calldata data
    )
        external
        returns (
            ILiFi.BridgeData memory bridgeData,
            LibSwap.SwapData[] memory swapData
        )
    {
        bridgeData = _extractBridgeData(data);
        if (bridgeData.hasSourceSwaps) {
            swapData = _extractSwapData(data);
        }
    }

    /// @notice Extracts the main parameters from the calldata
    /// @param data The calldata to extract the main parameters from
    /// @return bridge The bridge extracted from the calldata
    /// @return sendingAssetId The sending asset id extracted from the calldata
    /// @return receiver The receiver extracted from the calldata
    /// @return amount The min amountfrom the calldata
    /// @return destinationChainId The destination chain id extracted from the calldata
    /// @return hasSourceSwaps Whether the calldata has source swaps
    /// @return hasDestinationCall Whether the calldata has a destination call
    function extractMainParameters(
        bytes calldata data
    )
        public
        returns (
            string memory bridge,
            address sendingAssetId,
            address receiver,
            uint256 amount,
            uint256 destinationChainId,
            bool hasSourceSwaps,
            bool hasDestinationCall
        )
    {
        ILiFi.BridgeData memory bridgeData = _extractBridgeData(data);

        if (bridgeData.hasSourceSwaps) {
            LibSwap.SwapData[] memory swapData = _extractSwapData(data);
            sendingAssetId = swapData[0].sendingAssetId;
            amount = swapData[0].fromAmount;
        } else {
            sendingAssetId = bridgeData.sendingAssetId;
            amount = bridgeData.minAmount;
        }

        return (
            bridgeData.bridge,
            sendingAssetId,
            bridgeData.receiver,
            amount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
    }

    /// @notice Extracts the generic swap parameters from the calldata
    /// @param data The calldata to extract the generic swap parameters from
    /// @return sendingAssetId The sending asset id extracted from the calldata
    /// @return amount The amount extracted from the calldata
    /// @return receiver The receiver extracted from the calldata
    /// @return receivingAssetId The receiving asset id extracted from the calldata
    /// @return receivingAmount The receiving amount extracted from the calldata
    function extractGenericSwapParameters(
        bytes calldata data
    )
        public
        returns (
            address sendingAssetId,
            uint256 amount,
            address receiver,
            address receivingAssetId,
            uint256 receivingAmount
        )
    {
        LibSwap.SwapData[] memory swapData;
        bytes memory callData = data;
        bytes4 selector = bytes4(data[:4]);

        if (selector == StandardizedCallFacet.standardizedCall.selector) {
            // standardizedCall
            callData = abi.decode(data[4:], (bytes));
            selector = bytes4(callData.slice(0, 4));
        }

        // Make sure it is a generic swap
        if (selector != GenericSwapFacet.swapTokensGeneric.selector) {
            revert IllegalSelector();
        }

        // @dev temporary vars for checking calldata size
        bytes32 a;
        string memory b;
        string memory c;
        (a, b, c, receiver, receivingAmount, swapData) = abi.decode(
            callData.slice(4, callData.length - 4),
            (bytes32, string, string, address, uint256, LibSwap.SwapData[])
        );

        // @dev check calldata size when decoded
        bytes memory actualData = abi.encode(
            a,
            b,
            c,
            receiver,
            receivingAmount,
            swapData
        );

        // @dev make sure there is not extra malicious data
        if (actualData.length != callData.length - 4) {
            revert IllegalCalldataSize();
        }

        sendingAssetId = swapData[0].sendingAssetId;
        amount = swapData[0].fromAmount;
        receivingAssetId = swapData[swapData.length - 1].receivingAssetId;
        return (
            sendingAssetId,
            amount,
            receiver,
            receivingAssetId,
            receivingAmount
        );
    }

    /// @notice Validates the calldata
    /// @param data The calldata to validate
    /// @param bridge The bridge to validate or empty string to ignore
    /// @param sendingAssetId The sending asset id to validate
    ///        or 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF to ignore
    /// @param receiver The receiver to validate
    ///        or 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF to ignore
    /// @param amount The amount to validate or type(uint256).max to ignore
    /// @param destinationChainId The destination chain id to validate
    ///        or type(uint256).max to ignore
    /// @param hasSourceSwaps Whether the calldata has source swaps
    /// @param hasDestinationCall Whether the calldata has a destination call
    /// @return isValid Whether the calldata is validate
    function validateCalldata(
        bytes calldata data,
        string calldata bridge,
        address sendingAssetId,
        address receiver,
        uint256 amount,
        uint256 destinationChainId,
        bool hasSourceSwaps,
        bool hasDestinationCall
    ) external returns (bool isValid) {
        ILiFi.BridgeData memory bridgeData;
        (
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            bridgeData.receiver,
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        ) = extractMainParameters(data);
        return
            // Check bridge
            (keccak256(abi.encodePacked(bridge)) ==
                keccak256(abi.encodePacked("")) ||
                keccak256(abi.encodePacked(bridgeData.bridge)) ==
                keccak256(abi.encodePacked(bridge))) &&
            // Check sendingAssetId
            (sendingAssetId == 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF ||
                bridgeData.sendingAssetId == sendingAssetId) &&
            // Check receiver
            (receiver == 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF ||
                bridgeData.receiver == receiver) &&
            // Check amount
            (amount == type(uint256).max || bridgeData.minAmount == amount) &&
            // Check destinationChainId
            (destinationChainId == type(uint256).max ||
                bridgeData.destinationChainId == destinationChainId) &&
            // Check hasSourceSwaps
            bridgeData.hasSourceSwaps == hasSourceSwaps &&
            // Check hasDestinationCall
            bridgeData.hasDestinationCall == hasDestinationCall;
    }

    /// @notice Validates the destination calldata
    /// @param data The calldata to validate
    /// @param callTo The call to address to validate
    /// @param dstCalldata The destination calldata to validate
    /// @return isValid Whether the destination calldata is validate
    function validateDestinationCalldata(
        bytes calldata data,
        bytes calldata callTo,
        bytes calldata dstCalldata
    ) external returns (bool isValid) {
        bytes memory callData = data;

        // Handle standardizedCall
        if (
            bytes4(data[:4]) == StandardizedCallFacet.standardizedCall.selector
        ) {
            callData = abi.decode(data[4:], (bytes));
        }

        bytes4 selector = abi.decode(callData, (bytes4));

        // Case: Amarok
        if (selector == AmarokFacet.startBridgeTokensViaAmarok.selector) {
            (, AmarokFacet.AmarokData memory amarokData) = abi.decode(
                callData.slice(4, callData.length - 4),
                (ILiFi.BridgeData, AmarokFacet.AmarokData)
            );

            return
                keccak256(dstCalldata) == keccak256(amarokData.callData) &&
                abi.decode(callTo, (address)) == amarokData.callTo;
        }
        if (
            selector == AmarokFacet.swapAndStartBridgeTokensViaAmarok.selector
        ) {
            (, , AmarokFacet.AmarokData memory amarokData) = abi.decode(
                callData.slice(4, callData.length - 4),
                (ILiFi.BridgeData, LibSwap.SwapData[], AmarokFacet.AmarokData)
            );
            return
                keccak256(dstCalldata) == keccak256(amarokData.callData) &&
                abi.decode(callTo, (address)) == amarokData.callTo;
        }

        // Case: Stargate
        if (selector == StargateFacet.startBridgeTokensViaStargate.selector) {
            (, StargateFacet.StargateData memory stargateData) = abi.decode(
                callData.slice(4, callData.length - 4),
                (ILiFi.BridgeData, StargateFacet.StargateData)
            );
            return
                keccak256(dstCalldata) == keccak256(stargateData.callData) &&
                keccak256(callTo) == keccak256(stargateData.callTo);
        }
        if (
            selector ==
            StargateFacet.swapAndStartBridgeTokensViaStargate.selector
        ) {
            (, , StargateFacet.StargateData memory stargateData) = abi.decode(
                callData.slice(4, callData.length - 4),
                (
                    ILiFi.BridgeData,
                    LibSwap.SwapData[],
                    StargateFacet.StargateData
                )
            );
            return
                keccak256(dstCalldata) == keccak256(stargateData.callData) &&
                keccak256(callTo) == keccak256(stargateData.callTo);
        }
        // Case: Celer
        if (
            selector == CelerIMFacetBase.startBridgeTokensViaCelerIM.selector
        ) {
            (, CelerIM.CelerIMData memory celerIMData) = abi.decode(
                callData.slice(4, callData.length - 4),
                (ILiFi.BridgeData, CelerIM.CelerIMData)
            );
            return
                keccak256(dstCalldata) == keccak256(celerIMData.callData) &&
                keccak256(callTo) == keccak256(celerIMData.callTo);
        }
        if (
            selector ==
            CelerIMFacetBase.swapAndStartBridgeTokensViaCelerIM.selector
        ) {
            (, , CelerIM.CelerIMData memory celerIMData) = abi.decode(
                callData.slice(4, callData.length - 4),
                (ILiFi.BridgeData, LibSwap.SwapData[], CelerIM.CelerIMData)
            );
            return
                keccak256(dstCalldata) == keccak256(celerIMData.callData) &&
                keccak256(callTo) == keccak256(celerIMData.callTo);
        }

        // All other cases
        return false;
    }

    /// Internal Methods ///

    /// @notice Extracts the bridge data from the calldata
    /// @param data The calldata to extract the bridge data from
    /// @return bridgeData The bridge data extracted from the calldata
    function _extractBridgeData(
        bytes calldata data
    ) internal returns (ILiFi.BridgeData memory bridgeData) {
        if (
            bytes4(data[:4]) == StandardizedCallFacet.standardizedCall.selector
        ) {
            // StandardizedCall
            bytes memory unwrappedData = abi.decode(data[4:], (bytes));
            unwrappedData = unwrappedData.slice(4, unwrappedData.length - 4);
            _checkForCallDataCollision(unwrappedData);
            bridgeData = abi.decode(unwrappedData, (ILiFi.BridgeData));
            return bridgeData;
        }
        // normal call
        data = data[4:];
        _checkForCallDataCollision(data);
        bridgeData = abi.decode(data, (ILiFi.BridgeData));
    }

    function _isPackedCall(bytes memory data) internal returns (bool) {
        (bytes32 txId, address receiver) = abi.decode(
            data,
            (bytes32, address)
        );
    }

    /// @notice Extracts the swap data from the calldata
    /// @param data The calldata to extract the swap data from
    /// @return swapData The swap data extracted from the calldata
    function _extractSwapData(
        bytes calldata data
    ) internal returns (LibSwap.SwapData[] memory swapData) {
        if (
            bytes4(data[:4]) == StandardizedCallFacet.standardizedCall.selector
        ) {
            // standardizedCall
            bytes memory unwrappedData = abi.decode(data[4:], (bytes));
            (, swapData) = abi.decode(
                unwrappedData.slice(4, unwrappedData.length - 4),
                (ILiFi.BridgeData, LibSwap.SwapData[])
            );
            return swapData;
        }
        // normal call
        (, swapData) = abi.decode(
            data[4:],
            (ILiFi.BridgeData, LibSwap.SwapData[])
        );
    }

    function _checkForCallDataCollision(bytes memory data) internal {
        bool res1 = _attemptDecodePackedHop(data);
        bool res2 = _attemptDecodePackedCBridge(data);
        bool res3 = _attemptDecodeGenericSwapData(data);

        if (res1 || res2 || res3) {
            revert CalldataCollision();
        }
    }

    function _attemptDecodePackedHop(
        bytes memory data
    ) internal returns (bool) {
        try this.__attemptDecodePackedHop(data) {
            return true;
        } catch {
            return false;
        }
    }

    function __attemptDecodePackedHop(bytes memory data) public {
        (, , , , , uint256 da, uint256 t, ) = abi.decode(
            data,
            (
                bytes32,
                address,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                address
            )
        );
        console.log("t: %s", t);
        console.log("block.timestamp: %s", block.timestamp);
        require(da > 0);
        require(t > block.timestamp);
    }

    function _attemptDecodePackedCBridge(
        bytes memory data
    ) internal returns (bool) {
        try this.__attemptDecodePackedCBridge(data) {
            return true;
        } catch {
            return false;
        }
    }

    function __attemptDecodePackedCBridge(bytes memory data) public {
        abi.decode(data, (bytes32, address, uint64, uint64, uint32));
    }

    function _attemptDecodeGenericSwapData(
        bytes memory data
    ) internal returns (bool) {
        try this.__attemptDecodeGenericSwapData(data) {
            return true;
        } catch {
            return false;
        }
    }

    function __attemptDecodeGenericSwapData(bytes memory data) public {
        abi.decode(
            data,
            (bytes32, string, string, address, uint256, LibSwap.SwapData[])
        );
    }
}
