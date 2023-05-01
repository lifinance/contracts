// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICBridge } from "../Interfaces/ICBridge.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { ContractCallNotAllowed, ExternalCallFailed } from "../Errors/GenericErrors.sol";

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
/// @custom:version 1.0.0
contract CBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;

    /// Types ///

    /// @param maxSlippage The max slippage accepted, given as percentage in point (pip).
    /// @param nonce A number input to guarantee uniqueness of transferId.
    ///              Can be timestamp in practice.
    struct CBridgeData {
        uint32 maxSlippage;
        uint64 nonce;
    }

    /// Events ///
    event CBridgeRefund(
        address indexed _assetAddress,
        address indexed _to,
        uint256 amount
    );

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge) {
        cBridge = _cBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function startBridgeTokensViaCBridge(
        ILiFi.BridgeData memory _bridgeData,
        CBridgeData calldata _cBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _cBridgeData);
    }

    /// @notice Performs a swap before bridging via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _cBridgeData data specific to CBridge
    function swapAndStartBridgeTokensViaCBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CBridgeData calldata _cBridgeData
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
        _startBridge(_bridgeData, _cBridgeData);
    }

    /// @notice Triggers a cBridge refund with calldata produced by cBridge API
    /// @param _callTo The address to execute the calldata on
    /// @param _callData The data to execute
    /// @param _assetAddress Asset to be withdrawn
    /// @param _to Address to withdraw to
    /// @param _amount Amount of asset to withdraw
    function triggerRefund(
        address payable _callTo,
        bytes calldata _callData,
        address _assetAddress,
        address _to,
        uint256 _amount
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        // make sure that callTo address is either of the cBridge addresses
        if (address(cBridge) != _callTo) {
            revert ContractCallNotAllowed();
        }

        // call contract
        bool success;
        (success, ) = _callTo.call(_callData);
        if (!success) {
            revert ExternalCallFailed();
        }

        // forward funds to _to address and emit event
        address sendTo = (LibUtil.isZeroAddress(_to)) ? msg.sender : _to;
        LibAsset.transferAsset(_assetAddress, payable(sendTo), _amount);
        emit CBridgeRefund(_assetAddress, sendTo, _amount);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CBridgeData calldata _cBridgeData
    ) private {
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            cBridge.sendNative{ value: _bridgeData.minAmount }(
                _bridgeData.receiver,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        } else {
            // Give CBridge approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(cBridge),
                _bridgeData.minAmount
            );
            // solhint-disable check-send-result
            cBridge.send(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
