// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibSwap } from "../Libraries/LibSwap.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { UnAuthorized, InvalidConfig, InvalidReceiver } from "../Errors/GenericErrors.sol";

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
/// Anyone can call this contract with fraudulently filled intents, incoming outputFilled calls cannot be trusted.
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
    /// @dev The endpoint is configured to only accept calldata coming from a specific output settler. This does not
    ///      prevent people from calling this function with malicious or fraudulent data but we can assure that the
    ///      token and amount have been correctly delivered.
    /// This contract does not validate exterior calldata or execution. Provided LibSwap.SwapData needs to be self
    ///      contained including slippage and fallback logic OR revert. Common mistakes can involve:
    ///      - Not pulling approved token. This contract does not validate the input token has left this contract.
    ///      - Not reverting if a swap fails. This contract does not monitor the executed data, the token will be
    ///        abandoned at it current position, likely vulnerable to be collected by someone else.
    ///      - Not execution parameters. If a swap or other balance variable actions are executed, the executor should
    ///        ensure the output is within expected params. For swaps, embed slippage protection.
    /// Failure to validate execution correctness WILL lead to a loss of funds ranging from complete loss to high slippage.
    /// If token is bytes32(0) then the native amount has been delivered before this call and no call value is provided.
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
        // If receiver is bad, revert early to not lose money. This blocks the fill and the user will be refunded on source
        if (receiver == address(0)) revert InvalidReceiver();

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
