// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {Script, console2} from "forge-std/Script.sol";
import {LiFiDiamond} from "lifi/LiFiDiamond.sol";
import {PolymerCCTPFacet, PolymerCCTPData} from "lifi/Facets/PolymerCCTPFacet.sol";
import {ILiFi} from "lifi/Interfaces/ILiFi.sol";
import {LibSwap} from "lifi/Libraries/LibSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CallPolymerCCTPFacet is Script {
    function run() external payable {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address diamondAddress = vm.envAddress("DIAMOND_ADDRESS");
        uint32 destinationChainId = uint32(vm.envUint("DESTINATION_CHAIN_ID"));
        address receiver = vm.addr(deployerPrivateKey);
        uint256 amount = uint256(1000);
        uint256 polymerTokenFee = uint256(10);
        uint32 maxCCTPFee = uint32(vm.envOr("MAX_CCTP_FEE", uint256(100)));
        uint32 minFinalityThreshold = uint32(vm.envOr("MIN_FINALITY_THRESHOLD", uint256(0)));

        console2.log("Diamond Proxy address:", diamondAddress);
        // Cast diamond to PolymerCCTPFacet to call its functions
        PolymerCCTPFacet polymerFacet = PolymerCCTPFacet(diamondAddress);
        address usdcAddress = vm.envAddress("USDC");

        // Get USDC address from the PolymerCCTPFacet
        console2.log("USDC address:", usdcAddress);

        vm.startBroadcast(deployerPrivateKey);

        // Approve USDC spending
        IERC20(usdcAddress).approve(diamondAddress, amount + polymerTokenFee);

        // Prepare bridge data
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(uint256(1)), // Simple transaction ID
            bridge: "PolymerCCTP",
            integrator: "LiFi",
            referrer: address(0),
            sendingAssetId: usdcAddress,
            receiver: receiver,
            minAmount: amount,
            destinationChainId: destinationChainId, // Using domain as chain ID to avoid SLOAD to read from a mapping - this seems like it can just directly be passed via calldata.
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        // Prepare Polymer-specific data
        PolymerCCTPData memory polymerData = PolymerCCTPData({
            polymerTokenFee: polymerTokenFee,
            maxCCTPFee: maxCCTPFee,
            minFinalityThreshold: minFinalityThreshold,
            nonEvmAddress: bytes32(0)
        });

        console2.log("Calling startBridgeTokensViaPolymerCCTP...");
        console2.log("Amount:", amount);
        console2.log("Destination Domain:", destinationChainId);
        console2.log("Receiver:", receiver);

        // Call the bridge function
        polymerFacet.startBridgeTokensViaPolymerCCTP(bridgeData, polymerData);

        console2.log("Bridge transaction initiated successfully");

        vm.stopBroadcast();
    }
}
