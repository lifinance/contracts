// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { AmarokFacet } from "./AmarokFacet.sol";
import { StargateFacet } from "./StargateFacet.sol";
import { AcrossFacetV3 } from "./AcrossFacetV3.sol";
import { CelerIMFacetBase, CelerIM } from "lifi/Helpers/CelerIMFacetBase.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";

/// @title CalldataVerificationFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for verifying calldata
/// @custom:version 1.1.2
contract CalldataVerificationFacet {
    using LibBytes for bytes;

    /// @notice Extracts the bridge data from the calldata
    /// @param data The calldata to extract the bridge data from
    /// @return bridgeData The bridge data extracted from the calldata
    function extractBridgeData(
        bytes calldata data
    ) external pure returns (ILiFi.BridgeData memory bridgeData) {
        bridgeData = _extractBridgeData(data);
    }

    /// @notice Extracts the swap data from the calldata
    /// @param data The calldata to extract the swap data from
    /// @return swapData The swap data extracted from the calldata
    function extractSwapData(
        bytes calldata data
    ) external pure returns (LibSwap.SwapData[] memory swapData) {
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
        pure
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
        pure
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

    // @notice Extracts the non-EVM address from the calldata
    // @param data The calldata to extract the non-EVM address from
    // @return nonEVMAddress The non-EVM address extracted from the calldata
    function extractNonEVMAddress(
        bytes calldata data
    ) external pure returns (bytes32 nonEVMAddress) {
        bytes memory callData = data;
        ILiFi.BridgeData memory bridgeData = _extractBridgeData(data);

        if (
            bytes4(data[:4]) == StandardizedCallFacet.standardizedCall.selector
        ) {
            // standardizedCall
            callData = abi.decode(data[4:], (bytes));
        }

        // Non-EVM address is always the first parameter of bridge specific data
        if (bridgeData.hasSourceSwaps) {
            assembly {
                let offset := mload(add(callData, 0x64)) // Get the offset of the bridge specific data
                nonEVMAddress := mload(add(callData, add(offset, 0x24))) // Get the non-EVM address
            }
        } else {
            assembly {
                let offset := mload(add(callData, 0x44)) // Get the offset of the bridge specific data
                nonEVMAddress := mload(add(callData, add(offset, 0x24))) // Get the non-EVM address
            }
        }
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
        pure
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

        if (
            bytes4(data[:4]) == StandardizedCallFacet.standardizedCall.selector
        ) {
            // standardizedCall
            callData = abi.decode(data[4:], (bytes));
        }
        (, , , receiver, receivingAmount, swapData) = abi.decode(
            callData.slice(4, callData.length - 4),
            (bytes32, string, string, address, uint256, LibSwap.SwapData[])
        );

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
    ) external pure returns (bool isValid) {
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
    /// @return isValid Returns true if the calldata matches with the provided parameters
    function validateDestinationCalldata(
        bytes calldata data,
        bytes calldata callTo,
        bytes calldata dstCalldata
    ) external pure returns (bool isValid) {
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
                keccak256(callTo) == keccak256((celerIMData.callTo));
        }
        // Case: AcrossV3
        if (selector == AcrossFacetV3.startBridgeTokensViaAcrossV3.selector) {
            (, AcrossFacetV3.AcrossV3Data memory acrossV3Data) = abi.decode(
                callData.slice(4, callData.length - 4),
                (ILiFi.BridgeData, AcrossFacetV3.AcrossV3Data)
            );

            return
                keccak256(dstCalldata) == keccak256(acrossV3Data.message) &&
                keccak256(callTo) ==
                keccak256(abi.encode(acrossV3Data.receiverAddress));
        }
        if (
            selector ==
            AcrossFacetV3.swapAndStartBridgeTokensViaAcrossV3.selector
        ) {
            (, , AcrossFacetV3.AcrossV3Data memory acrossV3Data) = abi.decode(
                callData.slice(4, callData.length - 4),
                (
                    ILiFi.BridgeData,
                    LibSwap.SwapData[],
                    AcrossFacetV3.AcrossV3Data
                )
            );
            return
                keccak256(dstCalldata) == keccak256(acrossV3Data.message) &&
                keccak256(callTo) ==
                keccak256(abi.encode(acrossV3Data.receiverAddress));
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
    ) internal pure returns (ILiFi.BridgeData memory bridgeData) {
        if (
            bytes4(data[:4]) == StandardizedCallFacet.standardizedCall.selector
        ) {
            // StandardizedCall
            bytes memory unwrappedData = abi.decode(data[4:], (bytes));
            bridgeData = abi.decode(
                unwrappedData.slice(4, unwrappedData.length - 4),
                (ILiFi.BridgeData)
            );
            return bridgeData;
        }
        // normal call
        bridgeData = abi.decode(data[4:], (ILiFi.BridgeData));
    }

    /// @notice Extracts the swap data from the calldata
    /// @param data The calldata to extract the swap data from
    /// @return swapData The swap data extracted from the calldata
    function _extractSwapData(
        bytes calldata data
    ) internal pure returns (LibSwap.SwapData[] memory swapData) {
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
}
