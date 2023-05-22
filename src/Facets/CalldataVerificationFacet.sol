// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { AmarokFacet } from "./AmarokFacet.sol";
import { StargateFacet } from "./StargateFacet.sol";
import { CelerIMFacet } from "./CelerIMFacet.sol";

/// @title Calldata Verification Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for verifying calldata
/// @custom:version 1.0.0
contract CalldataVerificationFacet {
    /// @notice Extracts the bridge data from the calldata
    /// @param data The calldata to extract the bridge data from
    /// @return bridgeData The bridge data extracted from the calldata
    function extractBridgeData(bytes calldata data)
        external
        pure
        returns (ILiFi.BridgeData memory bridgeData)
    {
        bridgeData = abi.decode(data[4:], (ILiFi.BridgeData));
        return bridgeData;
    }

    /// @notice Extracts the swap data from the calldata
    /// @param data The calldata to extract the swap data from
    /// @return swapData The swap data extracted from the calldata
    function extractSwapData(bytes calldata data)
        external
        pure
        returns (LibSwap.SwapData[] memory swapData)
    {
        (, swapData) = abi.decode(
            data[4:],
            (ILiFi.BridgeData, LibSwap.SwapData[])
        );
        return swapData;
    }

    /// @notice Extracts the bridge data and swap data from the calldata
    /// @param data The calldata to extract the bridge data and swap data from
    /// @return bridgeData The bridge data extracted from the calldata
    /// @return swapData The swap data extracted from the calldata
    function extractData(bytes calldata data)
        external
        pure
        returns (
            ILiFi.BridgeData memory bridgeData,
            LibSwap.SwapData[] memory swapData
        )
    {
        (bridgeData) = abi.decode(data[4:], (ILiFi.BridgeData));
        if (bridgeData.hasSourceSwaps) {
            (, swapData) = abi.decode(
                data[4:],
                (ILiFi.BridgeData, LibSwap.SwapData[])
            );
        }

        return (bridgeData, swapData);
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
    function extractMainParameters(bytes calldata data)
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
        ILiFi.BridgeData memory bridgeData;
        (bridgeData) = abi.decode(data[4:], (ILiFi.BridgeData));

        if (bridgeData.hasSourceSwaps) {
            LibSwap.SwapData[] memory swapData;
            (, swapData) = abi.decode(
                data[4:],
                (ILiFi.BridgeData, LibSwap.SwapData[])
            );
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
    function extractGenericSwapParameters(bytes calldata data)
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
        (, , , receiver, receivingAmount, swapData) = abi.decode(
            data[4:],
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
    /// @return isValid Whether the destination calldata is validate
    function validateDestinationCalldata(
        bytes calldata data,
        bytes calldata callTo,
        bytes calldata dstCalldata
    ) external pure returns (bool isValid) {
        bytes4 selector = abi.decode(data, (bytes4));

        // Case: Amarok
        if (selector == AmarokFacet.startBridgeTokensViaAmarok.selector) {
            (, AmarokFacet.AmarokData memory amarokData) = abi.decode(
                data[4:],
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
                data[4:],
                (ILiFi.BridgeData, LibSwap.SwapData[], AmarokFacet.AmarokData)
            );
            return
                keccak256(dstCalldata) == keccak256(amarokData.callData) &&
                abi.decode(callTo, (address)) == amarokData.callTo;
        }

        // Case: Stargate
        if (selector == StargateFacet.startBridgeTokensViaStargate.selector) {
            (, StargateFacet.StargateData memory stargateData) = abi.decode(
                data[4:],
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
                data[4:],
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
        if (selector == CelerIMFacet.startBridgeTokensViaCelerIM.selector) {
            (, CelerIMFacet.CelerIMData memory celerIMData) = abi.decode(
                data[4:],
                (ILiFi.BridgeData, CelerIMFacet.CelerIMData)
            );
            return
                keccak256(dstCalldata) == keccak256(celerIMData.callData) &&
                keccak256(callTo) == keccak256(celerIMData.callTo);
        }
        if (
            selector ==
            CelerIMFacet.swapAndStartBridgeTokensViaCelerIM.selector
        ) {
            (, , CelerIMFacet.CelerIMData memory celerIMData) = abi.decode(
                data[4:],
                (
                    ILiFi.BridgeData,
                    LibSwap.SwapData[],
                    CelerIMFacet.CelerIMData
                )
            );
            return
                keccak256(dstCalldata) == keccak256(celerIMData.callData) &&
                keccak256(callTo) == keccak256(celerIMData.callTo);
        }

        // All other cases
        return false;
    }
}
