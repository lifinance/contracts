// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";
import { NativeAssetTransferFailed } from "lifi/Errors/GenericErrors.sol";

interface IGasZip {
    function deposit(
        uint256 destinationChains,
        address recipient
    ) external payable;
}

/// @title GasZipFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap ERC20 tokens to native and deposit them to the  gas.zip protocol (https://www.gas.zip/)
/// @custom:version 1.0.0
contract GasZipFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeTransferLib for address;

    /// @dev GasZip-specific bridge data
    /// @param destinationChains a value that represents a list of chains to which gas should be distributed (see https://dev.gas.zip/gas/code-examples/deposit for more details)
    /// @param gasZipSwapData (only required for ERC20 tokens): the swapData that swaps from ERC20 to native before depositing to gas.zip
    struct GasZipData {
        uint256 destinationChains;
        LibSwap.SwapData gasZipSwapData;
    }

    /// State ///
    IGasZip public immutable gasZipRouter;

    /// Constructor ///
    constructor(address _gasZipRouter) {
        gasZipRouter = IGasZip(_gasZipRouter);
    }

    /// @notice Bridges tokens using the gas.zip protocol
    /// @param _bridgeData The core information needed for bridging
    /// @param _gasZipData GasZip-specific bridge data
    function startBridgeTokensViaGasZip(
        ILiFi.BridgeData memory _bridgeData,
        GasZipData calldata _gasZipData
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

        _startBridge(_bridgeData, _gasZipData);
    }

    /// @notice Performs a swap before bridging via the gas.zip protocol
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _gasZipData GasZip-specific bridge data
    function swapAndStartBridgeTokensViaGasZip(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        GasZipData calldata _gasZipData
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

        _startBridge(_bridgeData, _gasZipData);
    }

    /// @notice Swaps ERC20 tokens to native and deposits these native tokens in the GasZip router contract
    /// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
    /// @param _swapData The swap data that executes the swap from ERC20 to native
    /// @param _destinationChains a value that represents a list of chains to which gas should be distributed
    /// @param _recipient the address to receive the gas on dst chain
    function depositToGasZipERC20(
        LibSwap.SwapData calldata _swapData,
        uint256 _destinationChains,
        address _recipient
    ) public {
        // execute the swapData that swaps the ERC20 token into native
        LibSwap.swap(0, _swapData);

        // call the gas zip router and deposit tokens
        gasZipRouter.deposit{ value: address(this).balance }(
            _destinationChains,
            _recipient
        );
    }

    /// @notice Deposits native tokens in the GasZip router contract
    /// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
    /// @param _amountToZip The amount to be deposited to the protocol
    /// @param _destinationChains a value that represents a list of chains to which gas should be distributed
    /// @param _recipient the address to receive the gas on dst chain
    function depositToGasZipNative(
        uint256 _amountToZip,
        uint256 _destinationChains,
        address _recipient
    ) public payable {
        // call the gas zip router and deposit tokens
        gasZipRouter.deposit{ value: _amountToZip }(
            _destinationChains,
            _recipient
        );
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Gas.zip
    /// @param _bridgeData The core information needed for bridging
    /// @param _gasZipData GasZip-specific bridge data
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        GasZipData calldata _gasZipData
    ) internal {
        // deposit to gas.zip depending on which asset type is being used
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId))
            depositToGasZipNative(
                _bridgeData.minAmount,
                _gasZipData.destinationChains,
                _bridgeData.receiver
            );
        else
            depositToGasZipERC20(
                _gasZipData.gasZipSwapData,
                _gasZipData.destinationChains,
                _bridgeData.receiver
            );

        emit LiFiTransferStarted(_bridgeData);
    }
}
