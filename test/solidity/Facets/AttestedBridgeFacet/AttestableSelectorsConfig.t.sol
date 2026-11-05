// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

/// @notice Holds `config/global.json` → `attestableSelectors` against the build: every listed
///         selector must still be a function of the facet it names, under the listed signature.
///         A facet change that alters an enabled entrypoint's signature fails here, in the PR
///         that makes it, until the config (and the on-chain selector set) is updated.
contract AttestableSelectorsConfigTest is Test {
    string internal constant SELECTORS_PATH = ".attestableSelectors.selectors";

    function test_EverySelectorIsAFunctionOfItsFacet() public {
        string memory config = vm.readFile("config/global.json");
        string[] memory selectors = vm.parseJsonKeys(config, SELECTORS_PATH);
        assertGt(selectors.length, 0, "attestableSelectors lists nothing");

        for (uint256 i; i < selectors.length; ++i) {
            string memory entry = vm.parseJsonString(
                config,
                string.concat(SELECTORS_PATH, ".", selectors[i])
            );
            (string memory facet, string memory signature) = _split(entry);
            string memory artifactPath = string.concat(
                "out/",
                facet,
                ".sol/",
                facet,
                ".json"
            );
            // `forge coverage` does not write `out/`; the plain test run always does.
            if (!vm.isFile(artifactPath)) vm.skip(true);

            string memory artifact = vm.readFile(artifactPath);
            string memory key = string.concat(
                ".methodIdentifiers['",
                signature,
                "']"
            );
            assertTrue(
                vm.keyExistsJson(artifact, key),
                string.concat(entry, " is not a function of ", facet)
            );
            assertEq(
                string.concat("0x", vm.parseJsonString(artifact, key)),
                selectors[i],
                entry
            );
        }
    }

    function _split(
        string memory _entry
    ) internal pure returns (string memory facet, string memory signature) {
        bytes memory raw = bytes(_entry);
        for (uint256 i; i < raw.length; ++i) {
            if (raw[i] != ".") continue;
            facet = _slice(raw, 0, i);
            signature = _slice(raw, i + 1, raw.length);
            return (facet, signature);
        }
        revert(string.concat("no facet in ", _entry));
    }

    function _slice(
        bytes memory _raw,
        uint256 _start,
        uint256 _end
    ) internal pure returns (string memory) {
        bytes memory out = new bytes(_end - _start);
        for (uint256 i; i < out.length; ++i) {
            out[i] = _raw[_start + i];
        }
        return string(out);
    }
}
