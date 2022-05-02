// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICBridge } from "../Interfaces/ICBridge.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, CannotBridgeToSameNetwork, NativeValueWithERC, InvalidConfig } from "../Errors/GenericErrors.sol";
import { Swapper, LibSwap } from "../Helpers/Swapper.sol";

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
contract CBridgeFacet is ILiFi, Swapper, ReentrancyGuard {
    /// Storage ///

    bytes32 internal constant NAMESPACE = hex"86b79a219228d788dd4fea892f48eec79167ea6d19d7f61e274652b2797c5b12"; //keccak256("com.lifi.facets.cbridge2");
    struct Storage {
        address cBridge;
        uint64 cBridgeChainId;
    }

    /// Types ///

    struct CBridgeData {
        uint32 maxSlippage;
        uint64 dstChainId;
        uint64 nonce;
        uint256 amount;
        address receiver;
        address token;
    }

    /// Events ///

    event CBridgeInitialized(address cBridge, uint256 chainId);

    /// Init ///

    /// @notice Initializes local variables for the CBridge facet
    /// @param _cBridge address of the canonical CBridge router contract
    /// @param _chainId chainId of this deployed contract
    function initCbridge(address _cBridge, uint64 _chainId) external {
        LibDiamond.enforceIsContractOwner();
        if (_cBridge == address(0)) revert InvalidConfig();
        Storage storage s = getStorage();
        s.cBridge = _cBridge;
        s.cBridgeChainId = _chainId;
        emit CBridgeInitialized(_cBridge, _chainId);
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _cBridgeData data specific to CBridge
    function startBridgeTokensViaCBridge(LiFiData calldata _lifiData, CBridgeData calldata _cBridgeData)
        external
        payable
        nonReentrant
    {
        LibAsset.depositAsset(_cBridgeData.token, _cBridgeData.amount);
        _startBridge(_cBridgeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "cbridge",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _cBridgeData.token,
            _lifiData.receivingAssetId,
            _cBridgeData.receiver,
            _cBridgeData.amount,
            _cBridgeData.dstChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via CBridge
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _cBridgeData data specific to CBridge
    function swapAndStartBridgeTokensViaCBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        CBridgeData memory _cBridgeData
    ) external payable nonReentrant {
        _cBridgeData.amount = _executeAndCheckSwaps(_lifiData, _swapData);
        _startBridge(_cBridgeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "cbridge",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _cBridgeData.receiver,
            _swapData[0].fromAmount,
            _cBridgeData.dstChainId,
            true,
            false
        );
    }

    /// Private Methods ///

    /// @dev Conatains the business logic for the bridge via CBridge
    /// @param _cBridgeData data specific to CBridge
    function _startBridge(CBridgeData memory _cBridgeData) private {
        Storage storage s = getStorage();
        address bridge = s.cBridge;

        // Do CBridge stuff
        if (s.cBridgeChainId == _cBridgeData.dstChainId) revert CannotBridgeToSameNetwork();

        if (LibAsset.isNativeAsset(_cBridgeData.token)) {
            ICBridge(bridge).sendNative{ value: _cBridgeData.amount }(
                _cBridgeData.receiver,
                _cBridgeData.amount,
                _cBridgeData.dstChainId,
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        } else {
            // Give CBridge approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_cBridgeData.token), bridge, _cBridgeData.amount);
            // solhint-disable check-send-result
            ICBridge(bridge).send(
                _cBridgeData.receiver,
                _cBridgeData.token,
                _cBridgeData.amount,
                _cBridgeData.dstChainId,
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        }
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
