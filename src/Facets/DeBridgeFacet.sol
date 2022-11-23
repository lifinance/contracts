// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IDeBridgeGate } from "../Interfaces/IDeBridgeGate.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";

/// @title DeBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through DeBridge Protocol
contract DeBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.debridge");

    /// @notice The contract address of the spoke pool on the source chain.
    IDeBridgeGate private immutable deBridgeGate;

    /// Types ///

    /// @param permit deadline + signature for approving the spender by signature.
    /// @param useAssetFee Use assets fee for pay protocol fix (work only for specials token)
    /// @param nativeFee Native fee for the bridging when useAssetFee is false.
    /// @param referralCode Referral code.
    /// @param executionFee Fee paid to the transaction executor.
    /// @param flags Flags set specific flows for call data execution.
    /// @param fallbackAddress Receiver of the tokens if the call fails.
    /// @param data Message/Call data to be passed to the receiver
    ///             on the destination chain during the external call execution.
    struct DeBridgeData {
        bytes permit;
        bool useAssetFee;
        uint256 nativeFee;
        uint32 referralCode;
        uint256 executionFee;
        uint256 flags;
        address fallbackAddress;
        bytes data;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _deBridgeGate The contract address of the DeBridgeGate on the source chain.
    constructor(IDeBridgeGate _deBridgeGate) {
        deBridgeGate = _deBridgeGate;
    }

    /// External Methods ///

    /// @notice Bridges tokens via DeBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _deBridgeData data specific to DeBridge
    function startBridgeTokensViaDeBridge(ILiFi.BridgeData calldata _bridgeData, DeBridgeData calldata _deBridgeData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _deBridgeData);
    }

    /// @notice Performs a swap before bridging via DeBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _deBridgeData data specific to DeBridge
    function swapAndStartBridgeTokensViaDeBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        DeBridgeData memory _deBridgeData
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
            payable(msg.sender),
            _deBridgeData.nativeFee
        );

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            _bridgeData.minAmount -= _deBridgeData.nativeFee;
        }

        _startBridge(_bridgeData, _deBridgeData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via DeBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _deBridgeData data specific to DeBridge
    function _startBridge(ILiFi.BridgeData memory _bridgeData, DeBridgeData memory _deBridgeData) internal {
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        uint256 nativeAssetAmount = _deBridgeData.nativeFee;

        if (isNative) {
            nativeAssetAmount += _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), address(deBridgeGate), _bridgeData.minAmount);
        }

        deBridgeGate.send{ value: nativeAssetAmount }(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            _bridgeData.destinationChainId,
            abi.encodePacked(_bridgeData.receiver),
            _deBridgeData.permit,
            _deBridgeData.useAssetFee,
            _deBridgeData.referralCode,
            abi.encode(
                _deBridgeData.executionFee,
                _deBridgeData.flags,
                abi.encodePacked(_deBridgeData.fallbackAddress),
                _deBridgeData.data
            )
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
