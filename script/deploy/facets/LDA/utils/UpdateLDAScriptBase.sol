// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { stdJson } from "forge-std/StdJson.sol";
import { UpdateScriptBase } from "../../utils/UpdateScriptBase.sol";

contract UpdateLDAScriptBase is UpdateScriptBase {
    using stdJson for string;

    function _getDiamondAddress() internal override returns (address) {
        return json.readAddress(".LiFiDEXAggregatorDiamond");
    }

    function _shouldUseDefaultDiamond() internal pure override returns (bool) {
        return false; // LDA doesn't use the USE_DEF_DIAMOND env var
    }
}
