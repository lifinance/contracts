// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHyphenRouter } from "../Interfaces/IHyphenRouter.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import "./Swapper.sol";

/**
 * @title Hyphen Facet
 * @author LI.FI (https://li.fi)
 * @notice Provides functionality for bridging through Hyphen
 */
contract HyphenFacet is ILiFi, Swapper {
    /* ========== Storage ========== */

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.hyphen");
    struct Storage {
        address hyphenRouter;
    }

    /* ========== Types ========== */

    /**
     * @param token The contract address of the token being bridged.
     * @param amount The amount of tokens to bridge.
     * @param recipient The address of the token recipient after bridging.
     * @param toChainId The chainId of the chain to bridge to.
     */
    struct HyphenData {
        address token;
        uint256 amount;
        address recipient;
        uint256 toChainId;
    }

    /* ========== Errors ========== */

    error InvalidConfig();

    /* ========== Init ========== */

    /**
     * @notice Initializes local variables for the Hyphen facet
     * @param _hyphenRouter address of the canonical Hyphen router contract
     */
    function initHyphen(address _hyphenRouter) external {
        if (_hyphenRouter == address(0)) {
            revert InvalidConfig();
        }

        Storage storage s = getStorage();
        LibDiamond.enforceIsContractOwner();
        s.hyphenRouter = _hyphenRouter;
    }

    /* ========== Public Bridge Functions ========== */

    /**
     * @notice Bridges tokens via Hyphen
     * @param _lifiData data used purely for tracking and analytics
     * @param _hyphenData data specific to Hyphen
     */
    function startBridgeTokensViaHyphen(LiFiData memory _lifiData, HyphenData calldata _hyphenData) external payable {
        if (_hyphenData.token != address(0)) {
            uint256 _fromTokenBalance = LibAsset.getOwnBalance(_hyphenData.token);

            LibAsset.transferFromERC20(_hyphenData.token, msg.sender, address(this), _hyphenData.amount);

            require(
                LibAsset.getOwnBalance(_hyphenData.token) - _fromTokenBalance == _hyphenData.amount,
                "ERR_INVALID_AMOUNT"
            );
        } else {
            require(msg.value == _hyphenData.amount, "ERR_INVALID_AMOUNT");
        }

        _startBridge(_hyphenData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            _lifiData.receivingAssetId,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            block.timestamp
        );
    }

    /**
     * @notice Performs a swap before bridging via Hyphen
     * @param _lifiData data used purely for tracking and analytics
     * @param _swapData an array of swap related data for performing swaps before bridging
     * @param _hyphenData data specific to Hyphen
     */
    function swapAndStartBridgeTokensViaHyphen(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        HyphenData memory _hyphenData
    ) external payable {
        address sendingAssetId = _hyphenData.token;

        uint256 _sendingAssetIdBalance = LibAsset.getOwnBalance(sendingAssetId);

        // Swap
        _executeSwaps(_lifiData, _swapData);

        uint256 _postSwapBalance = LibAsset.getOwnBalance(sendingAssetId) - _sendingAssetIdBalance;

        require(_postSwapBalance != 0, "ERR_INVALID_AMOUNT");

        _hyphenData.amount = _postSwapBalance;

        _startBridge(_hyphenData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            _lifiData.receivingAssetId,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            block.timestamp
        );
    }

    /* ========== Internal Functions ========== */

    /**
     * @dev Conatains the business logic for the bridge via Hyphen
     * @param _hyphenData data specific to Hyphen
     */
    function _startBridge(HyphenData memory _hyphenData) internal {
        Storage storage s = getStorage();

        // Check chain id
        require(block.chainid != _hyphenData.toChainId, "Cannot bridge to same network.");

        if (_hyphenData.token != address(0)) {
            // Give Anyswap approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_hyphenData.token), s.hyphenRouter, _hyphenData.amount);

            IHyphenRouter(s.hyphenRouter).depositErc20(
                _hyphenData.toChainId,
                _hyphenData.token,
                _hyphenData.recipient,
                _hyphenData.amount,
                "LIFI"
            );
        } else {
            IHyphenRouter(s.hyphenRouter).depositNative{ value: _hyphenData.amount }(
                _hyphenData.recipient,
                _hyphenData.toChainId,
                "LIFI"
            );
        }
    }

    /**
     * @dev fetch local storage
     */
    function getStorage() internal pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
