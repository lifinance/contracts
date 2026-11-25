// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    UpdateScriptBase
} from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AcrossFacetPackedV4 } from "lifi/Facets/AcrossFacetPackedV4.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".AcrossFacetPackedV4");

        address[] memory tokensToApprove = _readTokensToApprove();

        vm.startBroadcast(deployerPrivateKey);

        AcrossFacetPackedV4(payable(facet))
            .setApprovalForBridge(tokensToApprove);

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }

    function _readTokensToApprove() internal returns (address[] memory) {
        path = string.concat(root, "/config/across.json");
        json = vm.readFile(path);

        return json.readAddressArray(
            string.concat(".", network, ".tokensToApprove")
        );
    }
}
