// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import {
    DeployScript as UpdateAllBridgeFacetScript
} from "../../../script/deploy/facets/UpdateAllBridgeFacet.s.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdateAllBridgeFacetHarness is UpdateAllBridgeFacetScript {
    function exposedGetCallData() public returns (bytes memory) {
        return getCallData();
    }

    function exposedParseChainIdConfigs(string memory _json)
        public
        view
        returns (AllBridgeFacet.ChainIdConfig[] memory)
    {
        return _parseChainIdConfigs(_json);
    }

    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options.noBroadcast = true;
        options.selectorArtifactsDir = "./out";
    }

    function _readDeploymentsJson() internal override returns (string memory) {
        return vm.serializeAddress(
            "deployments",
            "LiFiDiamond",
            0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
        );
    }
}

contract UpdateAllBridgeFacetTest is Test {
    error ChainIdNotInInitCallData(uint256 chainId);

    uint256 internal constant MAINNET_CHAIN_ID = 1;

    UpdateAllBridgeFacetHarness internal script;

    function setUp() public {
        vm.chainId(MAINNET_CHAIN_ID);

        vm.setEnv("NETWORK", "mainnet");
        vm.setEnv("FILE_SUFFIX", "");
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(uint256(1))));
        vm.setEnv("USE_DEF_DIAMOND", "true");

        script = new UpdateAllBridgeFacetHarness();
    }

    /// @dev Expected rows are literals, not read from the file, so a fault in the
    ///      script's own read technique cannot show up on both sides of the assert.
    ///      Adding a chain to config/allbridge.json means adding its row here.
    function test_DecodesEveryConfigRowByFieldName() public {
        uint256[2][15] memory expected = [
            [uint256(1), 1],
            [uint256(56), 2],
            [uint256(1885080386571452), 3],
            [uint256(1151111081099710), 4],
            [uint256(137), 5],
            [uint256(42161), 6],
            [uint256(1201081091099710), 7],
            [uint256(43114), 8],
            [uint256(8453), 9],
            [uint256(10), 10],
            [uint256(42220), 11],
            [uint256(146), 12],
            [uint256(9270000000000000), 13],
            [uint256(130), 14],
            [uint256(59144), 17]
        ];

        AllBridgeFacet.ChainIdConfig[] memory configs =
            _decodeInitCallData(script.exposedGetCallData());

        assertEq(configs.length, expected.length);
        for (uint256 i = 0; i < expected.length; i++) {
            assertEq(configs[i].chainId, expected[i][0]);
            assertEq(configs[i].allBridgeChainId, expected[i][1]);
        }
    }

    function test_MapsStellarAndPolygonToTheirAllBridgeChainIds() public {
        AllBridgeFacet.ChainIdConfig[] memory configs =
            _decodeInitCallData(script.exposedGetCallData());

        assertEq(_allBridgeChainIdOf(configs, 1201081091099710), 7);
        assertEq(_allBridgeChainIdOf(configs, 137), 5);
    }

    function test_ReadsFieldsByNameWhateverTheirOrderInTheObject() public {
        // allBridgeChainId first in row 0: a decoder that fills fields by key order swaps them
        string memory reordered = string.concat(
            "{",
            _quoted("mappings"),
            ":[{",
            _quoted("allBridgeChainId"),
            ":5,",
            _quoted("chainId"),
            ":137},{",
            _quoted("chainId"),
            ":1201081091099710,",
            _quoted("allBridgeChainId"),
            ":7}]}"
        );

        AllBridgeFacet.ChainIdConfig[] memory configs =
            script.exposedParseChainIdConfigs(reordered);

        assertEq(configs.length, 2);
        assertEq(configs[0].chainId, 137);
        assertEq(configs[0].allBridgeChainId, 5);
        assertEq(configs[1].chainId, 1201081091099710);
        assertEq(configs[1].allBridgeChainId, 7);
    }

    function testRevert_ConfigWithoutMappings() public {
        vm.expectRevert(
            UpdateAllBridgeFacetScript.NoAllBridgeMappings.selector
        );

        script.exposedParseChainIdConfigs("{}");
    }

    function testRevert_ZeroChainId() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateAllBridgeFacetScript.InvalidAllBridgeMapping.selector, 1
            )
        );

        script.exposedParseChainIdConfigs(_twoRowConfig(0, 5));
    }

    function testRevert_ZeroAllBridgeChainId() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateAllBridgeFacetScript.InvalidAllBridgeMapping.selector, 1
            )
        );

        script.exposedParseChainIdConfigs(_twoRowConfig(137, 0));
    }

    /// @dev Row 0 is valid; row 1 carries the given values
    function _twoRowConfig(uint256 _chainId, uint256 _allBridgeChainId)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            "{",
            _quoted("mappings"),
            ":[{",
            _quoted("chainId"),
            ":1,",
            _quoted("allBridgeChainId"),
            ":1},{",
            _quoted("chainId"),
            ":",
            vm.toString(_chainId),
            ",",
            _quoted("allBridgeChainId"),
            ":",
            vm.toString(_allBridgeChainId),
            "}]}"
        );
    }

    function _decodeInitCallData(bytes memory _callData)
        internal
        pure
        returns (AllBridgeFacet.ChainIdConfig[] memory)
    {
        assertEq(bytes4(_callData), AllBridgeFacet.initAllBridge.selector);

        bytes memory args = new bytes(_callData.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = _callData[i + 4];
        }

        return abi.decode(args, (AllBridgeFacet.ChainIdConfig[]));
    }

    function _quoted(string memory _s) internal pure returns (string memory) {
        string memory quote = string(abi.encodePacked(bytes1(0x22)));
        return string.concat(quote, _s, quote);
    }

    function _allBridgeChainIdOf(
        AllBridgeFacet.ChainIdConfig[] memory _configs,
        uint256 _chainId
    ) internal pure returns (uint256) {
        for (uint256 i = 0; i < _configs.length; i++) {
            if (_configs[i].chainId == _chainId) {
                return _configs[i].allBridgeChainId;
            }
        }
        revert ChainIdNotInInitCallData(_chainId);
    }
}
