// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibSwap } from "../Libraries/LibSwap.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { UnAuthorized, InvalidConfig } from "../Errors/GenericErrors.sol";

/**
 * @notice Callback handling for OIF output processing.
 */
interface IOutputCallback {
    /**
     * @notice If configured, is called when the output is filled on the output chain.
     */
    function outputFilled(
        bytes32 token,
        uint256 amount,
        bytes calldata executionData
    ) external;
}

/// @title ReceiverOIF
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps via OIF.
/// Anyone can call this contract with fradulently filled intents, incoming outputFilled calls cannot be trusted.
/// @custom:version 1.0.0
contract ReceiverOIF is ILiFi, WithdrawablePeriphery, IOutputCallback {
    /// Storage ///
    IExecutor public immutable EXECUTOR;
    address public immutable OUTPUT_SETTLER;

    /// Modifiers ///
    modifier onlyTrustedOutputSettler() {
        if (msg.sender != OUTPUT_SETTLER) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _executor,
        address _outputSettler
    ) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) revert InvalidConfig();
        if (_executor == address(0)) revert InvalidConfig();
        if (_outputSettler == address(0)) revert InvalidConfig();
        EXECUTOR = IExecutor(_executor);
        OUTPUT_SETTLER = _outputSettler;
    }

    /// External Methods ///

    /// @notice Completes an OIF Intent via outputFilled.
    /// @dev The endpoint is configured to only accept calldata coming from a specfic output settler. This does not prevent people from calling this function with malicious or fradulent data but we can assure that the tokens and amounts have been correctly delivered.
    // If token is bytes32(0) then the native amount has been delivered before this call and no call value is provided.
    /// @param token Token identifier for the filled output. If normal ERC20, the 20 least significant bytes contains the address.
    /// @param amount Token amount
    /// @param executionData Attached arbitrary callbackData for the output.
    function outputFilled(
        bytes32 token,
        uint256 amount,
        bytes calldata executionData
    ) external onlyTrustedOutputSettler {
        // decode payload
        (
            bytes32 transactionId,
            LibSwap.SwapData[] memory swapData,
            address receiver
        ) = abi.decode(executionData, (bytes32, LibSwap.SwapData[], address));

        // execute swap(s)
        _swapAndCompleteBridgeTokens(
            transactionId,
            swapData,
            address(uint160(uint256(token))),
            payable(receiver),
            amount
        );
    }

    /// Private Methods ///

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId address of the token received from the source chain
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        bool isNative = LibAsset.isNativeAsset(assetId);
        if (!isNative) {
            SafeTransferLib.safeApproveWithRetry(
                assetId,
                address(EXECUTOR),
                amount
            );
        }
        EXECUTOR.swapAndCompleteBridgeTokens{ value: isNative ? amount : 0 }(
            _transactionId,
            _swapData,
            assetId,
            receiver
        );
    }

    /// @notice Native assets are sent alone before the callback is called.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
