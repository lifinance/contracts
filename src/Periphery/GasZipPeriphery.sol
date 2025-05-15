// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGasZip } from "../Interfaces/IGasZip.sol";
import { IDexManagerFacet } from "../Interfaces/IDexManagerFacet.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { InvalidCallData, ContractCallNotAllowed, InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title GasZipPeriphery
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap ERC20 tokens to use the gas.zip protocol as a pre-bridge step (https://www.gas.zip/)
/// @custom:version 1.0.2
contract GasZipPeriphery is ILiFi, WithdrawablePeriphery {
    using SafeTransferLib for address;

    /// State ///
    IGasZip public immutable GAS_ZIP_ROUTER;
    address public immutable LIFI_DIAMOND;
    uint256 internal constant MAX_CHAINID_LENGTH_ALLOWED = 16;

    /// Errors ///
    error TooManyChainIds();
    error SwapOutputMustBeNative();

    /// Constructor ///
    constructor(
        address _gasZipRouter,
        address _liFiDiamond,
        address _owner
    ) WithdrawablePeriphery(_owner) {
        if (
            _gasZipRouter == address(0) ||
            _liFiDiamond == address(0) ||
            _owner == address(0)
        ) {
            revert InvalidConfig();
        }
        GAS_ZIP_ROUTER = IGasZip(_gasZipRouter);
        LIFI_DIAMOND = _liFiDiamond;
    }

    /// @notice Swaps ERC20 tokens to native and deposits these native tokens in the GasZip router contract
    ///         Swaps are allowed via any whitelisted DEX from the Diamond's DexManagerFacet
    /// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
    /// @param _swapData The swap data that executes the swap from ERC20 to native
    /// @param _gasZipData contains information about which chains gas should be sent to
    function depositToGasZipERC20(
        LibSwap.SwapData calldata _swapData,
        IGasZip.GasZipData calldata _gasZipData
    ) public {
        if (_swapData.receivingAssetId != address(0)) {
            revert SwapOutputMustBeNative();
        }

        IDexManagerFacet dexManager = IDexManagerFacet(LIFI_DIAMOND);

        if (
            !dexManager.isDexApproved(_swapData.callTo) ||
            !dexManager.isFunctionApproved(bytes4(_swapData.callData[:4]))
        ) {
            revert ContractCallNotAllowed();
        }

        // deposit ERC20 asset from diamond
        LibAsset.depositAsset(_swapData.sendingAssetId, _swapData.fromAmount);

        // max approve to DEX, if not already done
        LibAsset.maxApproveERC20(
            IERC20(_swapData.sendingAssetId),
            _swapData.callTo,
            _swapData.fromAmount
        );

        // execute swap using the whitelisted DEX
        // Note on slippage protection:
        // 1. Individual swap slippage is protected via minAmountOut parameter in _swapData.callData
        // 2. Final output amount slippage is checked at diamond contract level in SwapperV2._depositAndSwap()
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call(
            _swapData.callData
        );
        if (!success) {
            LibUtil.revertWith(res);
        }

        // get the output amount from the contract's balance (which will be sent in full to gasZip router)
        uint256 swapOutputAmount = address(this).balance;

        // deposit native tokens to Gas.zip protocol
        depositToGasZipNative(_gasZipData, swapOutputAmount);
    }

    /// @notice Deposits native tokens to the GasZip router contract
    /// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
    /// @param _gasZipData contains information which chains and address gas should be sent to
    /// @param _amount the total amount to be deposited (will be split equally across all chains)
    function depositToGasZipNative(
        IGasZip.GasZipData calldata _gasZipData,
        uint256 _amount
    ) public payable {
        // make sure that receiverAddress is not 0
        if (_gasZipData.receiverAddress == bytes32(0))
            revert InvalidCallData();

        // We are depositing to a new contract that supports deposits for EVM chains + Solana (therefore 'receiver' address is bytes32)
        GAS_ZIP_ROUTER.deposit{ value: _amount }(
            _gasZipData.destinationChains,
            _gasZipData.receiverAddress
        );

        // return unused native value to msg.sender, if any
        // this is required due to LI.FI backend-internal requirements (money flow)
        uint256 remainingNativeBalance = address(this).balance;
        if (remainingNativeBalance > 0) {
            msg.sender.safeTransferETH(remainingNativeBalance);
        }
    }

    /// @dev Returns a value that signals to Gas.zip to which chains gas should be sent in equal parts
    /// @param _chainIds a list of Gas.zip-specific chainIds (not the original chainIds), see https://dev.gas.zip/gas/chain-support/outbound
    function getDestinationChainsValue(
        uint8[] calldata _chainIds
    ) external pure returns (uint256 destinationChains) {
        uint256 length = _chainIds.length;

        if (length > MAX_CHAINID_LENGTH_ALLOWED) revert TooManyChainIds();

        for (uint256 i; i < length; ++i) {
            // Shift destinationChains left by 16 bits and add the next chainID
            destinationChains =
                (destinationChains << 16) |
                uint256(_chainIds[i]);
        }
    }

    // Required to receive ETH from ERC20-to-Native swaps
    receive() external payable {}
}
