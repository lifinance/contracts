// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAnyswapRouter } from "../Interfaces/IAnyswapRouter.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { IAnyswapToken } from "../Interfaces/IAnyswapToken.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibStorage } from "../Libraries/LibStorage.sol";

/**
 * @title Anyswap Facet
 * @author Li.Finance (https://li.finance)
 * @notice Provides functionality for bridging through Multichain (Prev. AnySwap)
 */
contract AnyswapFacet is ILiFi {
    /* ========== Types ========== */
    LibStorage internal ls;

    struct AnyswapData {
        address token;
        address router;
        uint256 amount;
        address recipient;
        uint256 toChainId;
    }

    /* ========== Public Bridge Functions ========== */

    /**
     * @notice Bridges tokens via Anyswap
     * @param _lifiData data used purely for tracking and analytics
     * @param _anyswapData data specific to Anyswap
     */
    function startBridgeTokensViaAnyswap(LiFiData memory _lifiData, AnyswapData calldata _anyswapData) public payable {
        if (_anyswapData.token != address(0)) {
            address underlyingToken = IAnyswapToken(_anyswapData.token).underlying();

            uint256 _fromTokenBalance = LibAsset.getOwnBalance(underlyingToken);
            LibAsset.transferFromERC20(underlyingToken, msg.sender, address(this), _anyswapData.amount);

            require(
                LibAsset.getOwnBalance(underlyingToken) - _fromTokenBalance == _anyswapData.amount,
                "ERR_INVALID_AMOUNT"
            );
        } else {
            require(msg.value == _anyswapData.amount, "ERR_INVALID_AMOUNT");
        }

        _startBridge(_anyswapData);

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
     * @notice Performs a swap before bridging via Anyswap
     * @param _lifiData data used purely for tracking and analytics
     * @param _swapData an array of swap related data for performing swaps before bridging
     * @param _anyswapData data specific to Anyswap
     */
    function swapAndStartBridgeTokensViaAnyswap(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        AnyswapData memory _anyswapData
    ) public payable {
        if (_anyswapData.token != address(0)) {
            address underlyingToken = IAnyswapToken(_anyswapData.token).underlying();
            uint256 _fromTokenBalance = LibAsset.getOwnBalance(underlyingToken);

            // Swap
            for (uint8 i; i < _swapData.length; i++) {
                require(
                    ls.dexWhitelist[_swapData[i].approveTo] == true && ls.dexWhitelist[_swapData[i].callTo] == true,
                    "Contract call not allowed!"
                );
                LibSwap.swap(_lifiData.transactionId, _swapData[i]);
            }

            uint256 _postSwapBalance = LibAsset.getOwnBalance(underlyingToken) - _fromTokenBalance;

            require(_postSwapBalance > 0, "ERR_INVALID_AMOUNT");

            _anyswapData.amount = _postSwapBalance;
        } else {
            uint256 _fromBalance = address(this).balance;

            // Swap
            for (uint8 i; i < _swapData.length; i++) {
                require(
                    ls.dexWhitelist[_swapData[i].approveTo] == true && ls.dexWhitelist[_swapData[i].callTo] == true,
                    "Contract call not allowed!"
                );
                LibSwap.swap(_lifiData.transactionId, _swapData[i]);
            }

            require(address(this).balance - _fromBalance >= _anyswapData.amount, "ERR_INVALID_AMOUNT");

            uint256 _postSwapBalance = address(this).balance - _fromBalance;

            require(_postSwapBalance > 0, "ERR_INVALID_AMOUNT");

            _anyswapData.amount = _postSwapBalance;
        }

        _startBridge(_anyswapData);

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
     * @dev Conatains the business logic for the bridge via Anyswap
     * @param _anyswapData data specific to Anyswap
     */
    function _startBridge(AnyswapData memory _anyswapData) internal {
        // Check chain id
        require(block.chainid != _anyswapData.toChainId, "Cannot bridge to the same network.");

        if (_anyswapData.token != address(0)) {
            // Give Anyswap approval to bridge tokens
            LibAsset.approveERC20(
                IERC20(IAnyswapToken(_anyswapData.token).underlying()),
                _anyswapData.router,
                _anyswapData.amount
            );

            IAnyswapRouter(_anyswapData.router).anySwapOutUnderlying(
                _anyswapData.token,
                _anyswapData.recipient,
                _anyswapData.amount,
                _anyswapData.toChainId
            );
        } else {
            IAnyswapRouter(_anyswapData.router).anySwapOutNative{ value: _anyswapData.amount }(
                _anyswapData.token,
                _anyswapData.recipient,
                _anyswapData.toChainId
            );
        }
    }
}
