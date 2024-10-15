// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".CBridgeFacetPacked");

        // The CBridgeFacetPacked owner is the refund wallet because we need access to trigger refunds
        // As there is only one owner, that address also needs to execute the approvals.
        uint256 refundPrivateKey = uint256(
            vm.envOr("PRIVATE_KEY_REFUND_WALLET", bytes32(0))
        );
        require(
            refundPrivateKey != 0,
            "Refund wallet private key not set or invalid"
        );
        console.log(
            "Refund wallet address used in script:",
            vm.addr(refundPrivateKey)
        );

        // load config
        path = string.concat(root, "/config/cbridge.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokensToApprove")
        );
        address[] memory tokensToApprove = abi.decode(rawConfig, (address[]));

        vm.startBroadcast(refundPrivateKey);

        CBridgeFacetPacked(payable(facet)).setApprovalForBridge(
            tokensToApprove
        );

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
