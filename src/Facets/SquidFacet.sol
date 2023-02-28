// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISquidRouter } from "../Interfaces/ISquidRouter.sol";
import { ISquidMulticall } from "../Interfaces/ISquidMulticall.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Squid Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Squid Router
contract SquidFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    struct SquidData {
        string destinationChain;
        string bridgedTokenSymbol;
        /* ISquidMulticall.Call[] calls; */
        address refundRecipient;
        bool forecallEnabled;
    }

    /// State ///
    ISquidRouter public immutable squidRouter;

    /// Constructor ///
    constructor(ISquidRouter _squidRouter) {
        squidRouter = _squidRouter;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _squidData data specific to Squid Router
    function startBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        SquidData memory _squidData
    ) external payable {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _squidData);
    }

    /// @notice Swaps and bridges tokens via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _squidData data specific to Squid Router
    function swapAndStartBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        SquidData memory _squidData
    ) external payable {
        // TODO: implement swap and bridge logic
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _squidData data specific to Squid Router
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SquidData memory _squidData
    ) internal {
        // TODO: implement internal bridge logic
        IERC20 sendingAssetId = IERC20(_bridgeData.sendingAssetId);
        LibAsset.maxApproveERC20(
            sendingAssetId,
            address(squidRouter),
            _bridgeData.minAmount
        );

        // Initiate bridge tansfer
        squidRouter.bridgeCall{
            value: LibAsset.isNativeAsset(address(sendingAssetId))
                ? _bridgeData.minAmount
                : 0
        }(
            _squidData.destinationChain,
            _squidData.bridgedTokenSymbol,
            _bridgeData.minAmount,
            new ISquidMulticall.Call[](0),
            _squidData.refundRecipient,
            _squidData.forecallEnabled
        );
    }
}
