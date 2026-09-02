// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpdateScriptBase } from "../../../script/deploy/facets/utils/UpdateScriptBase.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "test/solidity/utils/DiamondTest.sol";

/// @dev Reads deployment data from an env var instead of deployments/<network>.json so the suite can
///      point the base class at a diamond that only exists inside this test run. Every env var this
///      file writes holds the same value in every test case, because forge shares process env across
///      test cases it runs in parallel; per-case variation goes through `_readCutOptions` overrides.
///      Note that this includes PRIVATE_KEY, which `ScriptBase` requires — any future suite that
///      instantiates a script base in the same run inherits these values.
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
        virtual
        override
        returns (string memory)
    {
        return vm.envString("TEST_DEPLOYMENTS_JSON");
    }
}

/// @dev Everything except the artifacts dir still comes from the real env vars, so this covers the
///      env names the production path depends on while keeping the cut computable.
contract EnvDrivenHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.selectorArtifactsDir = "./out";
    }
}

/// @dev Baseline for cases that exercise something other than the env plumbing: every recompute
///      option is back at the value `_readCutOptions` produces when nothing is set.
contract DefaultCutOptionsHarness is UpdateScriptBaseHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options.noBroadcast = super._readCutOptions().noBroadcast;
        options.facetAddress = address(0);
        options.expectedDiamond = address(0);
        options.selectorArtifactsDir = "./out";
        options.verificationMode = false;
        options.diamondStateBlock = 0;
    }
}

contract ExplicitDefaultsHarness is DefaultCutOptionsHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.expectedDiamond = vm.envAddress("TEST_DIAMOND");
    }
}

contract FacetAddressOverrideHarness is DefaultCutOptionsHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.facetAddress = vm.envAddress("TEST_ATTESTED_FACET");
    }
}

contract ExpectedDiamondMismatchHarness is DefaultCutOptionsHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.expectedDiamond = vm.envAddress("TEST_WRONG_DIAMOND");
    }
}

contract UnpinnedVerificationHarness is DefaultCutOptionsHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
    }
}

contract DriftedVerificationHarness is DefaultCutOptionsHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
        options.diamondStateBlock = block.number + 1;
    }
}

contract PinnedVerificationHarness is DefaultCutOptionsHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
        options.diamondStateBlock = block.number;
        options.noBroadcast = false;
        options.facetAddress = vm.envAddress("TEST_ATTESTED_FACET");
        options.expectedDiamond = vm.envAddress("TEST_DIAMOND");
    }
}

contract CodelessDiamondHarness is PinnedVerificationHarness {
    function _readDeploymentsJson()
        internal
        view
        virtual
        override
        returns (string memory)
    {
        return vm.envString("TEST_CODELESS_DEPLOYMENTS_JSON");
    }

    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.expectedDiamond = vm.envAddress("TEST_CODELESS_DIAMOND");
    }
}

contract VerificationMissingFacetOverrideHarness is DefaultCutOptionsHarness {
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
        options.diamondStateBlock = block.number;
        options.expectedDiamond = vm.envAddress("TEST_DIAMOND");
    }
}

contract VerificationMissingExpectedDiamondHarness is
    DefaultCutOptionsHarness
{
    function _readCutOptions()
        internal
        view
        virtual
        override
        returns (CutOptions memory options)
    {
        options = super._readCutOptions();
        options.verificationMode = true;
        options.diamondStateBlock = block.number;
        options.facetAddress = vm.envAddress("TEST_ATTESTED_FACET");
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
    string internal constant BOGUS_ARTIFACTS_DIR =
        "./out/nonexistent-artifacts";

    address internal diamondOwner = makeAddr("diamondOwner");
    address internal pauserWallet = makeAddr("pauserWallet");
    address internal wrongDiamond = makeAddr("wrongDiamond");
    address internal codelessDiamond = makeAddr("codelessDiamond");

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
        vm.setEnv("TEST_DEPLOYMENTS_JSON", _deploymentsJson(address(diamond)));
        vm.setEnv(
            "TEST_CODELESS_DEPLOYMENTS_JSON",
            _deploymentsJson(codelessDiamond)
        );
        vm.setEnv("TEST_DIAMOND", vm.toString(address(diamond)));
        vm.setEnv("TEST_CODELESS_DIAMOND", vm.toString(codelessDiamond));
        vm.setEnv("TEST_ATTESTED_FACET", vm.toString(attestedOwnershipFacet));
        vm.setEnv("TEST_WRONG_DIAMOND", vm.toString(wrongDiamond));

        // The recompute options carry the values a real verification run would pass, so the
        // env-driven cases below fail if a variable name in `_readCutOptions` is ever mistyped.
        vm.setEnv(
            "FACET_ADDRESS_OVERRIDE",
            vm.toString(attestedOwnershipFacet)
        );
        vm.setEnv("EXPECTED_DIAMOND_ADDRESS", vm.toString(address(diamond)));
        vm.setEnv("SELECTOR_ARTIFACTS_DIR", BOGUS_ARTIFACTS_DIR);
        vm.setEnv("CUT_VERIFICATION_MODE", "true");
        vm.setEnv("DIAMOND_STATE_BLOCK", vm.toString(block.number));
    }

    function test_EnvVarsDriveCutOptions() public {
        EnvDrivenHarness harness = new EnvDrivenHarness();

        (, bytes memory cutData) = harness.runUpdate("OwnershipFacet");

        // Constructing at all proves EXPECTED_DIAMOND_ADDRESS, CUT_VERIFICATION_MODE and
        // DIAMOND_STATE_BLOCK were read: a mistyped name would leave verification mode off, and a
        // misread pin would revert.
        assertTrue(harness.isNoBroadcast());
        assertEq(
            cutData,
            _expectedCutData(
                attestedOwnershipFacet,
                LibDiamond.FacetCutAction.Replace,
                _ownershipSelectors()
            )
        );
    }

    function testRevert_SelectorArtifactsDirFromEnv() public {
        EnvDrivenHarness envHarness = new EnvDrivenHarness();
        UpdateScriptBaseHarness harness = new UpdateScriptBaseHarness();

        // The env-driven harness only differs in the artifacts dir, so a failure here that the
        // other harness does not hit isolates SELECTOR_ARTIFACTS_DIR to the env read.
        envHarness.runUpdate("OwnershipFacet");

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

    function test_ReplaceCutMatchesGoldenCalldata() public {
        DefaultCutOptionsHarness harness = new DefaultCutOptionsHarness();

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
        DefaultCutOptionsHarness harness = new DefaultCutOptionsHarness();

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

    function test_RemoveCutMatchesGoldenCalldata() public {
        _registerStaleSelectorsOnOwnershipFacet();

        DefaultCutOptionsHarness harness = new DefaultCutOptionsHarness();

        (, bytes memory cutData) = harness.runUpdate("OwnershipFacet");

        bytes4[] memory staleSelectors = new bytes4[](2);
        staleSelectors[0] = EXECUTE_CALL_AND_WITHDRAW;
        staleSelectors[1] = WITHDRAW;

        LibDiamond.FacetCut[] memory expectedCut = new LibDiamond.FacetCut[](
            2
        );
        expectedCut[0] = LibDiamond.FacetCut({
            facetAddress: newOwnershipFacet,
            action: LibDiamond.FacetCutAction.Replace,
            functionSelectors: _ownershipSelectors()
        });
        expectedCut[1] = LibDiamond.FacetCut({
            facetAddress: address(0),
            action: LibDiamond.FacetCutAction.Remove,
            functionSelectors: staleSelectors
        });

        assertEq(cutData, _encodeCut(expectedCut));
    }

    function test_ExplicitDefaultOptionsProduceIdenticalCalldata() public {
        DefaultCutOptionsHarness baseline = new DefaultCutOptionsHarness();
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
                attestedOwnershipFacet,
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

    function testRevert_VerificationModeWithoutFacetOverride() public {
        vm.expectRevert(
            UpdateScriptBase.FacetAddressOverrideRequired.selector
        );

        new VerificationMissingFacetOverrideHarness();
    }

    function testRevert_VerificationModeWithoutExpectedDiamond() public {
        vm.expectRevert(
            UpdateScriptBase.ExpectedDiamondAddressRequired.selector
        );

        new VerificationMissingExpectedDiamondHarness();
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

    function testRevert_VerificationModeAgainstCodelessDiamond() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateScriptBase.DiamondHasNoCode.selector,
                codelessDiamond
            )
        );

        new CodelessDiamondHarness();
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

        new DefaultCutOptionsHarness();
    }

    /// @dev Points two WithdrawFacet selectors at the diamond's existing OwnershipFacet so that
    ///      updating OwnershipFacet has selectors to drop, which is the only way to reach
    ///      buildDiamondCut's Remove branch.
    function _registerStaleSelectorsOnOwnershipFacet() internal {
        address currentOwnershipFacet = DiamondLoupeFacet(address(diamond))
            .facetAddress(OWNER);

        bytes4[] memory staleSelectors = new bytes4[](2);
        staleSelectors[0] = EXECUTE_CALL_AND_WITHDRAW;
        staleSelectors[1] = WITHDRAW;

        LibDiamond.FacetCut[] memory staleCut = new LibDiamond.FacetCut[](1);
        staleCut[0] = LibDiamond.FacetCut({
            facetAddress: currentOwnershipFacet,
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: staleSelectors
        });

        vm.prank(diamondOwner);

        DiamondCutFacet(address(diamond)).diamondCut(staleCut, address(0), "");
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

    function _deploymentsJson(
        address _diamond
    ) internal returns (string memory) {
        string memory obj = "deployments";
        vm.serializeAddress(obj, "LiFiDiamond", _diamond);
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

        return _encodeCut(expectedCut);
    }

    function _encodeCut(
        LibDiamond.FacetCut[] memory _cut
    ) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                DiamondCutFacet.diamondCut.selector,
                _cut,
                address(0),
                bytes("")
            );
    }
}
