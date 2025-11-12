// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {Script, console2} from "forge-std/Script.sol";
import {LiFiDiamond} from "lifi/LiFiDiamond.sol";
import {DiamondCutFacet} from "lifi/Facets/DiamondCutFacet.sol";
import {PolymerCCTPFacet} from "lifi/Facets/PolymerCCTPFacet.sol";
import {DeployScriptBase} from "./utils/DeployScriptBase.sol";
import {LibDiamond} from "lifi/Libraries/LibDiamond.sol";

contract DeployDiamondWithPolymerCCTPFacet is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Read PolymerCCTPFacet constructor arguments from environment
        address tokenMessenger = vm.envAddress("TOKEN_MESSENGER");
        address usdc = vm.envAddress("USDC");
        address polymerFeeRecipient = vm.envAddress("POLYMER_FEE_RECIPIENT");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy DiamondCutFacet
        console2.log("Deploying DiamondCutFacet...");
        DiamondCutFacet diamondCutFacet = new DiamondCutFacet();
        console2.log("DiamondCutFacet deployed at:", address(diamondCutFacet));

        // Deploy LiFiDiamond
        console2.log("Deploying LiFiDiamond...");
        LiFiDiamond diamond = new LiFiDiamond(vm.addr(deployerPrivateKey), address(diamondCutFacet));
        console2.log("LiFiDiamond deployed at:", address(diamond));

        // Deploy PolymerCCTPFacet
        console2.log("Deploying PolymerCCTPFacet...");
        PolymerCCTPFacet polymerCCTPFacet = new PolymerCCTPFacet(tokenMessenger, usdc, polymerFeeRecipient);
        console2.log("PolymerCCTPFacet deployed at:", address(polymerCCTPFacet));

        // Add PolymerCCTPFacet to diamond
        console2.log("Adding PolymerCCTPFacet to diamond...");
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = PolymerCCTPFacet.startBridgeTokensViaPolymerCCTP.selector;
        selectors[1] = PolymerCCTPFacet.initPolymerCCTP.selector;

        LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](1);
        cuts[0] = LibDiamond.FacetCut({
            facetAddress: address(polymerCCTPFacet),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: selectors
        });

        DiamondCutFacet(address(diamond)).diamondCut(cuts, address(0), "");
        console2.log("PolymerCCTPFacet successfully added to diamond");

        vm.stopBroadcast();
    }
}
