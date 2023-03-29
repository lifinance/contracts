// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IDeBridgeGate } from "../Interfaces/IDeBridgeGate.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InformationMismatch, InvalidAmount } from "../Errors/GenericErrors.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title DeBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through DeBridge Protocol
contract DeBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the spoke pool on the source chain.
    IDeBridgeGate private immutable deBridgeGate;

    /// Types ///

    /// @param executionFee Fee paid to the transaction executor.
    /// @param flags Flags set specific flows for call data execution.
    /// @param fallbackAddress Receiver of the tokens if the call fails.
    /// @param data Message/Call data to be passed to the receiver
    ///             on the destination chain during the external call execution.
    struct SubmissionAutoParamsTo {
        uint256 executionFee;
        uint256 flags;
        bytes fallbackAddress;
        bytes data;
    }

    /// @param permit deadline + signature for approving the spender by signature.
    /// @param nativeFee Native fee for the bridging when useAssetFee is false.
    /// @param useAssetFee Use assets fee for pay protocol fix (work only for specials token)
    /// @param referralCode Referral code.
    /// @param autoParams Structure that enables passing arbitrary messages and call data.
    struct DeBridgeData {
        bytes permit;
        uint256 nativeFee;
        bool useAssetFee;
        uint32 referralCode;
        SubmissionAutoParamsTo autoParams;
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
    function startBridgeTokensViaDeBridge(
        ILiFi.BridgeData calldata _bridgeData,
        DeBridgeData calldata _deBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _deBridgeData);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _deBridgeData);
    }

    /// @notice Performs a swap before bridging via DeBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _deBridgeData data specific to DeBridge
    function swapAndStartBridgeTokensViaDeBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        DeBridgeData calldata _deBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _deBridgeData);

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _deBridgeData.nativeFee
        );

        _startBridge(_bridgeData, _deBridgeData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via DeBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _deBridgeData data specific to DeBridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        DeBridgeData calldata _deBridgeData
    ) internal {
        IDeBridgeGate.ChainSupportInfo memory config = deBridgeGate
            .getChainToConfig(_bridgeData.destinationChainId);
        uint256 nativeFee = config.fixedNativeFee == 0
            ? deBridgeGate.globalFixedNativeFee()
            : config.fixedNativeFee;

        if (_deBridgeData.nativeFee != nativeFee) {
            revert InvalidAmount();
        }

        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        uint256 nativeAssetAmount = _deBridgeData.nativeFee;

        if (isNative) {
            nativeAssetAmount += _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(deBridgeGate),
                _bridgeData.minAmount
            );
        }

        deBridgeGate.send{ value: nativeAssetAmount }(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            _bridgeData.destinationChainId,
            abi.encodePacked(_bridgeData.receiver),
            _deBridgeData.permit,
            _deBridgeData.useAssetFee,
            _deBridgeData.referralCode,
            abi.encode(_deBridgeData.autoParams)
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    function validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        DeBridgeData calldata _deBridgeData
    ) private pure {
        if (
            (_deBridgeData.autoParams.data.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
    }
}
