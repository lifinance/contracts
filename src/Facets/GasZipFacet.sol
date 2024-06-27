// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibSwap } from "../Libraries/LibSwap.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";
import { NativeAssetTransferFailed } from "lifi/Errors/GenericErrors.sol";

interface IGasZip {
    function deposit(
        uint256 destinationChain,
        address recipient
    ) external payable;
}

/// @title GasZipFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap ERC20 tokens to native and deposit them to the  gas.zip protocol (https://www.gas.zip/)
/// @custom:version 1.0.0
contract GasZipFacet {
    using SafeTransferLib for address;

    /// State ///
    IGasZip public immutable gasZipRouter;

    /// Constructor ///
    constructor(address _gasZipRouter) {
        gasZipRouter = IGasZip(_gasZipRouter);
    }

    /// @notice Swaps ERC20 tokens to native and deposits these native tokens in the GasZip router contract
    /// @param _swapData The swap data struct
    /// @param _destinationChainId the id of the chain where gas should be made available
    /// @param _recipient the address to receive the gas on dst chain
    function depositToGasZipERC20(
        LibSwap.SwapData calldata _swapData,
        uint256 _destinationChainId,
        address _recipient
    ) public {
        // pull tokens from caller (e.g. LI.FI diamond)
        _swapData.sendingAssetId.safeTransferFrom(
            msg.sender,
            address(this),
            _swapData.fromAmount
        );

        // execute the swapData that swaps the ERC20 token into native
        LibSwap.swap(0, _swapData);

        // call the gas zip router and deposit tokens
        gasZipRouter.deposit{ value: address(this).balance }(
            _destinationChainId,
            _recipient
        );
    }

    /// @notice Deposits native tokens in the GasZip router contract and returns any unused
    /// @param _amountToZip The swap data struct
    /// @param _destinationChainId the id of the chain where gas should be made available
    /// @param _recipient the address to receive the gas on dst chain
    function depositToGasZipNative(
        uint256 _amountToZip,
        uint256 _destinationChainId,
        address _recipient
    ) public payable {
        // call the gas zip router and deposit tokens
        gasZipRouter.deposit{ value: _amountToZip }(
            _destinationChainId,
            _recipient
        );

        // Send back any remaining native balance to the msg.sender (i.e. LI.FI diamond)
        uint256 nativeBalance = address(this).balance;
        if (nativeBalance > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = msg.sender.call{ value: nativeBalance }("");
            if (!success) revert NativeAssetTransferFailed();
        }
    }

    receive() external payable {}
}
