// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpdateScriptBase } from "../../../script/deploy/facets/utils/UpdateScriptBase.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "test/solidity/utils/DiamondTest.sol";

/// @dev Reads deployment data from an env var instead of deployments/<network>.json so the suite can
///      point the base class at a diamond that only exists inside this test run. Every env var this
///      file writes holds the same value in every test case, because forge shares process env across
///      test cases it runs in parallel; per-case variation goes through `_readCutOptions` overrides.
contract UpdateScriptBaseHarness is UpdateScriptBase {
    function runUpdate(
        string memory _name
    ) public returns (address[] memory facets, bytes memory cutData) {
        return update(_name);
    }

    function isNoBroadcast() public view returns (bool) {
        return noBroadcast;
    }

    function _readDeploymentsJson()
        internal
        view
        override
        returns (string memory)
    {
        return vm.envString("TEST_DEPLOYMENTS_JSON");
    }
}

contract ExplicitDefaultsHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.selectorArtifactsDir = "./out";
        options.expectedDiamond = vm.envAddress("TEST_DIAMOND");
    }
}

contract FacetAddressOverrideHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.facetAddress = vm.envAddress("TEST_ATTESTED_FACET");
    }
}

contract ExpectedDiamondMismatchHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.expectedDiamond = vm.envAddress("TEST_WRONG_DIAMOND");
    }
}

contract UnpinnedVerificationHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
    }
}

contract DriftedVerificationHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
        options.diamondStateBlock = block.number + 1;
    }
}

contract PinnedVerificationHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
        options.diamondStateBlock = block.number;
        options.noBroadcast = false;
    }
}

contract MissingArtifactsHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.selectorArtifactsDir = "./out/nonexistent-artifacts";
    }
}

contract UpdateScriptBaseTest is Test, DiamondTest {
    // Selector order is what `contract-selectors.sh` emits: jq over the artifact's
    // `methodIdentifiers`, which solc writes sorted by signature. Cut calldata bytes depend on it.
    bytes4 internal constant CANCEL_OWNERSHIP_TRANSFER =
        OwnershipFacet.cancelOwnershipTransfer.selector;
    bytes4 internal constant CONFIRM_OWNERSHIP_TRANSFER =
        OwnershipFacet.confirmOwnershipTransfer.selector;
    bytes4 internal constant OWNER = OwnershipFacet.owner.selector;
    bytes4 internal constant TRANSFER_OWNERSHIP =
        OwnershipFacet.transferOwnership.selector;
    bytes4 internal constant EXECUTE_CALL_AND_WITHDRAW =
        WithdrawFacet.executeCallAndWithdraw.selector;
    bytes4 internal constant WITHDRAW = WithdrawFacet.withdraw.selector;

    uint256 internal constant MAINNET_CHAIN_ID = 1;

    address internal diamondOwner = makeAddr("diamondOwner");
    address internal pauserWallet = makeAddr("pauserWallet");
    address internal wrongDiamond = makeAddr("wrongDiamond");

    LiFiDiamond internal diamond;
    address internal newOwnershipFacet;
    address internal attestedOwnershipFacet;
    address internal withdrawFacet;

    function setUp() public {
        vm.chainId(MAINNET_CHAIN_ID);

        diamond = createDiamond(diamondOwner, pauserWallet);
        newOwnershipFacet = address(new OwnershipFacet());
        attestedOwnershipFacet = address(new OwnershipFacet());
        withdrawFacet = address(new WithdrawFacet());

        vm.label(address(diamond), "LiFiDiamond");
        vm.label(newOwnershipFacet, "OwnershipFacet(deployments)");
        vm.label(attestedOwnershipFacet, "OwnershipFacet(attested)");
        vm.label(withdrawFacet, "WithdrawFacet");

        vm.setEnv("NETWORK", "mainnet");
        vm.setEnv("FILE_SUFFIX", "");
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(uint256(1))));
        vm.setEnv("USE_DEF_DIAMOND", "true");
        vm.setEnv("NO_BROADCAST", "true");
        vm.setEnv("TEST_DEPLOYMENTS_JSON", _deploymentsJson());
        vm.setEnv("TEST_DIAMOND", vm.toString(address(diamond)));
        vm.setEnv("TEST_ATTESTED_FACET", vm.toString(attestedOwnershipFacet));
        vm.setEnv("TEST_WRONG_DIAMOND", vm.toString(wrongDiamond));
    }

    function test_ReplaceCutMatchesGoldenCalldata() public {
        UpdateScriptBaseHarness harness = new UpdateScriptBaseHarness();

        (, bytes memory cutData) = harness.runUpdate("OwnershipFacet");

        assertEq(
            cutData,
            _expectedCutData(
                newOwnershipFacet,
                LibDiamond.FacetCutAction.Replace,
                _ownershipSelectors()
            )
        );
    }

    function test_AddCutMatchesGoldenCalldata() public {
        UpdateScriptBaseHarness harness = new UpdateScriptBaseHarness();

        (, bytes memory cutData) = harness.runUpdate("WithdrawFacet");

        bytes4[] memory expectedSelectors = new bytes4[](2);
        expectedSelectors[0] = EXECUTE_CALL_AND_WITHDRAW;
        expectedSelectors[1] = WITHDRAW;

        assertEq(
            cutData,
            _expectedCutData(
                withdrawFacet,
                LibDiamond.FacetCutAction.Add,
                expectedSelectors
            )
        );
    }

    function test_ExplicitDefaultOptionsProduceIdenticalCalldata() public {
        UpdateScriptBaseHarness baseline = new UpdateScriptBaseHarness();
        (, bytes memory baselineCutData) = baseline.runUpdate(
            "OwnershipFacet"
        );

        ExplicitDefaultsHarness explicitDefaults = new ExplicitDefaultsHarness();
        (, bytes memory explicitCutData) = explicitDefaults.runUpdate(
            "OwnershipFacet"
        );

        assertEq(explicitCutData, baselineCutData);
        assertEq(baseline.isNoBroadcast(), explicitDefaults.isNoBroadcast());
    }

    function test_FacetAddressOverrideTakesPrecedenceOverDeploymentsFile()
        public
    {
        FacetAddressOverrideHarness harness = new FacetAddressOverrideHarness();

        (, bytes memory cutData) = harness.runUpdate("OwnershipFacet");

        assertEq(
            cutData,
            _expectedCutData(
                attestedOwnershipFacet,
                LibDiamond.FacetCutAction.Replace,
                _ownershipSelectors()
            )
        );
    }

    function test_CutVerificationModeForcesNoBroadcast() public {
        PinnedVerificationHarness harness = new PinnedVerificationHarness();

        assertTrue(harness.isNoBroadcast());
    }

    function test_CutVerificationModeAcceptsPinnedBlock() public {
        PinnedVerificationHarness harness = new PinnedVerificationHarness();

        (, bytes memory cutData) = harness.runUpdate("OwnershipFacet");

        assertEq(
            cutData,
            _expectedCutData(
                newOwnershipFacet,
                LibDiamond.FacetCutAction.Replace,
                _ownershipSelectors()
            )
        );
    }

    function testRevert_CutVerificationModeWithoutPinnedBlock() public {
        vm.expectRevert(UpdateScriptBase.DiamondStateNotPinned.selector);

        new UnpinnedVerificationHarness();
    }

    function testRevert_CutVerificationModeBlockDrift() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateScriptBase.DiamondStateBlockMismatch.selector,
                block.number + 1,
                block.number
            )
        );

        new DriftedVerificationHarness();
    }

    function testRevert_ExpectedDiamondAddressMismatch() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateScriptBase.DiamondAddressMismatch.selector,
                address(diamond),
                wrongDiamond
            )
        );

        new ExpectedDiamondMismatchHarness();
    }

    function testRevert_NetworkChainIdMismatch() public {
        vm.chainId(MAINNET_CHAIN_ID + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateScriptBase.NetworkChainIdMismatch.selector,
                "mainnet",
                MAINNET_CHAIN_ID,
                MAINNET_CHAIN_ID + 1
            )
        );

        new UpdateScriptBaseHarness();
    }

    function testRevert_SelectorArtifactsDirWithoutBuildOutput() public {
        MissingArtifactsHarness harness = new MissingArtifactsHarness();

        // The full ffi error quotes the whole argv, so match on the guard's own message instead of
        // pinning a string that changes whenever an argument does.
        (bool success, bytes memory reason) = address(harness).call(
            abi.encodeCall(harness.runUpdate, ("OwnershipFacet"))
        );

        assertFalse(success);
        assertTrue(
            vm.contains(
                string(reason),
                "no build artifact at ./out/nonexistent-artifacts/OwnershipFacet.sol/OwnershipFacet.json"
            )
        );
    }

    function _ownershipSelectors()
        internal
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4);
        selectors[0] = CANCEL_OWNERSHIP_TRANSFER;
        selectors[1] = CONFIRM_OWNERSHIP_TRANSFER;
        selectors[2] = OWNER;
        selectors[3] = TRANSFER_OWNERSHIP;
    }

    function _deploymentsJson() internal returns (string memory) {
        string memory obj = "deployments";
        vm.serializeAddress(obj, "LiFiDiamond", address(diamond));
        vm.serializeAddress(obj, "OwnershipFacet", newOwnershipFacet);

        return vm.serializeAddress(obj, "WithdrawFacet", withdrawFacet);
    }

    function _expectedCutData(
        address _facet,
        LibDiamond.FacetCutAction _action,
        bytes4[] memory _selectors
    ) internal pure returns (bytes memory) {
        LibDiamond.FacetCut[] memory expectedCut = new LibDiamond.FacetCut[](
            1
        );
        expectedCut[0] = LibDiamond.FacetCut({
            facetAddress: _facet,
            action: _action,
            functionSelectors: _selectors
        });

        return
            abi.encodeWithSelector(
                DiamondCutFacet.diamondCut.selector,
                expectedCut,
                address(0),
                bytes("")
            );
    }
}
