// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAllBridge } from "../Interfaces/IAllBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";

/// @title Allbridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through AllBridge
contract AllBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// @notice The contract address of the AllBridge router on the source chain.
    IAllBridge public immutable allBridge;

    /// @notice The struct for the AllBridge data.
    /// @param fees The amount of token to pay the messenger and the bridge
    /// @param recipient The address of the token receiver after bridging.
    /// @param destinationChainId The destination chain id.
    /// @param receiveToken The token to receive on the destination chain.
    /// @param nonce A random nonce to associate with the tx.
    /// @param messenger The messenger protocol enum
    struct AllBridgeData {
        uint256 fees;
        bytes32 recipient;
        uint8 destinationChainId;
        bytes32 receiveToken;
        uint256 nonce;
        IAllBridge.MessengerProtocol messenger;
    }

    /// @notice Initializes the AllBridge contract
    /// @param _allBridge The address of the AllBridge contract
    constructor(IAllBridge _allBridge) {
        allBridge = _allBridge;
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    function startBridgeTokensViaAllBridge(
        ILiFi.BridgeData memory _bridgeData,
        AllBridgeData calldata _allBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _allBridgeData);
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    /// @param _swapData The swap data struct
    /// @param _allBridgeData The AllBridge data struct
    function swapAndStartBridgeTokensViaAllBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AllBridgeData calldata _allBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _allBridgeData);
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    /// @param _allBridgeData The allBridge data struct for AllBridge specicific data
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AllBridgeData calldata _allBridgeData
    ) internal {
        address pool = allBridge.pools(
            bytes32(uint256(uint160(_bridgeData.sendingAssetId)))
        );
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            pool,
            _bridgeData.minAmount
        );

        allBridge.swapAndBridge{ value: _allBridgeData.fees }(
            bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
            _bridgeData.minAmount,
            _allBridgeData.recipient,
            _allBridgeData.destinationChainId,
            _allBridgeData.receiveToken,
            _allBridgeData.nonce,
            _allBridgeData.messenger
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
