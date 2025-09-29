// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidAmount, InvalidDestinationChain } from "../Errors/GenericErrors.sol";

/// @title Unit Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Unit
/// @custom:version 1.0.0
contract UnitFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// EIP-712 ///
    bytes32 private immutable DOMAIN_SEPARATOR;
    // keccak256("UnitPayload(address depositAddress,uint256 sourceChainId,uint256 destinationChainId,address receiver,address sendingAssetId)");
    bytes32 private constant UNIT_PAYLOAD_TYPEHASH =
        0x82a983372d822557736934c2ea24e131d9908a8f7c225091a32d18080c1d683a; // TODO change
    address internal immutable BACKEND_SIGNER;

    /// Types ///
    struct UnitData {
        address depositAddress;
        bytes signature;
    }

    // EIP-712 - data that is signed by the backend
    struct UnitPayload {
        address depositAddress;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address receiver;
        address sendingAssetId;
    }

    /// Errors ///
    error InvalidQuote();

    /// Constructor ///
    constructor(address _backendSigner) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("LI.FI Unit Facet"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        BACKEND_SIGNER = _backendSigner;
    }

    /// External Methods ///

    function startBridgeTokensViaUnit(
        ILiFi.BridgeData memory _bridgeData,
        UnitData calldata _unitData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        onlyAllowSourceToken(_bridgeData, _bridgeData.sendingAssetId)
    {
        if (
            _bridgeData.destinationChainId != 999 ||
            _bridgeData.destinationChainId != 1 ||
            _bridgeData.destinationChainId != 9745
        ) {
            revert InvalidDestinationChain();
        }
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _unitData);
    }

    function swapAndStartBridgeTokensViaUnit(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        UnitData calldata _unitData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, _bridgeData.sendingAssetId)
        onlyAllowDestinationChain(_bridgeData, 999)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _unitData);
    }

    /// Internal Methods ///
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        UnitData calldata _unitData
    ) internal {
        if (_bridgeData.minAmount < 0.05 ether) {
            revert InvalidAmount();
        }

        // verify signature here

        LibAsset.transferNativeAsset(
            payable(_unitData.depositAddress),
            _bridgeData.minAmount
        );
        emit LiFiTransferStarted(_bridgeData);
    }
}
