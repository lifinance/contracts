// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LiFiDiamond } from "../../LiFiDiamond.sol";
    
/// @title LiFiDEXAggregatorDiamond
/// @author LI.FI (https://li.fi)
/// @notice Base EIP-2535 Diamond Proxy Contract for LDA (LiFi DEX Aggregator).
/// @custom:version 1.0.0
contract LiFiDEXAggregatorDiamond is LiFiDiamond {
    constructor(
        address _contractOwner,
        address _diamondCutFacet
    ) LiFiDiamond(_contractOwner, _diamondCutFacet) {}
}
