// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBase, console, LiFiDiamond } from "../utils/TestBase.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, InformationMismatch, AlreadyInitialized } from "src/Errors/GenericErrors.sol";
import { EmergencyPauseFacet } from "lifi/Facets/EmergencyPauseFacet.sol";
import { IStargate, ITokenMessaging } from "lifi/Interfaces/IStargate.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";

// Stub EmergencyPauseFacet Contract
contract TestEmergencyPauseFacet is EmergencyPauseFacet {
    constructor(address _pauserWallet) EmergencyPauseFacet(_pauserWallet) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EmergencyPauseFacetTest is TestBase {
    // EVENTS
    event EmergencyFacetRemoved(address msgSender);

    // STORAGE
    TestEmergencyPauseFacet internal emergencyPauseFacet;

    function setUp() public {
        // set custom block number for forking
        customBlockNumberForForking = 19979843;

        initTestBase();

        emergencyPauseFacet = new TestEmergencyPauseFacet(USER_PAUSER);

        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = emergencyPauseFacet.removeFacet.selector;

        // no need to add the facet to the diamond, it's already added in DiamondTest.sol
        emergencyPauseFacet = TestEmergencyPauseFacet(
            payable(address(diamond))
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(emergencyPauseFacet),
            "EmergencyPauseFacet"
        );
    }

    function test_DiamondOwnerCanRemoveFacet() public {}

    function test_PauserWalletCanRemoveFacet() public {}

    function test_UnauthorizedWalletCannotRemoveFacet() public {}

    function _getDiamondCutDataForFacetRemoval(
        address facetToBeRemoved
    ) public returns (IDiamondCut.FacetCut memory cut) {}
}
