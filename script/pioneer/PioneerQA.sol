// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { PioneerFacet } from "lifi/Facets/PioneerFacet.sol";
import { ILiFi } from "../../src/Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../../src/Libraries/LibAsset.sol";

contract PioneerQA is Script {
    error DiamondNotContract();

    struct Params {
        bytes32 transactionId;
        address sendingAssetId;
        address receiver;
        uint256 minAmount;
        uint256 destinationChainId;
    }

    function run(
        address diamond,
        address payable refundAddress,
        Params[] calldata params
    ) public {
        if (!LibAsset.isContract(diamond)) revert DiamondNotContract();

        vm.startBroadcast();

        uint256 numParams = params.length;
        for (uint256 i; i < numParams; ++i) {
            Params calldata param = params[i];
            ILiFi.BridgeData memory _bridgeData = ILiFi.BridgeData({
                transactionId: param.transactionId,
                bridge: "Pioneer",
                integrator: "ACME Devs",
                referrer: address(0),
                sendingAssetId: param.sendingAssetId,
                receiver: param.receiver,
                minAmount: param.minAmount,
                destinationChainId: param.destinationChainId,
                hasSourceSwaps: false,
                hasDestinationCall: false
            });
            PioneerFacet.PioneerData memory _pioneerData = PioneerFacet
                .PioneerData(refundAddress);

            if (LibAsset.isNativeAsset(param.sendingAssetId)) {
                PioneerFacet(diamond).startBridgeTokensViaPioneer{
                    value: param.minAmount
                }(_bridgeData, _pioneerData);
            } else {
                // Set allowance
                LibAsset.approveERC20(
                    IERC20(param.sendingAssetId),
                    diamond,
                    param.minAmount,
                    param.minAmount
                );

                PioneerFacet(diamond).startBridgeTokensViaPioneer(
                    _bridgeData,
                    _pioneerData
                );
            }
        }

        vm.stopBroadcast();
    }
}
