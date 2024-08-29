// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAcrossSpokePool } from "../Interfaces/IAcrossSpokePool.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InformationMismatch } from "../Errors/GenericErrors.sol";

/// @title AcrossFacetV3
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across Protocol
/// @custom:version 1.0.0
contract AcrossFacetV3 is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the spoke pool on the source chain.
    IAcrossSpokePool public immutable spokePool;

    /// @notice The WETH address on the current chain.
    address public immutable wrappedNative;

    /// Types ///

    /// @param receiverAddress The address that will receive the token on dst chain (our Receiver contract or the user-defined receiver address)
    /// @param refundAddress The address that will be used for potential bridge refunds
    /// @param receivingAssetId The address of the token to be received at destination chain
    /// @param outputAmount The amount to be received at destination chain (after fees)
    /// @param quoteTimestamp The timestamp of the Across quote that was used for this transaction
    /// @param fillDeadline The destination chain timestamp until which the order can be filled
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens
    struct AcrossV3Data {
        address receiverAddress;
        address refundAddress;
        address receivingAssetId;
        uint256 outputAmount;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        bytes message;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _spokePool The contract address of the spoke pool on the source chain.
    /// @param _wrappedNative The address of the wrapped native token on the source chain.
    constructor(IAcrossSpokePool _spokePool, address _wrappedNative) {
        spokePool = _spokePool;
        wrappedNative = _wrappedNative;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function startBridgeTokensViaAcrossV3(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV3Data calldata _acrossData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _acrossData);
    }

    /// @notice Performs a swap before bridging via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _acrossData data specific to Across
    function swapAndStartBridgeTokensViaAcrossV3(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AcrossV3Data calldata _acrossData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _acrossData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV3Data calldata _acrossData
    ) internal {
        // validate destination call flag
        if (_acrossData.message.length > 0 != _bridgeData.hasDestinationCall)
            revert InformationMismatch();

        // ensure that receiver addresses match in case of no destination call
        if (
            !_bridgeData.hasDestinationCall &&
            (_bridgeData.receiver != _acrossData.receiverAddress)
        ) revert InformationMismatch();

        // check if sendingAsset is native or ERC20
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // NATIVE
            spokePool.depositV3{ value: _bridgeData.minAmount }(
                _acrossData.refundAddress, // depositor (also acts as refund address in case release tx cannot be executed)
                _acrossData.receiverAddress, // recipient (on dst)
                wrappedNative, // inputToken
                _acrossData.receivingAssetId, // outputToken
                _bridgeData.minAmount, // inputAmount
                _acrossData.outputAmount, // outputAmount
                _bridgeData.destinationChainId,
                address(0), // exclusiveRelayer (not used by us)
                _acrossData.quoteTimestamp,
                _acrossData.fillDeadline,
                0, // exclusivityDeadline (not used by us)
                _acrossData.message
            );
        } else {
            // ERC20
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(spokePool),
                _bridgeData.minAmount
            );
            spokePool.depositV3(
                _acrossData.refundAddress, // depositor (also acts as refund address in case release tx cannot be executed)
                _acrossData.receiverAddress, // recipient (on dst)
                _bridgeData.sendingAssetId, // inputToken
                _acrossData.receivingAssetId, // outputToken
                _bridgeData.minAmount, // inputAmount
                _acrossData.outputAmount, // outputAmount
                _bridgeData.destinationChainId,
                address(0), // exclusiveRelayer (not used by us)
                _acrossData.quoteTimestamp,
                _acrossData.fillDeadline,
                0, // exclusivityDeadline (not used by us)
                _acrossData.message
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
