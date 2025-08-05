// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title Patcher
/// @author LI.FI (https://li.fi)
/// @notice A contract that patches calldata with dynamically retrieved values at execution time
/// @dev Designed to be used with both delegate calls and normal calls
/// @dev IMPORTANT: This contract does NOT refund excess tokens or ETH. Any tokens or ETH sent in
/// excess of what is needed for execution will remain in the contract and can be stolen by anyone.
/// This includes: excess tokens when the target doesn't use all approved tokens, excess ETH when
/// msg.value > value parameter, and any tokens/ETH from failed transactions.
/// @custom:version 1.0.0
contract Patcher {
    /// @notice Error when getting a dynamic value fails
    error FailedToGetDynamicValue();

    /// @notice Error when input arrays have mismatched lengths
    error MismatchedArrayLengths();

    /// @notice Error when a patch offset is invalid
    error InvalidPatchOffset();

    /// @notice Error when a call execution fails
    error CallExecutionFailed();

    /// @notice Error when a zero address is provided
    error ZeroAddress();

    /// @notice Error when return data is not 32 bytes
    error InvalidReturnDataLength();

    /// Events ///

    /// @notice Emitted when a patch and execute operation is performed
    /// @param caller The address that initiated the operation
    /// @param finalTarget The contract that was called with patched data
    /// @param value The ETH value sent with the call
    /// @param success Whether the execution succeeded
    /// @param returnDataLength The length of data returned from the call
    event PatchExecuted(
        address indexed caller,
        address indexed finalTarget,
        uint256 value,
        bool success,
        uint256 returnDataLength
    );

    /// @notice Emitted when tokens are deposited before patch and execute
    /// @param caller The address that initiated the operation
    /// @param tokenAddress The ERC20 token that was deposited
    /// @param amount The amount of tokens deposited
    /// @param finalTarget The contract that received approval
    event TokensDeposited(
        address indexed caller,
        address indexed tokenAddress,
        uint256 amount,
        address indexed finalTarget
    );

    /// External Methods ///

    /// @notice Retrieves a value dynamically and uses it to patch calldata before execution
    /// @param valueSource The contract to query for the dynamic value
    /// @param valueGetter The calldata to use to get the dynamic value (e.g., balanceOf call)
    /// @param finalTarget The contract to call with the patched data
    /// @param value The ETH value to send with the final call
    /// @param data The original calldata to patch and execute
    /// @param offsets Array of byte offsets in the original calldata to patch with the dynamic value
    /// @param delegateCall If true, executes a delegatecall instead of a regular call for the final call
    /// @return success Whether the final call was successful
    /// @return returnData The data returned by the final call
    function executeWithDynamicPatches(
        address valueSource,
        bytes calldata valueGetter,
        address finalTarget,
        uint256 value,
        bytes calldata data,
        uint256[] calldata offsets,
        bool delegateCall
    ) external payable returns (bool success, bytes memory returnData) {
        (success, returnData) = _executeWithDynamicPatches(
            valueSource,
            valueGetter,
            finalTarget,
            value,
            data,
            offsets,
            delegateCall
        );

        emit PatchExecuted(
            msg.sender,
            finalTarget,
            value,
            success,
            returnData.length
        );

        return (success, returnData);
    }

    /// @notice Deposits tokens and retrieves a value dynamically to patch calldata before execution
    /// @dev WARNING: This function is vulnerable to frontrunning attacks. Any tokens approved to this
    /// contract can be stolen by a malicious actor who frontruns the transaction. Since execution
    /// targets are not whitelisted, users should be aware that approving tokens to this contract
    /// poses a significant risk of fund loss. Only use this function if you understand and accept
    /// this risk.
    /// @dev IMPORTANT: This function transfers the ENTIRE token balance of msg.sender, regardless of
    /// the amount needed for the transaction. Any excess tokens remain in the Patcher contract and
    /// are NOT refunded. These excess tokens can be stolen by anyone. Only use if you intend to
    /// transfer your entire balance.
    /// @param tokenAddress The ERC20 token to transfer from msg.sender
    /// @param valueSource The contract to query for the dynamic value
    /// @param valueGetter The calldata to use to get the dynamic value (e.g., balanceOf call)
    /// @param finalTarget The contract to call with the patched data
    /// @param value The ETH value to send with the final call
    /// @param data The original calldata to patch and execute
    /// @param offsets Array of byte offsets in the original calldata to patch with the dynamic value
    /// @param delegateCall If true, executes a delegatecall instead of a regular call for the final call
    /// @return success Whether the final call was successful
    /// @return returnData The data returned by the final call
    function depositAndExecuteWithDynamicPatches(
        address tokenAddress,
        address valueSource,
        bytes calldata valueGetter,
        address finalTarget,
        uint256 value,
        bytes calldata data,
        uint256[] calldata offsets,
        bool delegateCall
    ) external payable returns (bool success, bytes memory returnData) {
        _depositAndApprove(tokenAddress, finalTarget);

        (success, returnData) = _executeWithDynamicPatches(
            valueSource,
            valueGetter,
            finalTarget,
            value,
            data,
            offsets,
            delegateCall
        );

        // Reset approval to 0 after execution
        IERC20(tokenAddress).approve(finalTarget, 0);

        emit PatchExecuted(
            msg.sender,
            finalTarget,
            value,
            success,
            returnData.length
        );
        return (success, returnData);
    }

    /// @notice Deposits tokens and retrieves multiple values dynamically to patch calldata at different offsets
    /// @dev WARNING: This function is vulnerable to frontrunning attacks. Any tokens approved to this
    /// contract can be stolen by a malicious actor who frontruns the transaction. Since execution
    /// targets are not whitelisted, users should be aware that approving tokens to this contract
    /// poses a significant risk of fund loss. Only use this function if you understand and accept
    /// this risk.
    /// @dev IMPORTANT: This function transfers the ENTIRE token balance of msg.sender, regardless of
    /// the amount needed for the transaction. Any excess tokens remain in the Patcher contract and
    /// are NOT refunded. These excess tokens can be stolen by anyone. Only use if you intend to
    /// transfer your entire balance.
    /// @param tokenAddress The ERC20 token to transfer from msg.sender
    /// @param valueSources Array of contracts to query for dynamic values
    /// @param valueGetters Array of calldata to use to get each dynamic value
    /// @param finalTarget The contract to call with the patched data
    /// @param value The ETH value to send with the final call
    /// @param data The original calldata to patch and execute
    /// @param offsetGroups Array of offset arrays, each corresponding to a value source/getter pair
    /// @param delegateCall If true, executes a delegatecall instead of a regular call for the final call
    /// @return success Whether the final call was successful
    /// @return returnData The data returned by the final call
    function depositAndExecuteWithMultiplePatches(
        address tokenAddress,
        address[] calldata valueSources,
        bytes[] calldata valueGetters,
        address finalTarget,
        uint256 value,
        bytes calldata data,
        uint256[][] calldata offsetGroups,
        bool delegateCall
    ) external payable returns (bool success, bytes memory returnData) {
        _depositAndApprove(tokenAddress, finalTarget);

        (success, returnData) = _executeWithMultiplePatches(
            valueSources,
            valueGetters,
            finalTarget,
            value,
            data,
            offsetGroups,
            delegateCall
        );

        // Reset approval to 0 after execution
        IERC20(tokenAddress).approve(finalTarget, 0);

        emit PatchExecuted(
            msg.sender,
            finalTarget,
            value,
            success,
            returnData.length
        );
        return (success, returnData);
    }

    /// @notice Retrieves multiple values dynamically and uses them to patch calldata at different offsets
    /// @param valueSources Array of contracts to query for dynamic values
    /// @param valueGetters Array of calldata to use to get each dynamic value
    /// @param finalTarget The contract to call with the patched data
    /// @param value The ETH value to send with the final call
    /// @param data The original calldata to patch and execute
    /// @param offsetGroups Array of offset arrays, each corresponding to a value source/getter pair
    /// @param delegateCall If true, executes a delegatecall instead of a regular call for the final call
    /// @return success Whether the final call was successful
    /// @return returnData The data returned by the final call
    function executeWithMultiplePatches(
        address[] calldata valueSources,
        bytes[] calldata valueGetters,
        address finalTarget,
        uint256 value,
        bytes calldata data,
        uint256[][] calldata offsetGroups,
        bool delegateCall
    ) external payable returns (bool success, bytes memory returnData) {
        (success, returnData) = _executeWithMultiplePatches(
            valueSources,
            valueGetters,
            finalTarget,
            value,
            data,
            offsetGroups,
            delegateCall
        );

        emit PatchExecuted(
            msg.sender,
            finalTarget,
            value,
            success,
            returnData.length
        );

        return (success, returnData);
    }

    /// Private Methods ///

    /// @notice Helper function to handle token deposit and approval
    /// @dev Approves the maximum amount for gas efficiency. The approval is reset to 0 after execution
    /// @param tokenAddress The ERC20 token to transfer from msg.sender
    /// @param finalTarget The contract to approve for spending the deposited tokens
    function _depositAndApprove(
        address tokenAddress,
        address finalTarget
    ) private {
        // Get the token balance of msg.sender
        uint256 amount = IERC20(tokenAddress).balanceOf(msg.sender);

        // Transfer tokens from msg.sender to this contract
        LibAsset.transferFromERC20(
            tokenAddress,
            msg.sender,
            address(this),
            amount
        );

        // Approve the finalTarget to spend the deposited tokens
        LibAsset.maxApproveERC20(IERC20(tokenAddress), finalTarget, amount);

        // Emit deposit event
        emit TokensDeposited(msg.sender, tokenAddress, amount, finalTarget);
    }

    /// @notice Helper function to get a dynamic value from an external contract
    /// @dev The return data must be exactly 32 bytes (a single uint256 value)
    /// @param valueSource The contract to query for the dynamic value
    /// @param valueGetter The calldata to use to get the dynamic value
    /// @return dynamicValue The uint256 value retrieved from the call
    function _getDynamicValue(
        address valueSource,
        bytes calldata valueGetter
    ) internal view returns (uint256 dynamicValue) {
        (bool valueSuccess, bytes memory valueData) = valueSource.staticcall(
            valueGetter
        );
        if (!valueSuccess) revert FailedToGetDynamicValue();

        // Validate that return data is exactly 32 bytes
        if (valueData.length != 32) revert InvalidReturnDataLength();

        dynamicValue = abi.decode(valueData, (uint256));
    }

    /// @notice Helper function to apply a patch at a specific offset
    /// @param patchedData The data to patch
    /// @param offset The byte offset in the data
    /// @param dynamicValue The value to write at the offset
    function _applyPatch(
        bytes memory patchedData,
        uint256 offset,
        uint256 dynamicValue
    ) internal pure {
        if (offset + 32 > patchedData.length) revert InvalidPatchOffset();

        assembly {
            // Calculate the position in memory where we need to write the new value
            let position := add(add(patchedData, 32), offset)

            // Store the new value at the calculated position
            mstore(position, dynamicValue)
        }
    }

    /// @notice Helper function to execute the final call
    /// @param finalTarget The contract to call
    /// @param value The ETH value to send
    /// @param patchedData The patched calldata to use
    /// @param delegateCall Whether to use delegatecall
    /// @return success Whether the call was successful
    /// @return returnData The data returned by the call
    function _executeCall(
        address finalTarget,
        uint256 value,
        bytes memory patchedData,
        bool delegateCall
    ) internal returns (bool success, bytes memory returnData) {
        if (delegateCall) {
            (success, returnData) = finalTarget.delegatecall(patchedData);
        } else {
            (success, returnData) = finalTarget.call{ value: value }(
                patchedData
            );
        }

        if (!success) {
            // Revert with the returned error data if available
            if (returnData.length > 0) {
                LibUtil.revertWith(returnData);
            } else {
                revert CallExecutionFailed();
            }
        }
    }

    /// @dev Internal implementation to avoid stack too deep errors
    function _executeWithDynamicPatches(
        address valueSource,
        bytes calldata valueGetter,
        address finalTarget,
        uint256 value,
        bytes calldata data,
        uint256[] calldata offsets,
        bool delegateCall
    ) internal returns (bool success, bytes memory returnData) {
        if (
            LibUtil.isZeroAddress(valueSource) ||
            LibUtil.isZeroAddress(finalTarget)
        ) revert ZeroAddress();
        if (offsets.length == 0) revert InvalidPatchOffset();

        // Get the dynamic value
        uint256 dynamicValue = _getDynamicValue(valueSource, valueGetter);

        // Create a mutable copy of the original calldata
        bytes memory patchedData = data;

        // Apply the patches in-place
        _applyPatches(patchedData, offsets, dynamicValue);

        // Execute the call with the patched data
        return _executeCall(finalTarget, value, patchedData, delegateCall);
    }

    /// @dev Internal implementation to avoid stack too deep errors
    function _executeWithMultiplePatches(
        address[] calldata valueSources,
        bytes[] calldata valueGetters,
        address finalTarget,
        uint256 value,
        bytes calldata data,
        uint256[][] calldata offsetGroups,
        bool delegateCall
    ) internal returns (bool success, bytes memory returnData) {
        // Validation
        if (
            valueSources.length != valueGetters.length ||
            valueSources.length != offsetGroups.length
        ) {
            revert MismatchedArrayLengths();
        }
        if (LibUtil.isZeroAddress(finalTarget)) revert ZeroAddress();
        for (uint8 i = 0; i < valueSources.length; i++) {
            if (LibUtil.isZeroAddress(valueSources[i])) revert ZeroAddress();
            if (offsetGroups[i].length == 0) revert InvalidPatchOffset();
        }

        // Create a mutable copy of the original calldata
        bytes memory patchedData = data;

        // Process patches in batches to avoid stack too deep
        _processPatches(valueSources, valueGetters, offsetGroups, patchedData);

        // Execute the call with the patched data
        return _executeCall(finalTarget, value, patchedData, delegateCall);
    }

    /// @dev Helper function to process patches in batches
    function _processPatches(
        address[] calldata valueSources,
        bytes[] calldata valueGetters,
        uint256[][] calldata offsetGroups,
        bytes memory patchedData
    ) internal view {
        for (uint8 i = 0; i < valueSources.length; i++) {
            // Get the dynamic value for this patch
            uint256 dynamicValue = _getDynamicValue(
                valueSources[i],
                valueGetters[i]
            );

            // Apply the patches for this value
            uint256[] calldata offsets = offsetGroups[i];
            _applyPatches(patchedData, offsets, dynamicValue);
        }
    }

    /// @notice Helper function to apply multiple patches with the same value
    /// @param patchedData The data to patch
    /// @param offsets Array of offsets where to apply the patches
    /// @param dynamicValue The value to write at each offset
    function _applyPatches(
        bytes memory patchedData,
        uint256[] calldata offsets,
        uint256 dynamicValue
    ) internal pure {
        for (uint256 j = 0; j < offsets.length; j++) {
            _applyPatch(patchedData, offsets[j], dynamicValue);
        }
    }
}
