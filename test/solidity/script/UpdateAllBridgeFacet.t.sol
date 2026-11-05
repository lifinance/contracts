// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DeployScript as UpdateAllBridgeFacetScript } from "../../../script/deploy/facets/UpdateAllBridgeFacet.s.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdateAllBridgeFacetHarness is UpdateAllBridgeFacetScript {
    function exposedGetCallData() public returns (bytes memory) {
        return getCallData();
    }

    function exposedParseChainIdConfigs(
        string memory _json
    ) public view returns (AllBridgeFacet.ChainIdConfig[] memory) {
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
        return
            vm.serializeAddress(
                "deployments",
                "LiFiDiamond",
                0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
            );
    }
}

contract UpdateAllBridgeFacetTest is Test {
    using stdJson for string;

    error ChainIdNotInInitCallData(uint256 chainId);

    uint256 internal constant MAINNET_CHAIN_ID = 1;

    UpdateAllBridgeFacetHarness internal script;
    string internal config;

    function setUp() public {
        vm.chainId(MAINNET_CHAIN_ID);

        vm.setEnv("NETWORK", "mainnet");
        vm.setEnv("FILE_SUFFIX", "");
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(uint256(1))));
        vm.setEnv("USE_DEF_DIAMOND", "true");

        script = new UpdateAllBridgeFacetHarness();
        config = vm.readFile(
            string.concat(vm.projectRoot(), "/config/allbridge.json")
        );
    }

    function test_DecodesEveryConfigRowByFieldName() public {
        AllBridgeFacet.ChainIdConfig[] memory configs = _decodeInitCallData(
            script.exposedGetCallData()
        );
        uint256 rowCount;
        while (config.keyExists(_rowKey(rowCount, ""))) rowCount++;

        assertGt(rowCount, 0);
        assertEq(configs.length, rowCount);
        for (uint256 i = 0; i < rowCount; i++) {
            assertEq(
                configs[i].chainId,
                config.readUint(_rowKey(i, ".chainId"))
            );
            assertEq(
                configs[i].allBridgeChainId,
                config.readUint(_rowKey(i, ".allBridgeChainId"))
            );
        }
    }

    function test_MapsStellarAndPolygonToTheirAllBridgeChainIds() public {
        AllBridgeFacet.ChainIdConfig[] memory configs = _decodeInitCallData(
            script.exposedGetCallData()
        );

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

        AllBridgeFacet.ChainIdConfig[] memory configs = script
            .exposedParseChainIdConfigs(reordered);

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

    function _decodeInitCallData(
        bytes memory _callData
    ) internal pure returns (AllBridgeFacet.ChainIdConfig[] memory) {
        assertEq(bytes4(_callData), AllBridgeFacet.initAllBridge.selector);

        bytes memory args = new bytes(_callData.length - 4);
        for (uint256 i = 0; i < args.length; i++) args[i] = _callData[i + 4];

        return abi.decode(args, (AllBridgeFacet.ChainIdConfig[]));
    }

    function _quoted(string memory _s) internal pure returns (string memory) {
        string memory quote = string(abi.encodePacked(bytes1(0x22)));
        return string.concat(quote, _s, quote);
    }

    function _rowKey(
        uint256 _index,
        string memory _field
    ) internal pure returns (string memory) {
        return string.concat(".mappings[", vm.toString(_index), "]", _field);
    }

    function _allBridgeChainIdOf(
        AllBridgeFacet.ChainIdConfig[] memory _configs,
        uint256 _chainId
    ) internal pure returns (uint256) {
        for (uint256 i = 0; i < _configs.length; i++) {
            if (_configs[i].chainId == _chainId)
                return _configs[i].allBridgeChainId;
        }
        revert ChainIdNotInInitCallData(_chainId);
    }
}
