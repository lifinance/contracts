// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { AmarokFacet } from "./AmarokFacet.sol";
import { StargateFacet } from "./StargateFacet.sol";
import { CelerIMFacet } from "./CelerIMFacet.sol";

/// @title A title that should describe the contract/interface
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for verifying calldata
/// @custom:version 0.0.1
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
    /// @return minAmount The min amount extracted from the calldata
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
            uint256 minAmount,
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
            minAmount = swapData[0].fromAmount;
        } else {
            sendingAssetId = bridgeData.sendingAssetId;
            minAmount = bridgeData.minAmount;
        }

        return (
            bridgeData.bridge,
            sendingAssetId,
            bridgeData.receiver,
            minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
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
            (keccak256(abi.encodePacked(bridge)) ==
                keccak256(abi.encodePacked("")) ||
                keccak256(abi.encodePacked(bridgeData.bridge)) ==
                keccak256(abi.encodePacked(bridge))) &&
            (sendingAssetId == 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF ||
                bridgeData.sendingAssetId == sendingAssetId) &&
            (receiver == 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF ||
                bridgeData.receiver == receiver) &&
            (amount == type(uint256).max || bridgeData.minAmount == amount) &&
            (destinationChainId == type(uint256).max ||
                bridgeData.destinationChainId == destinationChainId) &&
            bridgeData.hasSourceSwaps == hasSourceSwaps &&
            bridgeData.hasDestinationCall == hasDestinationCall;
    }

    /// @notice Validates the destination calldata
    /// @param data The calldata to validate
    /// @param dstCalldata The destination calldata to validate
    /// @return isValid Whether the destination calldata is validate
    function validateDestinationCalldata(
        bytes calldata data,
        bytes calldata dstCalldata
    ) external pure returns (bool isValid) {
        bytes4 selector = abi.decode(data, (bytes4));

        // Case: Amarok
        if (selector == AmarokFacet.startBridgeTokensViaAmarok.selector) {
            (, AmarokFacet.AmarokData memory amarokData) = abi.decode(
                data[4:],
                (ILiFi.BridgeData, AmarokFacet.AmarokData)
            );

            return keccak256(dstCalldata) == keccak256(amarokData.callData);
        }
        if (
            selector == AmarokFacet.swapAndStartBridgeTokensViaAmarok.selector
        ) {
            (, , AmarokFacet.AmarokData memory amarokData) = abi.decode(
                data[4:],
                (ILiFi.BridgeData, LibSwap.SwapData[], AmarokFacet.AmarokData)
            );
            return keccak256(dstCalldata) == keccak256(amarokData.callData);
        }

        // Case: Stargate
        if (selector == StargateFacet.startBridgeTokensViaStargate.selector) {
            (, StargateFacet.StargateData memory stargateData) = abi.decode(
                data[4:],
                (ILiFi.BridgeData, StargateFacet.StargateData)
            );
            return keccak256(dstCalldata) == keccak256(stargateData.callData);
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
            return keccak256(dstCalldata) == keccak256(stargateData.callData);
        }
        // Case: Celer
        if (selector == CelerIMFacet.startBridgeTokensViaCelerIM.selector) {
            (, CelerIMFacet.CelerIMData memory celerIMData) = abi.decode(
                data[4:],
                (ILiFi.BridgeData, CelerIMFacet.CelerIMData)
            );
            return keccak256(dstCalldata) == keccak256(celerIMData.callData);
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
            return keccak256(dstCalldata) == keccak256(celerIMData.callData);
        }

        // All other cases
        return false;
    }
}
