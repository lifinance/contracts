// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";

enum MessengerProtocol {
    None,
    Allbridge,
    Wormhole,
    LayerZero
}

interface IAllBridge {
    function pools(bytes32 addr) external returns (address);

    function swapAndBridge(
        bytes32 token,
        uint256 amount,
        bytes32 recipient,
        uint8 destinationChainId,
        bytes32 receiveToken,
        uint256 nonce,
        MessengerProtocol messenger
    ) external payable;
}

/// @title Allbridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through AllBridge
contract AllBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    IAllBridge public immutable allBridge;

    error DoesNotSupportNativeTransfer();

    struct AllBridgeData {
        uint256 fees;
        bytes32 recipient;
        uint8 destinationChainId;
        bytes32 receiveToken;
        uint256 nonce;
        MessengerProtocol messenger;
    }

    constructor(IAllBridge _allBridge) {
        allBridge = _allBridge;
    }

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

    function _toBytes(address a) internal pure returns (bytes memory) {
        return abi.encodePacked(a);
    }

    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AllBridgeData calldata _allBridgeData
    ) internal {
        bool isNative = _bridgeData.sendingAssetId == LibAsset.NATIVE_ASSETID;
        if (isNative) {
            revert DoesNotSupportNativeTransfer();
        } else {
            address pool = allBridge.pools(
                bytes32(uint256(uint160(_bridgeData.sendingAssetId)))
            );
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                pool,
                _bridgeData.minAmount
            );
        }

        allBridge.swapAndBridge{
            value: isNative
                ? _bridgeData.minAmount + _allBridgeData.fees
                : _allBridgeData.fees
        }(
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
