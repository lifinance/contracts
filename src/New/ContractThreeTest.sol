// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title ContractThreeTest
/// @custom:version 1.0.0
contract ContractThreeTest is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    function swap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData calldata _swapData
    ) external payable nonReentrant validateBridgeData(_bridgeData) {
        LibSwap.swap(0, _swapData);

        emit LiFiTransferStarted(_bridgeData);
    }

    function deposit(address token, uint256 amount) external {
        LibAsset.depositAsset(token, amount);
    }
}
