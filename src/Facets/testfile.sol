// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISynapseRouter } from "../Interfaces/ISynapseRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title SynapseBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through SynapseBridge
/// contract_version: 1.0.0
contract SynapseBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {}
