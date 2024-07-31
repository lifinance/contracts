// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { OFTComposeMsgCodec } from "../Libraries/OFTComposeMsgCodec.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { ExternalCallFailed, UnAuthorized } from "../Errors/GenericErrors.sol";
import { ITokenMessaging } from "../Interfaces/IStargate.sol";

interface IPool {
    function token() external view returns (address tokenAddress);
}

interface ILayerZeroComposer {
    /// @notice Composes a LayerZero message from an OApp.
    /// @param _from The address initiating the composition, typically the OApp where the lzReceive was called.
    /// @param _guid The unique identifier for the corresponding LayerZero src/dst tx.
    /// @param _message The composed message payload in bytes. NOT necessarily the same payload passed via lzReceive.
    /// @param _executor The address of the executor for the composed message.
    /// @param _extraData Additional arbitrary data in bytes passed by the entity who executes the lzCompose.
    function lzCompose(
        address _from,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable;
}

/// @title ReceiverStargateV2
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing via Stargate V2
/// @custom:version 1.0.0
contract ReceiverStargateV2 is
    ILiFi,
    TransferrableOwnership,
    ILayerZeroComposer
{
    using SafeERC20 for IERC20;

    /// Storage ///
    IExecutor public immutable executor;
    ITokenMessaging public immutable tokenMessaging;
    address public immutable endpointV2;
    uint256 public immutable recoverGas;

    /// Modifiers ///
    modifier onlyEndpointV2() {
        if (msg.sender != endpointV2) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _executor,
        address _tokenMessaging,
        address _endpointV2,
        uint256 _recoverGas
    ) TransferrableOwnership(_owner) {
        owner = _owner;
        executor = IExecutor(_executor);
        tokenMessaging = ITokenMessaging(_tokenMessaging);
        endpointV2 = _endpointV2;
        recoverGas = _recoverGas;
    }

    /// External Methods ///

    /// @notice Completes a stargateV2 cross-chain transaction on the receiving chain
    /// @dev This function is called by Stargate Router via LayerZero endpoint (sendCompose(...) function)
    /// @param _from The address initiating the composition, typically the OApp where the lzReceive was called
    /// @param * (unused) The unique identifier for the corresponding LayerZero src/dst tx
    /// @param _message The composed message payload in bytes. NOT necessarily the same payload passed via lzReceive
    /// @param * (unused) The address of the executor for the composed message
    /// @param * (unused) Additional arbitrary data in bytes passed by the entity who executes the lzCompose
    function lzCompose(
        address _from,
        bytes32, // _guid (not used)
        bytes calldata _message,
        address, // _executor (not used)
        bytes calldata // _extraData (not used)
    ) external payable onlyEndpointV2 {
        // verify that _from address is actually a Stargate pool by checking if Stargate's
        // TokenMessaging contract has an assetId registered for this address
        if (tokenMessaging.assetIds(_from) == 0) revert UnAuthorized();

        // get the address of the token that was received from Stargate bridge
        address bridgedAssetId = IPool(_from).token();

        // decode payload
        (
            bytes32 transactionId,
            LibSwap.SwapData[] memory swapData,
            address receiver
        ) = abi.decode(
                OFTComposeMsgCodec.composeMsg(_message),
                (bytes32, LibSwap.SwapData[], address)
            );

        // execute swap(s)
        _swapAndCompleteBridgeTokens(
            transactionId,
            swapData,
            bridgedAssetId,
            payable(receiver),
            OFTComposeMsgCodec.amountLD(_message)
        );
    }

    /// @notice Send remaining token to receiver
    /// @param assetId address of the token to be withdrawn (not to be confused with StargateV2's assetIds which are uint16 values)
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function pullToken(
        address assetId,
        address payable receiver,
        uint256 amount
    ) external onlyOwner {
        if (LibAsset.isNativeAsset(assetId)) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = receiver.call{ value: amount }("");
            if (!success) revert ExternalCallFailed();
        } else {
            IERC20(assetId).safeTransfer(receiver, amount);
        }
    }

    /// Private Methods ///

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId address of the token received from the source chain (not to be confused with StargateV2's assetIds which are uint16 values)
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        uint256 cacheGasLeft = gasleft();

        if (LibAsset.isNativeAsset(assetId)) {
            // case 1: native asset
            if (cacheGasLeft < recoverGas) {
                // case 1a: not enough gas left to execute calls
                // solhint-disable-next-line avoid-low-level-calls
                (bool success, ) = receiver.call{ value: amount }("");
                if (!success) revert ExternalCallFailed();

                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
                return;
            }

            // case 1b: enough gas left to execute calls
            // solhint-disable no-empty-blocks
            try
                executor.swapAndCompleteBridgeTokens{
                    value: amount,
                    gas: cacheGasLeft - recoverGas
                }(_transactionId, _swapData, assetId, receiver)
            {} catch {
                // solhint-disable-next-line avoid-low-level-calls
                (bool success, ) = receiver.call{ value: amount }("");
                if (!success) revert ExternalCallFailed();

                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
            }
        } else {
            // case 2: ERC20 asset
            IERC20 token = IERC20(assetId);
            token.safeApprove(address(executor), 0);

            if (cacheGasLeft < recoverGas) {
                // case 2a: not enough gas left to execute calls
                token.safeTransfer(receiver, amount);

                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
                return;
            }

            // case 2b: enough gas left to execute calls
            token.safeIncreaseAllowance(address(executor), amount);
            try
                executor.swapAndCompleteBridgeTokens{
                    gas: cacheGasLeft - recoverGas
                }(_transactionId, _swapData, assetId, receiver)
            {} catch {
                token.safeTransfer(receiver, amount);
                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
            }

            token.safeApprove(address(executor), 0);
        }
    }

    /// @notice Receive native asset directly.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
