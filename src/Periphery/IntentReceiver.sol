// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { ExternalCallFailed, UnAuthorized } from "../Errors/GenericErrors.sol";

/// @title IntentReceiver
/// @author LI.FI (https://li.fi)
/// @notice Contains logic for receiving and storing swap intents
/// @custom:version 0.0.1
abstract contract IntentReceiver is
    ReentrancyGuard, //TODO: challenge
    TransferrableOwnership
{
    using SafeERC20 for IERC20;

    /// Storage ///

    /// Events ///
    event IntentAdded(SwapIntent details);
    event IntentExecuted(SwapIntent details);
    event IntentCancelled(SwapIntent details, address refundedTo);
    event ExpiredIntentRefunded(SwapIntent details);

    /// Modifiers ///

    /// Errors ///
    error Expired();

    modifier onlyLiFiBackend() {
        //TODO: make sure only wallet controlled by LiFi backend can execute this function
        _;
    }

    /// Constructor
    constructor(address _owner) TransferrableOwnership(_owner) {}

    // NEW CODE

    // intentId => swapIntent details
    // swaps that are executed will be deleted from this mapping
    mapping(bytes32 => SwapIntent) public swapIntents;

    struct SwapIntent {
        bytes32 id;
        address fromAsset;
        address toAsset;
        uint256 fromAmount;
        uint256 deadline;
        address payable receiver;
    }

    struct IntentExecution {
        address callTo;
        bytes callData;
        uint256 value;
    }

    struct IntentPayload {
        address fromAsset;
        address toAsset;
        address receiver;
        uint256 deadline;
    }

    // Questions:
    // - should we only limit this to swaps or also allow some more advanced stuff (e.g. stake tokens somewhere)?
    // - should we add an additional emergency withdraw function (I would say no since it's a backdoor but it might be better to)
    // - can every DEX directly pay out to specified address or do we need logic that forwards swapped funds to user afterwards?
    // - should we prepare this for multi-hops on dst (more complexity)?
    //   >> I would say in V2 but not for now
    // - is it better to split up the parameters in the events (e.g. to have receiver address indexed)?
    // - do we need to consider any gas limitations (e.g. add the option to provide gas limits, etc.)?
    // - should we bundle all intents in one contract (vs. have them split up between Receiver / RelayerCelerIM / potential future custom receivers)?

    /// @notice Allows the receiver of an intent to cancel it and send (unswapped) funds to any arbitrary refund address
    /// @param intent details of the intent to be refunded
    /// @param refundTo the address that should receive the token refund
    function cancelIntent(
        SwapIntent calldata intent,
        address payable refundTo
    ) external nonReentrant {
        // make sure this function can only be executed by intent-receivers and
        // only for their own intents
        if (intent.receiver != msg.sender) revert UnAuthorized();

        // remove intent from storage and store in tmp variable
        SwapIntent memory intent = swapIntents[intent.id];
        delete swapIntents[intent.id];

        // send funds to specified receiver address
        _sendTokens(intent.fromAsset, intent.receiver, intent.fromAmount);

        // emit event
        emit IntentCancelled(intent, refundTo);
    }

    /// Restricted Methods - only callable by LI.FI (Backend) ///

    function executeIntent(
        SwapIntent calldata intent,
        IntentExecution calldata exec
    ) external onlyLiFiBackend {
        // make sure intent is not expired
        if (intent.deadline > block.timestamp) revert Expired();

        // execute the calldata provided by LI.FI backend
        (bool success, ) = exec.callTo.call{ value: exec.value }(
            exec.callData
        );
        if (!success) revert ExternalCallFailed();

        // remove intent from storage
        // (According to checks-effects-actions pattern this should be done prior to the call but since this function
        // can only be called by our backend, we opted for saving gas without compromising security)
        delete swapIntents[intent.id];

        // emit event
        emit IntentExecuted(intent);
    }

    /// @notice Allows the LI.FI backend to send (unswapped) tokens to receiver address if an intent's deadline expired
    /// @param intent details of the expired intent to be refunded
    function refundExpiredIntent(
        SwapIntent calldata intent
    ) external onlyLiFiBackend {
        // make sure deadline is actually expired
        if (block.timestamp < intent.deadline) revert UnAuthorized();

        // send funds to specified receiver address
        _sendTokens(intent.fromAsset, intent.receiver, intent.fromAmount);

        // remove intent from storage
        // (According to checks-effects-actions pattern this should be done prior to the call but since this function
        // can only be called by our backend, we opted for saving gas without compromising security)
        delete swapIntents[intent.id];

        // emit event
        emit ExpiredIntentRefunded(intent);
    }

    /// Private Methods ///

    /// decodes a standardized cross-chain payload and saves the intent derived from it
    function _processPayloadAndSaveIntent(
        bytes memory payload,
        address receivedAsset,
        uint256 receivedAmount
    ) internal {
        // decode payload received from srcChain
        (
            address fromAsset,
            address toAsset,
            address receiver,
            uint256 deadline
        ) = abi.decode(payload, (address, address, address, uint256));

        // make sure received asset matches with fromAsset extracted from payload
        // if not, send received tokens straight to receiver address
        if (receivedAsset != fromAsset)
            _sendTokens(receivedAsset, payable(receiver), receivedAmount);

        // save new intent
        SwapIntent memory intent = _saveIntent(
            fromAsset,
            toAsset,
            receivedAmount,
            payable(receiver),
            deadline
        );

        // emit event
        emit IntentAdded(intent);
    }

    /// returns a unique (intent) ID based on the given parameters
    /// by including the deadline we should achieve sufficient uniqueness for our purpose
    function _getUniqueId(
        address fromAsset,
        address toAsset,
        uint256 fromAmount,
        address receiver,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    fromAsset,
                    toAsset,
                    fromAmount,
                    receiver,
                    deadline
                )
            );
    }

    /// stores a new intent in our local mapping
    function _saveIntent(
        address fromAsset,
        address toAsset,
        uint256 fromAmount,
        address payable receiver,
        uint256 deadline
    ) internal returns (SwapIntent memory intent) {
        // generate ID
        bytes32 id = _getUniqueId(
            fromAsset,
            toAsset,
            fromAmount,
            receiver,
            deadline
        );

        // save intent
        intent = SwapIntent(
            id,
            fromAsset,
            toAsset,
            fromAmount,
            deadline,
            payable(receiver)
        );

        swapIntents[intent.id] = intent;

        // emit event
        emit IntentAdded(intent);
    }

    /// sends tokens to a specified address (either as native or ERC20)
    function _sendTokens(
        address tokenAddress,
        address payable receiver,
        uint256 amount
    ) internal {
        if (LibAsset.isNativeAsset(tokenAddress)) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = receiver.call{ value: amount }("");
            if (!success) revert ExternalCallFailed();
        } else {
            IERC20(tokenAddress).safeTransfer(receiver, amount);
        }
    }

    /// @notice Receive native asset directly.
    /// @dev Some bridges may send native asset before execute external calls.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
