// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Hop Facet (Optimized)
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacetOptimized is ILiFi, SwapperV2, Validatable {
    /// Types ///

    struct HopData {
        uint256 bonderFee;
        uint256 amountOutMin;
        uint256 deadline;
        uint256 destinationAmountOutMin;
        uint256 destinationDeadline;
        IHopBridge hopBridge;
    }

    /// Events ///

    event HopBridgeRegistered(address indexed assetId, address bridge);

    /// External Methods ///

    /// @notice Sets approval for the Hop Bridge to spend the specified token
    /// @param bridges The Hop Bridges to approve
    /// @param tokensToApprove The tokens to approve to approve to the Hop Bridges
    function setApprovalForBridges(address[] calldata bridges, address[] calldata tokensToApprove) external {
        for (uint256 i; i < bridges.length; i++) {
            // Give Hop approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(tokensToApprove[i]), address(bridges[i]), type(uint256).max);
        }
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L1
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHopL1ERC20(ILiFi.BridgeData calldata _bridgeData, HopData calldata _hopData)
        external
        validateBridgeData(_bridgeData)
    {
        // Deposit assets
        LibAsset.transferFromERC20(_bridgeData.sendingAssetId, msg.sender, address(this), _bridgeData.minAmount);
        // Bridge assets
        _hopData.hopBridge.sendToL2(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline,
            address(0),
            0
        );
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Bridges Native tokens via Hop Protocol from L1
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHopL1Native(ILiFi.BridgeData calldata _bridgeData, HopData calldata _hopData)
        external
        payable
        validateBridgeData(_bridgeData)
    {
        // Bridge assets
        _hopData.hopBridge.sendToL2{ value: _bridgeData.minAmount }(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline,
            address(0),
            0
        );
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Performs a swap before bridging ERC20 tokens via Hop Protocol from L1
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHopL1ERC20(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HopData calldata _hopData
    ) external validateBridgeData(_bridgeData) {
        // Deposit and swap assets
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        // Bridge assets
        _hopData.hopBridge.sendToL2(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline,
            address(0),
            0
        );
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Performs a swap before bridging Native tokens via Hop Protocol from L1
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHopL1Native(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HopData calldata _hopData
    ) external payable validateBridgeData(_bridgeData) {
        // Deposit and swap assets
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        // Bridge assets
        _hopData.hopBridge.sendToL2{ value: _bridgeData.minAmount }(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline,
            address(0),
            0
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHopL2ERC20(ILiFi.BridgeData calldata _bridgeData, HopData calldata _hopData)
        external
        validateBridgeData(_bridgeData)
    {
        // Deposit assets
        LibAsset.transferFromERC20(_bridgeData.sendingAssetId, msg.sender, address(this), _bridgeData.minAmount);
        // Bridge assets
        _hopData.hopBridge.swapAndSend(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.bonderFee,
            _hopData.amountOutMin,
            _hopData.deadline,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline
        );
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHopL2Native(ILiFi.BridgeData calldata _bridgeData, HopData calldata _hopData)
        external
        payable
        validateBridgeData(_bridgeData)
    {
        // Bridge assets
        _hopData.hopBridge.swapAndSend{ value: _bridgeData.minAmount }(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.bonderFee,
            _hopData.amountOutMin,
            _hopData.deadline,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline
        );
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Performs a swap before bridging ERC20 tokens via Hop Protocol from L2
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHopL2ERC20(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HopData calldata _hopData
    ) external validateBridgeData(_bridgeData) {
        // Deposit and swap assets
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        // Bridge assets
        _hopData.hopBridge.swapAndSend(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.bonderFee,
            _hopData.amountOutMin,
            _hopData.deadline,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline
        );
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Performs a swap before bridging Native tokens via Hop Protocol from L2
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHopL2Native(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HopData calldata _hopData
    ) external payable validateBridgeData(_bridgeData) {
        // Deposit and swap assets
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        // Bridge assets
        _hopData.hopBridge.swapAndSend{ value: _bridgeData.minAmount }(
            _bridgeData.destinationChainId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _hopData.bonderFee,
            _hopData.amountOutMin,
            _hopData.deadline,
            _hopData.destinationAmountOutMin,
            _hopData.destinationDeadline
        );
        emit LiFiTransferStarted(_bridgeData);
    }
}
