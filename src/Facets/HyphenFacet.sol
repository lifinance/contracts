// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHyphenRouter } from "../Interfaces/IHyphenRouter.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, CannotBridgeToSameNetwork, InvalidConfig } from "../Errors/GenericErrors.sol";
import { Swapper, LibSwap } from "../Helpers/Swapper.sol";

/// @title Hyphen Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hyphen
contract HyphenFacet is ILiFi, Swapper, ReentrancyGuard {
    /// Storage ///

    bytes32 internal constant NAMESPACE = hex"b4dba59cea9741f069693c5cc9e154fe2190cf9db6275fa7f1075a6a6c6668cc"; // keccak256("com.lifi.facets.hyphen")
    struct Storage {
        address hyphenRouter;
    }

    /// Types ///

    /// @param token The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param recipient The address of the token recipient after bridging.
    /// @param toChainId The chainId of the chain to bridge to.
    struct HyphenData {
        address token;
        uint256 amount;
        address recipient;
        uint256 toChainId;
    }

    /// Events ///

    event HyphenInitialized(address hyphenRouter);

    /// Init ///

    /// @notice Initializes local variables for the Hyphen facet
    /// @param _hyphenRouter address of the canonical Hyphen router contract
    function initHyphen(address _hyphenRouter) external {
        LibDiamond.enforceIsContractOwner();
        if (LibUtil.isZeroAddress(_hyphenRouter)) revert InvalidConfig();
        Storage storage s = getStorage();
        s.hyphenRouter = _hyphenRouter;

        emit HyphenInitialized(_hyphenRouter);
    }

    /// External Methods ///

    /// @notice Bridges tokens via Hyphen
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _hyphenData data specific to Hyphen
    function startBridgeTokensViaHyphen(LiFiData calldata _lifiData, HyphenData calldata _hyphenData)
        external
        payable
        nonReentrant
    {
        LibAsset.depositAsset(_hyphenData.token, _hyphenData.amount);
        _startBridge(_hyphenData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "hyphen",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _hyphenData.token,
            _lifiData.receivingAssetId,
            _hyphenData.recipient,
            _hyphenData.amount,
            _hyphenData.toChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via Hyphen
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hyphenData data specific to Hyphen
    function swapAndStartBridgeTokensViaHyphen(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        HyphenData memory _hyphenData
    ) external payable nonReentrant {
        _hyphenData.amount = _executeAndCheckSwaps(_lifiData, _swapData);
        _startBridge(_hyphenData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "hyphen",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _hyphenData.recipient,
            _swapData[0].fromAmount,
            _hyphenData.toChainId,
            true,
            false
        );
    }

    /// Private Methods ///

    /// @dev Conatains the business logic for the bridge via Hyphen
    /// @param _hyphenData data specific to Hyphen
    function _startBridge(HyphenData memory _hyphenData) private {
        Storage storage s = getStorage();

        // Check chain id
        if (block.chainid == _hyphenData.toChainId) revert CannotBridgeToSameNetwork();

        if (!LibAsset.isNativeAsset(_hyphenData.token)) {
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

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
