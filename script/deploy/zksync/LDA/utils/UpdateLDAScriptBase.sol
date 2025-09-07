// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { stdJson } from "forge-std/StdJson.sol";
import { BaseUpdateScript } from "../../utils/BaseUpdateScript.sol";

contract UpdateLDAScriptBase is BaseUpdateScript {
    using stdJson for string;

    function _getDiamondAddress() internal override returns (address) {
        return json.readAddress(".LiFiDEXAggregatorDiamond");
    }
}
