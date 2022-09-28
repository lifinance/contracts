// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { CannotAuthoriseSelf, UnAuthorized } from "../Errors/GenericErrors.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";

/// @title Mappings Library
/// @author LI.FI (https://li.fi)
/// @notice Provides mappings for all facets that may need them
library LibMappings {
    /// Types ///
    bytes32 internal constant STARGATE_NAMESPACE = keccak256("com.lifi.library.mappings.stargate");
    bytes32 internal constant WORMHOLE_NAMESPACE = keccak256("com.lifi.library.mappings.wormhole");

    /// Storage ///
    struct StargateMappings {
        mapping(address => uint16) stargatePoolId;
        mapping(uint256 => uint16) layerZeroChainId;
    }

    struct WormholeMappings {
        mapping(uint256 => uint16) wormholeChainId;
    }

    /// @dev Fetch local storage for Stargate
    function getStargateMappings() internal pure returns (StargateMappings storage ms) {
        bytes32 position = STARGATE_NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ms.slot := position
        }
    }

    /// @dev Fetch local storage for Wormhole
    function getWormholeMappings() internal pure returns (WormholeMappings storage ms) {
        bytes32 position = WORMHOLE_NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ms.slot := position
        }
    }
}
