// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { CannotBridgeToSameNetwork, NativeValueWithERC, InvalidReceiver, InvalidAmount, InvalidConfig, InvalidSendingToken, AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Hop Facet (Optimized)
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacetoptimized is ILiFi, SwapperV2 {
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
    /// @param toekenToApprove The token to approve
    function setApprovalForBridges(address[] calldata bridges, address tokenToApprove) external {
        for (uint256 i; i < bridges.length; i++) {
            // Give Hop approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(tokenToApprove), address(bridge), type(uint256).max);
        }
    }

    // TODO: startBridgeTokensViaHopL1ERC20

    // TODO: startBridgeTokensViaHopL1Native

    // TODO: swapAndStartBridgeTokensViaHopL1ERC20

    // TODO: swapAndStartBridgeTokensViaHopL1Native

    // TODO: startBridgeTokensViaHopL2ERC20

    // TODO: startBridgeTokensViaHopL2Native

    // TODO: swapAndStartBridgeTokensViaHopL2ERC20

    // TODO: swapAndStartBridgeTokensViaHopL2Native
}
