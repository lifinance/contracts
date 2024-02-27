// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (bool) {
        address permit2Proxy = json.readAddress(".Permit2Proxy");

        address[] memory addresses;
        bool[] memory values;

        // use address of currently selected diamond (either mutable or immutable)
        addresses = new address[](1);
        addresses[0] = diamond;
        // --- activate this code if you want to whitelist both mutable and immutable diamonds ---
        // addresses = new address[](2);
        // address diamondImmutable = json.readAddress(".LiFiDiamondImmutable")
        // address diamondMutable = json.readAddress(".LiFiDiamondv")
        // addresses[0] = diamondMutable;
        // addresses[1] = diamondImmutable;
        // ---------------------------------------------------------------------------------------

        // true = add to whitelist
        values = new bool[](addresses.length);
        for (uint i; i < addresses.length; i++) {
            values[i] = true;
        }

        // call periphery contract to add diamond(s) to whitelist
        vm.startBroadcast(deployerPrivateKey);

        Permit2Proxy(permit2Proxy).updateWhitelist(addresses, values);

        vm.stopBroadcast();

        return true;
    }
}
