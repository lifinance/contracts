// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test } from "forge-std/Test.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "../utils/DiamondTest.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";

interface Diamond {
    function standardizedCall(bytes calldata _data) external payable;

    function startBridgeTokensViaMock(
        ILiFi.BridgeData memory _bridgeData
    ) external payable;
}

contract MockFacet is ILiFi {
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.mock");

    event ContextEvent(string);

    constructor() {
        // Set contract storage
        Storage storage s = getStorage();
        s.context = "Mock";
    }

    function init() external {
        // Set diamond storage
        Storage storage s = getStorage();
        s.context = "LIFI";
    }

    struct Storage {
        string context;
    }

    function startBridgeTokensViaMock(
        ILiFi.BridgeData memory _bridgeData
    ) external payable {
        Storage memory s = getStorage();
        string memory context = s.context;
        emit ContextEvent(context);
        emit LiFiTransferStarted(_bridgeData);
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

contract NotAContract {
    function notAFunction() external {}
}

contract StandardizedCallFacetTest is DiamondTest, Test {
    Diamond internal diamond;
    StandardizedCallFacet internal standardizedCallFacet;
    MockFacet internal mockFacet;

    event ContextEvent(string);

    function setUp() public {
        LiFiDiamond tmpDiamond = createDiamond();
        standardizedCallFacet = new StandardizedCallFacet();
        mockFacet = new MockFacet();

        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = standardizedCallFacet.standardizedCall.selector;
        addFacet(
            tmpDiamond,
            address(standardizedCallFacet),
            functionSelectors
        );

        functionSelectors[0] = mockFacet.startBridgeTokensViaMock.selector;
        addFacet(
            tmpDiamond,
            address(mockFacet),
            functionSelectors,
            address(mockFacet),
            abi.encodeWithSelector(mockFacet.init.selector)
        );
        diamond = Diamond(address(tmpDiamond));
    }

    function testMakeABridgeCallWithinTheContextOfTheDiamond() public {
        ILiFi.BridgeData memory bridgeData;
        bytes memory data = abi.encodeWithSelector(
            diamond.startBridgeTokensViaMock.selector,
            bridgeData
        );

        vm.expectEmit();
        emit ContextEvent("LIFI");

        diamond.standardizedCall(data);
    }

    function testFailWhenCallingANonExistentFunction() public {
        bytes memory data = abi.encodeWithSelector(
            NotAContract.notAFunction.selector
        );

        diamond.standardizedCall(data);
    }
}
