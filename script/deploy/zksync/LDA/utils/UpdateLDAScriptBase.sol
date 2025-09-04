// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { stdJson } from "forge-std/StdJson.sol";
import { BaseZkSyncUpdateScript } from "../../utils/BaseZkSyncUpdateScript.sol";

contract UpdateLDAScriptBase is BaseZkSyncUpdateScript {
    using stdJson for string;

    function _buildDeploymentPath()
        internal
        view
        override
        returns (string memory)
    {
        return
            string.concat(
                root,
                "/deployments/",
                network,
                ".",
                fileSuffix,
                "json"
            );
    }

    function _getDiamondAddress() internal override returns (address) {
        return json.readAddress(".LiFiDEXAggregatorDiamond");
    }
}
