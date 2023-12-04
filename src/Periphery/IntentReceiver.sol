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
abstract contract IntentReceiver is ReentrancyGuard, TransferrableOwnership {
    using SafeERC20 for IERC20;

    /// Storage ///
    address public immutable feeCollector;

    /// Events ///
    event IntentAdded(SwapIntent details);
    event IntentExecuted(SwapIntent details);
    event IntentCancelled(SwapIntent details, address refundedTo);
    event ExpiredIntentRefunded(SwapIntent details);

    /// Modifiers ///

    /// Errors ///
    error Expired();
    error BelowMinAmount();

    modifier onlyLiFiBackend() {
        //TODO: make sure only wallet controlled by LiFi backend can execute this function
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _feeCollector
    ) TransferrableOwnership(_owner) {
        feeCollector = _feeCollector;
    }

    // intentId => swapIntent details
    // swaps that are executed will be deleted from this mapping
    mapping(bytes32 => SwapIntent) public swapIntents;

    struct SwapIntent {
        bytes32 id;
        address fromAsset;
        address toAsset;
        uint256 fromAmount; // this is the actual amount received from the bridge
        uint256 minAmountOut; // minimum of tokens to be received by user
        uint256 deadline;
        address payable receiver;
    }

    struct IntentExecution {
        address callTo;
        bytes callData;
        uint256 value;
        uint256 feeAmount;
    }

    struct IntentPayload {
        address fromAsset;
        address toAsset;
        address receiver;
        uint256 deadline;
    }

    // Discussion Points:
    // - should we add a minAmountOut to the SwapIntent struct to make sure the user gets what he expects?
    // - for deadlines/expiration, to we work with block.timestamp (current approach) or with block.number?
    // - should we only limit this to swaps or also allow some more advanced stuff (e.g. stake tokens somewhere)?
    // - should we add an additional emergency withdraw function (I would say no since it's a backdoor but it might be better to)
    // - can every DEX directly pay out to specified address or do we need logic that forwards swapped funds to user afterwards?
    // - should we prepare this for multi-hops on dst (more complexity)?
    //   >> I would say in V2 but not for now
    // - is it better to split up the parameters in the events (e.g. to have receiver address indexed)?
    // - do we need to consider any gas limitations (e.g. add the option to provide gas limits, etc.)?
    // - should we bundle all intents in one contract (vs. have them split up between Receiver / RelayerCelerIM / potential future custom receivers)?
    //   >> I would say we keep them in each contract where they belong to
    // - the maxFee still needs to be added - but do we really need that?? I feel it adds unnecessary complexity. We are also the ones that suggest its value on srcChain
    //   so it doesnt really protect the user any more. I think they should just trust us here (also they can see if we charge (much) more than the actual gas cost and can complain)

    /// Public Methods ///

    /// @notice Allows the receiver of an intent to cancel it and send (unswapped) funds to any arbitrary refund address (no fee charged)
    /// @param intentId the id of the intent to be cancelled
    /// @param refundTo the address that should receive the token refund
    function cancelIntent(
        bytes32 intentId,
        address payable refundTo
    ) external nonReentrant {
        // get intent details from storage
        SwapIntent memory intent = swapIntents[intentId];

        // make sure this function can only be executed by intent-receivers and
        // only for their own intents
        if (intent.receiver != msg.sender) revert UnAuthorized();

        // remove intent from storage
        delete swapIntents[intent.id];

        // emit event
        emit IntentCancelled(intent, refundTo);

        // send funds to specified receiver address
        _sendTokens(intent.fromAsset, intent.receiver, intent.fromAmount);
    }

    /// Restricted Methods - only callable by LI.FI (Backend) ///

    /// @notice Allows the LI.FI backend to execute an (unexpired) intent. A fee is charged for this service to cover gas costs
    /// @param intentId the id of the intent to be refunded
    function executeIntent(
        bytes32 intentId,
        IntentExecution calldata exec
    ) external onlyLiFiBackend {
        // get intent details from storage
        SwapIntent memory intent = swapIntents[intentId];

        // get initial token balance
        uint256 initialBalance = _getBalance(intent.toAsset, intent.receiver);

        // make sure intent is not expired
        if (intent.deadline > block.timestamp) revert Expired();

        // remove intent from storage
        delete swapIntents[intent.id];

        // emit event
        emit IntentExecuted(intent);

        // send fee to feeCollector
        _sendTokens(intent.fromAsset, payable(feeCollector), exec.feeAmount);

        // execute the calldata provided by LI.FI backend
        (bool success, ) = exec.callTo.call{ value: exec.value }(
            exec.callData
        );
        if (!success) revert ExternalCallFailed();

        // ensure toToken balance increased by minAmountOut
        if (
            _getBalance(intent.toAsset, intent.receiver) - initialBalance <
            intent.minAmountOut
        ) revert BelowMinAmount();

        // TODO: do we need to add functionality here to send tokens or can every DEX forward swap outcome to specified address?
    }

    /// @notice Allows the LI.FI backend to send (unswapped) tokens to receiver address if an intent's deadline expired
    /// @param intentId the id of the intent to be refunded
    function refundExpiredIntent(
        bytes32 intentId,
        uint256 feeAmount
    ) external onlyLiFiBackend {
        // get intent details from storage
        SwapIntent memory intent = swapIntents[intentId];

        // make sure deadline is actually expired
        if (block.timestamp < intent.deadline) revert UnAuthorized();

        // remove intent from storage
        delete swapIntents[intent.id];

        // emit event
        emit ExpiredIntentRefunded(intent);

        // send fee to feeCollector
        _sendTokens(intent.fromAsset, payable(feeCollector), feeAmount);

        // send funds to specified receiver address
        _sendTokens(intent.fromAsset, intent.receiver, intent.fromAmount);
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
            uint256 minAmountOut,
            uint256 deadline
        ) = abi.decode(payload, (address, address, address, uint256, uint256));

        // make sure received asset matches with fromAsset extracted from payload
        // if not, send received tokens straight to receiver address
        if (receivedAsset != fromAsset)
            _sendTokens(receivedAsset, payable(receiver), receivedAmount);

        // save new intent
        SwapIntent memory intent = _saveIntent(
            fromAsset,
            toAsset,
            receivedAmount,
            minAmountOut,
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
        uint256 minAmountOut,
        address receiver,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    fromAsset,
                    toAsset,
                    fromAmount,
                    minAmountOut,
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
        uint256 minAmountOut,
        address payable receiver,
        uint256 deadline
    ) internal returns (SwapIntent memory intent) {
        // generate ID
        bytes32 id = _getUniqueId(
            fromAsset,
            toAsset,
            fromAmount,
            minAmountOut,
            receiver,
            deadline
        );

        // save intent
        intent = SwapIntent(
            id,
            fromAsset,
            toAsset,
            fromAmount,
            minAmountOut,
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

    function _getBalance(
        address tokenAddress,
        address account
    ) internal view returns (uint256 balance) {
        return
            LibAsset.isNativeAsset(tokenAddress)
                ? address(account).balance
                : IERC20(tokenAddress).balanceOf(address(account));
    }

    /// @notice Receive native asset directly.
    /// @dev Some bridges may send native asset before execute external calls.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
