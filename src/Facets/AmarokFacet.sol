// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IConnextHandler } from "../Interfaces/IConnextHandler.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InformationMismatch } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Amarok Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Connext Amarok
/// @custom:version 1.0.1
contract AmarokFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the connext handler on the source chain.
    IConnextHandler private immutable connextHandler;

    /// @param callData The data to execute on the receiving chain. If no crosschain call is needed, then leave empty.
    /// @param callTo The address of the contract on dest chain that will receive bridged funds and execute data
    /// @param relayerFee The amount of relayer fee the tx called xcall with
    /// @param slippageTol Max bps of original due to slippage (i.e. would be 9995 to tolerate .05% slippage)
    /// @param delegate Destination delegate address
    /// @param destChainDomainId The Amarok-specific domainId of the destination chain
    struct AmarokData {
        bytes callData;
        address callTo;
        uint256 relayerFee;
        uint256 slippageTol;
        address delegate;
        uint32 destChainDomainId;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _connextHandler The contract address of the connext handler on the source chain.
    constructor(IConnextHandler _connextHandler) {
        connextHandler = _connextHandler;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Amarok
    /// @param _bridgeData Data containing core information for bridging
    /// @param _amarokData Data specific to bridge
    function startBridgeTokensViaAmarok(
        BridgeData calldata _bridgeData,
        AmarokData calldata _amarokData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _amarokData);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _amarokData);
    }

    /// @notice Performs a swap before bridging via Amarok
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _amarokData Data specific to Amarok
    function swapAndStartBridgeTokensViaAmarok(
        BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AmarokData calldata _amarokData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _amarokData);

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _amarokData.relayerFee
        );
        _startBridge(_bridgeData, _amarokData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Amarok
    /// @param _bridgeData The core information needed for bridging
    /// @param _amarokData Data specific to Amarok
    function _startBridge(
        BridgeData memory _bridgeData,
        AmarokData calldata _amarokData
    ) private {
        // give max approval for token to Amarok bridge, if not already
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(connextHandler),
            _bridgeData.minAmount
        );

        address receiver = _bridgeData.hasDestinationCall
            ? _amarokData.callTo
            : _bridgeData.receiver;

        // initiate bridge transaction
        connextHandler.xcall{ value: _amarokData.relayerFee }(
            _amarokData.destChainDomainId,
            receiver,
            _bridgeData.sendingAssetId,
            _amarokData.delegate,
            _bridgeData.minAmount,
            _amarokData.slippageTol,
            _amarokData.callData
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    function validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        AmarokData calldata _amarokData
    ) private pure {
        if (
            (_amarokData.callData.length > 0) != _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
    }
}
