// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";

/// @title A title that should describe the contract/interface
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for verifying calldata
/// @custom:version 0.0.1
contract CalldataVerificationFacet {
    /// @notice Extracts the bridge data from the calldata
    /// @param data The calldata to extract the bridge data from
    /// @return bridgeData The bridge data extracted from the calldata
    function extractBridgeData(
        bytes calldata data
    ) external pure returns (ILiFi.BridgeData memory bridgeData) {
        bridgeData = abi.decode(data[4:], (ILiFi.BridgeData));
        return bridgeData;
    }

    /// @notice Extracts the swap data from the calldata
    /// @param data The calldata to extract the swap data from
    /// @return swapData The swap data extracted from the calldata
    function extractSwapData(
        bytes calldata data
    ) external pure returns (LibSwap.SwapData[] memory swapData) {
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
        (bridgeData, swapData) = abi.decode(
            data[4:],
            (ILiFi.BridgeData, LibSwap.SwapData[])
        );
        return (bridgeData, swapData);
    }

    /// @notice Extracts the main parameters from the calldata
    /// @param data The calldata to extract the main parameters from
    /// @return receiver The receiver extracted from the calld
    /// @return minAmount The min amount extracted from the calldata
    /// @return destinationChainId The destination chain id extracted from the calldata
    /// @return bridgeData The bridge data extracted from the calldata
    function extractMainParameters(
        bytes calldata data
    )
        external
        pure
        returns (
            address receiver,
            uint256 minAmount,
            uint256 destinationChainId,
            ILiFi.BridgeData memory bridgeData
        )
    {
        (bridgeData) = abi.decode(data[4:], (ILiFi.BridgeData));
        return (
            bridgeData.receiver,
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData
        );
    }

    /// @notice Validates the calldata
    /// @param data The calldata to validate
    /// @param receiver The receiver to validate
    ///        or 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF to ignore
    /// @param sendingAssetId The sending asset id to validate
    ///        or 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF to ignore
    /// @param amount The amount to validate or type(uint256).max to ignore
    /// @param destinationChainId The destination chain id to validate
    ///        or type(uint256).max to ignore
    /// @return isValid Whether the calldata is validate
    function validateCalldata(
        bytes calldata data,
        address receiver,
        address sendingAssetId,
        uint256 amount,
        uint256 destinationChainId
    ) external pure returns (bool isValid) {
        ILiFi.BridgeData memory bridgeData;
        (bridgeData) = abi.decode(data[4:], (ILiFi.BridgeData));
        return
            (bridgeData.receiver ==
                0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF ||
                bridgeData.receiver == receiver) &&
            (bridgeData.sendingAssetId ==
                0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF ||
                bridgeData.sendingAssetId == sendingAssetId) &&
            (bridgeData.minAmount == type(uint256).max ||
                bridgeData.minAmount == amount) &&
            (bridgeData.destinationChainId == type(uint256).max ||
                bridgeData.destinationChainId == destinationChainId);
    }

    /// @notice Validates the destination calldata
    /// @param data The calldata to validate
    /// @param dstCalldata The destination calldata to validate
    /// @return isValid Whether the destination calldata is validate
    function validateDestinationCalldata(
        bytes calldata data,
        bytes calldata dstCalldata
    ) external pure returns (bool isValid) {
        ILiFi.BridgeData memory bridgeData;
        LibSwap.SwapData[] memory swapData;
        (bridgeData, swapData) = abi.decode(
            data[4:],
            (ILiFi.BridgeData, LibSwap.SwapData[])
        );

        if (!bridgeData.hasDestinationCall) {
            return false;
        }

        bytes memory dstCalldataToCheck = swapData[swapData.length - 1]
            .callData;
        return keccak256(dstCalldataToCheck) == keccak256(dstCalldata);
    }
}
