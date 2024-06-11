// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public {
        path = string.concat(root, "/config/multichain.json");
        json = vm.readFile(path);
        address[] memory routers = json.readAddressArray(
            string.concat(".", network, ".routers")
        );
        bool[] memory allowed = new bool[](routers.length);
        for (uint i = 0; i < routers.length; i++) {
            allowed[i] = true;
        }

        // get anyTokenMappings from config and parse into array
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );

        // parse raw data from config into anyMappings array
        MultichainFacet.AnyMapping[] memory addressMappings = abi.decode(
            rawConfig,
            (MultichainFacet.AnyMapping[])
        );

        // execute updates
        vm.startBroadcast(deployerPrivateKey);
        MultichainFacet(diamond).updateAddressMappings(addressMappings);
        MultichainFacet(diamond).registerRouters(routers, allowed);

        vm.stopBroadcast();
    }
}
