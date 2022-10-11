// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";

contract DeployScript is Script {
    using stdJson for string;

    IDiamondCut.FacetCut[] internal cut;

    function run() public {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        string memory network = vm.envString("NETWORK");

        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/deployments/", network, ".json");
        string memory json = vm.readFile(path);
        address diamond = json.readAddress(".LiFiDiamond");
        address withdraw = json.readAddress(".WithdrawFacet");

        vm.startBroadcast(deployerPrivateKey);

        DiamondCutFacet cutter = DiamondCutFacet(diamond);

        bytes4[] memory functionSelectors;

        // Withdraw Facet

        functionSelectors = new bytes4[](2);
        functionSelectors[0] = WithdrawFacet.executeCallAndWithdraw.selector;
        functionSelectors[1] = WithdrawFacet.withdraw.selector;
        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: withdraw,
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        cutter.diamondCut(cut, address(0), "");

        vm.stopBroadcast();
    }
}
