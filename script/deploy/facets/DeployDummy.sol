// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;

import "forge-std/Script.sol";

contract Dummy {
    string public hello;

    constructor(string memory _hello) {
        hello = _hello;
    }

    function getHello() external view returns (string memory) {
        return hello;
    }
}

contract DeployScript is Script {
    function run() external returns (Dummy) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        Dummy dummy = new Dummy("Hi there!");

        vm.stopBroadcast();

        return dummy;
    }
}
