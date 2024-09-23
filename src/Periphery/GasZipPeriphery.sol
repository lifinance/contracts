// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGasZip } from "../Interfaces/IGasZip.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";

/// @title GasZipPeriphery
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap ERC20 tokens to use the gas.zip protocol as a pre-bridge step (https://www.gas.zip/)
/// @custom:version 1.0.0
contract GasZipPeriphery is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeTransferLib for address;

    event DepositedToGasZip(uint256 amount);

    /// State ///
    IGasZip public immutable gasZipRouter;
    address public immutable liFiDEXAggregator;

    /// Constructor ///
    constructor(address _gasZipRouter, address _liFiDEXAggregator) {
        gasZipRouter = IGasZip(_gasZipRouter);
        liFiDEXAggregator = _liFiDEXAggregator;
    }

    /// @notice Swaps ERC20 tokens to native and deposits these native tokens in the GasZip router contract
    ///         Swaps are only allowed via the LiFiDEXAggregator
    /// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
    /// @param _swapData The swap data that executes the swap from ERC20 to native
    /// @param _gasZipData contains information about which address should receive gas on which chains
    function depositToGasZipERC20(
        LibSwap.SwapData calldata _swapData,
        IGasZip.GasZipData calldata _gasZipData
    ) public {
        // deposit ERC20 asset from diamond
        LibAsset.depositAsset(_swapData.sendingAssetId, _swapData.fromAmount);

        // max approve to DEX, if not already done
        LibAsset.maxApproveERC20(
            IERC20(_swapData.sendingAssetId),
            liFiDEXAggregator,
            type(uint256).max
        );

        // execute swap using LiFiDEXAggregator
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = liFiDEXAggregator.call(
            _swapData.callData
        );
        if (!success) {
            LibUtil.revertWith(res);
        }
        // extract the swap output amount from the call return value
        uint256 swapOutputAmount = abi.decode(res, (uint256));

        // deposit native tokens to Gas.zip protocol
        GasZipPeriphery(payable(address(this))).depositToGasZipNative{
            value: swapOutputAmount
        }(_gasZipData);
    }

    /// @notice Deposits native tokens to the GasZip router contract
    /// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
    /// @param _gasZipData contains information about which address should receive gas on which chains
    function depositToGasZipNative(
        IGasZip.GasZipData calldata _gasZipData
    ) public payable {
        // deposit native to Gas.zip (v1) https://dev.gas.zip/gas/code-examples/contractDeposit
        gasZipRouter.deposit{ value: msg.value }(
            _gasZipData.destinationChains,
            _gasZipData.receiver
        );

        emit DepositedToGasZip(msg.value);
    }

    /// @dev Returns a value that signals to Gas.zip to which chains gas should be sent in equal parts
    /// @param _chainIds a list of Gas.zip-specific chainIds (not the original chainIds), see https://dev.gas.zip/gas/chain-support/outbound
    function getDestinationChainsValue(
        uint8[] memory _chainIds
    ) public pure returns (uint256 destinationChains) {
        for (uint256 i = 0; i < _chainIds.length; i++) {
            // Shift destinationChains left by 8 bits and add the next chainID
            destinationChains =
                (destinationChains << 8) |
                uint256(_chainIds[i]);
        }
    }

    // Required to receive ETH from ERC20-to-Native swaps
    receive() external payable {}
}
