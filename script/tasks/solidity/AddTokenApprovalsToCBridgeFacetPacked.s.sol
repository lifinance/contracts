// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    address[] internal tokensToApprove;

    error RefundWalletPrivateKeyNotSet();

    function run() public returns (address[] memory facets) {
        address facet = _getConfigContractAddress(
            path,
            string.concat(".", network, ".CBridgeFacetPacked")
        );

        // The CBridgeFacetPacked owner is the refund wallet because we need access to trigger refunds
        // As there is only one owner, that address also needs to execute the approvals.
        uint256 refundPrivateKey = uint256(
            vm.envOr("PRIVATE_KEY_REFUND_WALLET", bytes32(0))
        );
        if (refundPrivateKey == 0) {
            revert RefundWalletPrivateKeyNotSet();
        }

        // load config
        path = string.concat(root, "/config/cbridge.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokensToApprove")
        );
        address[] memory tokens = abi.decode(rawConfig, (address[]));

        address cBridge = _getConfigContractAddress(
            path,
            string.concat(".", network, ".cBridge")
        );

        // Filter out any already approved tokens
        for (uint256 i = 0; i < tokens.length; i++) {
            if (ERC20(tokens[i]).allowance(facet, cBridge) == 0) {
                tokensToApprove.push(tokens[i]);
            }
        }

        if (tokensToApprove.length == 0) {
            return loupe.facetAddresses();
        }

        vm.startBroadcast(refundPrivateKey);

        CBridgeFacetPacked(payable(facet)).setApprovalForBridge(
            tokensToApprove
        );

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
