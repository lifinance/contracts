// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IntentReceiver } from "./IntentReceiver.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { ExternalCallFailed, UnAuthorized } from "../Errors/GenericErrors.sol";

/// @title Receiver
/// @author LI.FI (https://li.fi)
/// @notice Contains logic for receiving and storing swap intents
/// @custom:version 3.0.0
contract Receiver is IntentReceiver {
    /// Storage ///
    address public sgRouter;
    address public amarokRouter;

    /// Modifiers ///
    modifier onlySGRouter() {
        if (msg.sender != sgRouter) {
            revert UnAuthorized();
        }
        _;
    }

    modifier onlyAmarokRouter() {
        if (msg.sender != amarokRouter) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _sgRouter,
        address _amarokRouter
    ) IntentReceiver(_owner) {
        sgRouter = _sgRouter;
        amarokRouter = _amarokRouter;
    }

    /// @notice Completes a cross-chain transaction with calldata via Amarok facet on the receiving chain.
    /// @dev This function is called from Amarok Router.
    /// @param * (unused)The unique ID of this transaction (assigned by Amarok)
    /// @param _amount the amount of bridged tokens
    /// @param _asset the address of the bridged token
    /// @param * (unused) the sender of the transaction
    /// @param * (unused) the domain ID of the src chain
    /// @param _callData The data to execute
    function xReceive(
        bytes32,
        uint256 _amount,
        address _asset,
        address,
        uint32,
        bytes memory _callData
    ) external nonReentrant onlyAmarokRouter {
        // decode the payload and store the intent derived from it
        _processPayloadAndSaveIntent(_callData, _asset, _amount);
    }

    /// @notice Completes a cross-chain transaction on the receiving chain.
    /// @dev This function is called from Stargate Router.
    /// @param * (unused) The remote chainId sending the tokens
    /// @param * (unused) The remote Bridge address
    /// @param * (unused) Nonce
    /// @param _token The token contract on the local chain
    /// @param _amountLD The amount of tokens received through bridging
    /// @param _payload The data to execute
    function sgReceive(
        uint16, // _srcChainId unused
        bytes memory, // _srcAddress unused
        uint256, // _nonce unused
        address _token,
        uint256 _amountLD,
        bytes memory _payload
    ) external nonReentrant onlySGRouter {
        // decode the payload and store the intent derived from it
        _processPayloadAndSaveIntent(_payload, _token, _amountLD);
    }
}
