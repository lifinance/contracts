// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";

contract ImmutableDiamondOwnershipTransfer {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.ownership");

    /// Types ///
    struct Storage {
        address newOwner;
    }

    /// @notice Transfers ownership of diamond to address(0) (for immutable diamond)
    function transferOwnershipToZeroAddress() external {
        Storage storage s = getStorage();
        // Clear out pending ownership if any.
        s.newOwner = address(0);
        // transfer ownership to 0 address
        LibDiamond.setContractOwner(address(0));
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (LiFiDiamond diamondContract, bytes memory constructorArgs)
    {
        // this is to silence compiler warnings
        constructorArgs = abi.encodePacked("");
        diamondContract = LiFiDiamond(payable(diamond));

        // get CREATE3-Factory
        CREATE3Factory factory = CREATE3Factory(
            vm.envAddress("CREATE3_FACTORY_ADDRESS")
        );

        // deploy helper contract that transfers diamond ownership to address(0)
        bytes32 salt = keccak256("TRANSFER_OWNERSHIP_TO_ZERO_ADDRESS");
        address ownershipTransfer = factory.getDeployed(
            vm.addr(deployerPrivateKey),
            salt
        );

        vm.startBroadcast(deployerPrivateKey);

        // deploy helper contract
        if (!isContract(ownershipTransfer)) {
            ownershipTransfer = factory.deploy(
                salt,
                type(ImmutableDiamondOwnershipTransfer).creationCode
            );
        }

        // check if diamond address has contract deployed to
        if (!isContract(diamond)) {
            revert(
                "Error in script - check if diamondImmutable is deployed under stored address"
            );
        }

        // prepare calldata to call transferOwnershipToZeroAddress function (during diamondCut)
        bytes memory callData = abi.encodeWithSelector(
            ImmutableDiamondOwnershipTransfer
                .transferOwnershipToZeroAddress
                .selector
        );

        // remove diamondCut facet to not allow any further code changes to the contract
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = DiamondCutFacet.diamondCut.selector;
        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: selectors
            })
        );

        // remove cutFacet and transferOwnership to address(0)
        cutter.diamondCut(cut, ownershipTransfer, callData);

        vm.stopBroadcast();
    }

    function isContract(address _contractAddr) internal view returns (bool) {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(_contractAddr)
        }
        return size > 0;
    }
}
