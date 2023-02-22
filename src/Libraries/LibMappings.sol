// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { CannotAuthoriseSelf, UnAuthorized } from "../Errors/GenericErrors.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";

/// @title Mappings Library
/// @author LI.FI (https://li.fi)
/// @notice Provides mappings for all facets that may need them
library LibMappings {
    /// Types ///
    bytes32 internal constant STARGATE_NAMESPACE =
        keccak256("com.lifi.library.mappings.stargate");
    bytes32 internal constant WORMHOLE_NAMESPACE =
        keccak256("com.lifi.library.mappings.wormhole");
    bytes32 internal constant AMAROK_NAMESPACE =
        keccak256("com.lifi.library.mappings.amarok");
    bytes32 internal constant PERIPHERY_REGISTRY_NAMESPACE =
        keccak256("com.lifi.facets.periphery_registry");

    /// Storage ///
    struct StargateMappings {
        mapping(address => uint16) stargatePoolId;
        mapping(uint256 => uint16) layerZeroChainId;
        bool initialized;
    }

    struct WormholeMappings {
        mapping(uint256 => uint16) wormholeChainId;
        bool initialized;
    }

    struct AmarokMappings {
        mapping(uint256 => uint32) amarokDomain;
    }

    struct PeripheryRegistryMappings {
        mapping(string => address) contracts;
    }

    /// @dev Fetch local storage for Stargate
    function getStargateMappings()
        internal
        pure
        returns (StargateMappings storage ms)
    {
        bytes32 position = STARGATE_NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ms.slot := position
        }
    }

    /// @dev Fetch local storage for Wormhole
    function getWormholeMappings()
        internal
        pure
        returns (WormholeMappings storage ms)
    {
        bytes32 position = WORMHOLE_NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ms.slot := position
        }
    }

    /// @dev Fetch local storage for Amarok
    function getAmarokMappings()
        internal
        pure
        returns (AmarokMappings storage ms)
    {
        bytes32 position = AMAROK_NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ms.slot := position
        }
    }

    /// @dev Fetch local storage for Periphery Registry
    function getPeripheryRegistryMappings()
        internal
        pure
        returns (PeripheryRegistryMappings storage ms)
    {
        bytes32 position = PERIPHERY_REGISTRY_NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ms.slot := position
        }
    }
}
