// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import "forge-std/Script.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";
import { MockTokenBridge } from "./MockTokenBridge.sol";
import { CentrifugeBridgeCaller } from "./CentrifugeBridgeCaller.sol";

/// @notice Deploy MockTokenBridge + CentrifugeBridgeCaller and run an end-to-end bridge call
///         using JTRSY (Centrifuge share token, 6 decimals).
///
///         NOTE: Centrifuge share tokens have transfer restrictions — the receiver must be
///         "endorsed" by Root. On fork we mock this check. On real mainnet, your caller
///         contract must be endorsed by Centrifuge governance.
///
/// Usage (fork dry-run):
///   forge script test-centrifuge/TestCentrifuge.s.sol \
///     --fork-url https://ethereum-rpc.publicnode.com -vvvv
///
/// Usage (real mainnet — you must hold JTRSY and be endorsed):
///   forge script test-centrifuge/TestCentrifuge.s.sol \
///     --rpc-url <RPC_URL> --broadcast --private-key <KEY>
contract TestCentrifuge is Script {
    // Centrifuge share token on Ethereum mainnet (6 decimals)
    address constant JTRSY = 0x8c213ee79581Ff4984583C6a801e5263418C4b86;
    // Known JTRSY holder for fork impersonation
    address constant JTRSY_HOLDER = 0x491EDFB0B8b608044e227225C715981a30F3A44E;
    // Centrifuge Root contract (checks endorsed status)
    address constant ROOT = 0x7Ed48C31f2fdC40d37407cBaBf0870B2b688368f;
    uint256 constant AMOUNT = 1e6; // 1 JTRSY (6 decimals)

    function run() external {
        address deployer = msg.sender;

        // Pick sender: if deployer has no JTRSY, impersonate a known holder (fork only)
        address sender = IERC20(JTRSY).balanceOf(deployer) >= AMOUNT
            ? deployer
            : JTRSY_HOLDER;

        console.log("=== Centrifuge Bridge E2E Test ===");
        console.log("Sender:", sender);
        console.log("Token: JTRSY", JTRSY);
        console.log("JTRSY balance:", IERC20(JTRSY).balanceOf(sender));

        vm.startBroadcast(sender);

        // 1. Deploy mock bridge
        MockTokenBridge mockBridge = new MockTokenBridge();
        console.log("MockTokenBridge deployed:", address(mockBridge));

        // 2. Deploy caller
        CentrifugeBridgeCaller caller = new CentrifugeBridgeCaller(
            address(mockBridge)
        );
        console.log("CentrifugeBridgeCaller deployed:", address(caller));

        vm.stopBroadcast();

        // 3. Mock Root.endorsed() to return true for our contracts (fork only)
        //    On real mainnet, Centrifuge governance must endorse these contracts.
        console.log("Mocking Root.endorsed() for caller and bridge...");
        vm.mockCall(
            ROOT,
            abi.encodeWithSignature("endorsed(address)", address(caller)),
            abi.encode(uint256(1))
        );
        vm.mockCall(
            ROOT,
            abi.encodeWithSignature("endorsed(address)", address(mockBridge)),
            abi.encode(uint256(1))
        );

        vm.startBroadcast(sender);

        // 4. Approve caller to pull JTRSY
        IERC20(JTRSY).approve(address(caller), AMOUNT);

        // 5. Bridge JTRSY to Base
        bytes32 receiver = bytes32(uint256(uint160(sender)));
        caller.bridge(JTRSY, AMOUNT, receiver, 8453);

        vm.stopBroadcast();

        // 6. Verify tokens landed in the mock bridge
        uint256 bridgeBalance = IERC20(JTRSY).balanceOf(address(mockBridge));
        console.log("Mock bridge JTRSY balance:", bridgeBalance);
        require(bridgeBalance == AMOUNT, "Bridge did not receive JTRSY");

        console.log("=== SUCCESS: 1 JTRSY bridged to mock ===");
    }
}
