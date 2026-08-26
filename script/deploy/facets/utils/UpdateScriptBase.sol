// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ScriptBase } from "./ScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

contract UpdateScriptBase is ScriptBase {
    using stdJson for string;

    error InvalidHexDigit(uint8 d);
    error NetworkChainIdMismatch(
        string network,
        uint256 configured,
        uint256 actual
    );
    error DiamondAddressMismatch(address fromDeployments, address expected);
    error DiamondHasNoCode(address diamond);
    error DiamondStateNotPinned();
    error DiamondStateBlockMismatch(uint256 expected, uint256 actual);
    error VerificationModeNotSupported();

    string internal constant DEFAULT_SELECTOR_ARTIFACTS_DIR = "./out";

    struct FunctionSelector {
        string name;
        bytes selector;
    }

    struct Approval {
        address aTokenAddress;
        address bContractAddress;
    }

    struct CutOptions {
        bool noBroadcast;
        address facetAddress;
        address expectedDiamond;
        string selectorArtifactsDir;
        bool verificationMode;
        uint256 diamondStateBlock;
    }

    address internal diamond;
    LibDiamond.FacetCut[] internal cut;
    bytes4[] internal selectorsToReplace;
    bytes4[] internal selectorsToRemove;
    bytes4[] internal selectorsToAdd;
    DiamondCutFacet internal cutter;
    DiamondLoupeFacet internal loupe;
    string internal path;
    string internal json;
    bool internal noBroadcast = false;
    bool internal useDefaultDiamond;
    CutOptions internal cutOptions;

    constructor() {
        useDefaultDiamond = vm.envBool("USE_DEF_DIAMOND");

        CutOptions memory options = _readCutOptions();
        cutOptions = options;

        // A verification run recomputes calldata for comparison, so it must not send a transaction
        // even if the caller passed NO_BROADCAST=false. Scripts that broadcast outside update()
        // are not covered by this and must call _rejectVerificationMode() instead.
        noBroadcast = options.noBroadcast || options.verificationMode;

        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = _readDeploymentsJson();
        diamond = useDefaultDiamond
            ? json.readAddress(".LiFiDiamond")
            : json.readAddress(".LiFiDiamondImmutable");
        cutter = DiamondCutFacet(diamond);
        loupe = DiamondLoupeFacet(diamond);

        _checkDiamondAddress();
        _checkDiamondStateIsPinned();
    }

    /// @dev Single entry point for every knob that steers a recomputed cut, so a caller verifying a
    ///      proposal has one place to look. Virtual because forge shares process env across tests
    ///      running in parallel, which makes per-case env mutation unusable in the suite.
    function _readCutOptions()
        internal
        view
        virtual
        returns (CutOptions memory options)
    {
        options.noBroadcast = vm.envOr("NO_BROADCAST", false);

        // Read strictly rather than via envOr: envOr swallows a set-but-unparseable value and
        // returns the default, so a typo in any of these would silently switch the check it
        // controls back off and hand the caller a confident, unverified result.
        options.facetAddress = vm.envExists("FACET_ADDRESS_OVERRIDE")
            ? vm.envAddress("FACET_ADDRESS_OVERRIDE")
            : address(0);
        options.expectedDiamond = vm.envExists("EXPECTED_DIAMOND_ADDRESS")
            ? vm.envAddress("EXPECTED_DIAMOND_ADDRESS")
            : address(0);
        options.selectorArtifactsDir = vm.envExists("SELECTOR_ARTIFACTS_DIR")
            ? vm.envString("SELECTOR_ARTIFACTS_DIR")
            : DEFAULT_SELECTOR_ARTIFACTS_DIR;
        options.verificationMode =
            vm.envExists("CUT_VERIFICATION_MODE") &&
            vm.envBool("CUT_VERIFICATION_MODE");
        options.diamondStateBlock = vm.envExists("DIAMOND_STATE_BLOCK")
            ? vm.envUint("DIAMOND_STATE_BLOCK")
            : 0;
    }

    /// @dev Seam so tests can supply deployment data without writing into the repo's deployments/ tree.
    function _readDeploymentsJson() internal virtual returns (string memory) {
        return vm.readFile(path);
    }

    /// @dev The deployments file and the diamond it names are written by whoever ran the deploy, so
    ///      neither is trustworthy on its own. Bind them to sources the proposer does not control:
    ///      the chain the RPC actually points at (via config/networks.json) and, when the caller
    ///      knows which diamond it is verifying, an explicitly pinned address.
    ///      The config path is fixed rather than honouring NETWORKS_JSON_FILE_PATH: a trust anchor
    ///      that an env var can redirect is not one.
    function _checkDiamondAddress() internal view {
        string memory networksJson = vm.readFile(
            string.concat(root, "/config/networks.json")
        );
        string memory chainIdKey = string.concat(".", network, ".chainId");

        if (networksJson.keyExists(chainIdKey)) {
            uint256 configuredChainId = networksJson.readUint(chainIdKey);
            if (configuredChainId != block.chainid)
                revert NetworkChainIdMismatch(
                    network,
                    configuredChainId,
                    block.chainid
                );
        }

        if (
            cutOptions.expectedDiamond != address(0) &&
            cutOptions.expectedDiamond != diamond
        ) revert DiamondAddressMismatch(diamond, cutOptions.expectedDiamond);

        if (cutOptions.verificationMode && diamond.code.length == 0)
            revert DiamondHasNoCode(diamond);
    }

    /// @dev buildDiamondCut reads the live diamond, so the resulting calldata is only reproducible
    ///      against a fixed block. A verification run therefore has to state which block it expects
    ///      and fail when the fork is not actually pinned there.
    function _checkDiamondStateIsPinned() internal view {
        if (!cutOptions.verificationMode) return;

        if (cutOptions.diamondStateBlock == 0) revert DiamondStateNotPinned();

        if (block.number != cutOptions.diamondStateBlock)
            revert DiamondStateBlockMismatch(
                cutOptions.diamondStateBlock,
                block.number
            );
    }

    /// @dev For scripts that resolve facet addresses themselves instead of through update(), so the
    ///      overrides never reach them. Refusing is the honest answer: such a run would otherwise
    ///      report a confident match computed entirely from the local, proposer-written state.
    function _rejectVerificationMode() internal view {
        if (cutOptions.verificationMode) revert VerificationModeNotSupported();
    }

    /// @dev The address a proposal claims for the new facet is proven legitimate by bytecode
    ///      attestation elsewhere; here it only has to be injectable so the cut can be rebuilt
    ///      without trusting the local deployments file.
    function _resolveFacetAddress(
        string memory _name
    ) internal view returns (address) {
        if (cutOptions.facetAddress != address(0))
            return cutOptions.facetAddress;

        return json.readAddress(string.concat(".", _name));
    }

    function update(
        string memory name
    )
        internal
        virtual
        returns (address[] memory facets, bytes memory cutData)
    {
        return update(name, _resolveFacetAddress(name));
    }

    function update(
        string memory name,
        address updater
    )
        internal
        virtual
        returns (address[] memory facets, bytes memory cutData)
    {
        address facet = _resolveFacetAddress(name);
        bytes4[] memory excludes = getExcludes();
        bytes memory callData = getCallData();

        bytes4[] memory newSelectors = getSelectors(name, excludes);

        buildDiamondCut(newSelectors, facet);

        // prepare full diamondCut calldata and log for debugging purposes
        if (cut.length > 0) {
            cutData = abi.encodeWithSelector(
                DiamondCutFacet.diamondCut.selector,
                cut,
                callData.length > 0 ? updater : address(0),
                callData
            );

            emit log("DiamondCutCalldata: ");
            emit log_bytes(cutData);
        }

        if (noBroadcast) {
            // Get current facets for return value even when not broadcasting
            facets = loupe.facetAddresses();
            return (facets, cutData);
        }

        vm.startBroadcast(deployerPrivateKey);

        if (cut.length > 0) {
            cutter.diamondCut(
                cut,
                callData.length > 0 ? updater : address(0),
                callData
            );
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }

    function getExcludes() internal virtual returns (bytes4[] memory) {}

    function getCallData() internal virtual returns (bytes memory) {}

    function getSelectors(
        string memory _facetName,
        bytes4[] memory _exclude
    ) internal returns (bytes4[] memory selectors) {
        string[] memory cmd = new string[](4);
        cmd[0] = "script/deploy/facets/utils/contract-selectors.sh";
        cmd[1] = _facetName;
        string memory exclude;
        for (uint256 i; i < _exclude.length; i++) {
            exclude = string.concat(exclude, fromCode(_exclude[i]), " ");
        }
        cmd[2] = exclude;
        cmd[3] = cutOptions.selectorArtifactsDir;
        bytes memory res = vm.ffi(cmd);
        selectors = abi.decode(res, (bytes4[]));
    }

    function buildDiamondCut(
        bytes4[] memory newSelectors,
        address newFacet
    ) internal {
        address oldFacet;

        selectorsToAdd = new bytes4[](0);
        selectorsToReplace = new bytes4[](0);
        selectorsToRemove = new bytes4[](0);

        // Get selectors to add or replace
        for (uint256 i; i < newSelectors.length; i++) {
            address existingFacet = loupe.facetAddress(newSelectors[i]);
            if (existingFacet == address(0)) {
                selectorsToAdd.push(newSelectors[i]);
                // Don't replace if the new facet address is the same as the old facet address
            } else if (existingFacet != newFacet) {
                selectorsToReplace.push(newSelectors[i]);
                oldFacet = existingFacet;
            }
        }

        // Get selectors to remove
        if (oldFacet != address(0)) {
            bytes4[] memory oldSelectors = loupe.facetFunctionSelectors(
                oldFacet
            );
            for (uint256 i; i < oldSelectors.length; i++) {
                bool found = false;
                for (uint256 j; j < newSelectors.length; j++) {
                    if (oldSelectors[i] == newSelectors[j]) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    selectorsToRemove.push(oldSelectors[i]);
                }
            }
        }

        // Build diamond cut
        if (selectorsToReplace.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: newFacet,
                    action: LibDiamond.FacetCutAction.Replace,
                    functionSelectors: selectorsToReplace
                })
            );
        }

        if (selectorsToRemove.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: address(0),
                    action: LibDiamond.FacetCutAction.Remove,
                    functionSelectors: selectorsToRemove
                })
            );
        }

        if (selectorsToAdd.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: newFacet,
                    action: LibDiamond.FacetCutAction.Add,
                    functionSelectors: selectorsToAdd
                })
            );
        }
    }

    function buildInitialCut(
        bytes4[] memory newSelectors,
        address newFacet
    ) internal {
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: newFacet,
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: newSelectors
            })
        );
    }

    function toHexDigit(uint8 d) internal pure returns (bytes1) {
        if (0 <= d && d <= 9) {
            return bytes1(uint8(bytes1("0")) + d);
        } else if (10 <= uint8(d) && uint8(d) <= 15) {
            return bytes1(uint8(bytes1("a")) + d - 10);
        }
        revert InvalidHexDigit(d);
    }

    function fromCode(bytes4 code) public pure returns (string memory) {
        bytes memory result = new bytes(10);
        result[0] = bytes1("0");
        result[1] = bytes1("x");
        for (uint256 i = 0; i < 4; ++i) {
            result[2 * i + 2] = toHexDigit(uint8(code[i]) / 16);
            result[2 * i + 3] = toHexDigit(uint8(code[i]) % 16);
        }
        return string(result);
    }

    function approveRefundWallet() internal {
        // get refund wallet address from global config file
        path = string.concat(root, "/config/global.json");
        json = vm.readFile(path);
        address refundWallet = json.readAddress(".refundWallet");

        // get function selectors that should be approved for refundWallet
        bytes memory rawConfig = json.parseRaw(
            ".approvedSelectorsForRefundWallet"
        );

        // parse raw data from config into FunctionSelector array
        FunctionSelector[] memory funcSelectorsToBeApproved = abi.decode(
            rawConfig,
            (FunctionSelector[])
        );

        emit log("funcSelectorsToBeApproved: ");
        emit log_uint(funcSelectorsToBeApproved.length);

        // go through array with function selectors
        for (uint256 i = 0; i < funcSelectorsToBeApproved.length; i++) {
            emit log("funcSelectorsToBeApproved: ");
            emit log(funcSelectorsToBeApproved[i].name);
            // Register refundWallet as authorized wallet to call these functions
            AccessManagerFacet(diamond).setCanExecute(
                bytes4(funcSelectorsToBeApproved[i].selector),
                refundWallet,
                true
            );
        }
    }
}
