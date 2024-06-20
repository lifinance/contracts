// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { AcrossFacetPacked } from "lifi/Facets/AcrossFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".AcrossFacetPacked");

        // load config
        path = string.concat(root, "/config/across.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokensToApprove")
        );
        address[] memory tokensToApprove = abi.decode(rawConfig, (address[]));

        vm.startBroadcast(deployerPrivateKey);

        AcrossFacetPacked(payable(facet)).setApprovalForBridge(
            tokensToApprove
        );

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
