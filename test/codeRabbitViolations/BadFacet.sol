// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {LiFiDiamond} from "../src/LiFiDiamond.sol";
import {ILiFi} from "../src/Interfaces/ILiFi.sol";
import {LibAsset} from "../src/Libraries/LibAsset.sol";

/// @title BadFacet
/// @author LI.FI (https://li.fi)
/// @notice Example facet with incorrect import paths (using relative paths instead of remappings)
/// @custom:version 1.0.0
contract BadFacet is ILiFi {
    function someFunction() external pure returns (bool) {
        return true;
    }
}
