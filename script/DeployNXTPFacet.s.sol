// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { NXTPFacet } from "lifi/Facets/NXTPFacet.sol";

contract DeployScript is Script {
    using stdJson for string;

    function run() public returns (NXTPFacet deployed) {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("SALT");
        string memory network = vm.envString("NETWORK");
        bytes32 salt = keccak256(abi.encodePacked(saltPrefix, "NXTPFacet"));

        string memory path = string.concat(vm.projectRoot(), "/config/nxtp.json");
        string memory json = vm.readFile(path);
        address txMgrAddress = json.readAddress(string.concat(".", network, ".txManagerAddress"));

        console.log(txMgrAddress);

        vm.startBroadcast(deployerPrivateKey);

        CREATE3Factory factory = CREATE3Factory(factoryAddress);

        address predicted = factory.getDeployed(vm.addr(deployerPrivateKey), salt);
        console.log(predicted);
        if (isContract(predicted)) {
            deployed = NXTPFacet(predicted);
        } else {
            deployed = NXTPFacet(
                factory.deploy(salt, bytes.concat(type(NXTPFacet).creationCode, abi.encode(txMgrAddress)))
            );
        }

        vm.stopBroadcast();
    }

    /// @dev Checks whether the given address is a contract and contains code
    function isContract(address _contractAddr) internal view returns (bool) {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(_contractAddr)
        }
        return size > 0;
    }
}
