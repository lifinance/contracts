// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";
import { TestBase, ILiFi, console, LiFiDiamond } from "../utils/TestBase.sol";

interface Diamond {
    function standardizedCall(bytes calldata _data) external payable;

    function standardizedSwapCall(bytes calldata _data) external payable;

    function standardizedBridgeCall(bytes calldata _data) external payable;

    function standardizedSwapAndBridgeCall(
        bytes calldata _data
    ) external payable;

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

contract StandardizedCallFacetTest is TestBase {
    Diamond internal mockDiamond;
    StandardizedCallFacet internal standardizedCallFacet;
    MockFacet internal mockFacet;

    event ContextEvent(string);
    error FunctionDoesNotExist();

    function setUp() public {
        LiFiDiamond tmpDiamond = createDiamond(
            USER_DIAMOND_OWNER,
            USER_PAUSER
        );
        standardizedCallFacet = new StandardizedCallFacet();
        mockFacet = new MockFacet();

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = standardizedCallFacet.standardizedCall.selector;
        functionSelectors[1] = standardizedCallFacet
            .standardizedSwapCall
            .selector;
        functionSelectors[2] = standardizedCallFacet
            .standardizedBridgeCall
            .selector;
        functionSelectors[3] = standardizedCallFacet
            .standardizedSwapAndBridgeCall
            .selector;
        addFacet(
            tmpDiamond,
            address(standardizedCallFacet),
            functionSelectors
        );

        bytes4[] memory mockFunctionSelectors = new bytes4[](1);
        mockFunctionSelectors[0] = mockFacet.startBridgeTokensViaMock.selector;
        addFacet(
            tmpDiamond,
            address(mockFacet),
            mockFunctionSelectors,
            address(mockFacet),
            abi.encodeWithSelector(mockFacet.init.selector)
        );
        mockDiamond = Diamond(address(tmpDiamond));
    }

    function testMakeACallWithinTheContextOfTheDiamond() public {
        ILiFi.BridgeData memory bridgeData;
        bytes memory data = abi.encodeWithSelector(
            mockDiamond.startBridgeTokensViaMock.selector,
            bridgeData
        );

        // This call should be made within the context of the mockDiamond
        // and should show that it can access mockDiamond storage
        vm.expectEmit(address(mockDiamond));
        emit ContextEvent("LIFI");
        vm.expectEmit(address(mockDiamond));
        emit LiFiTransferStarted(bridgeData);

        mockDiamond.standardizedCall(data);
    }

    function testMakeASwapCallWithinTheContextOfTheDiamond() public {
        ILiFi.BridgeData memory bridgeData;
        bytes memory data = abi.encodeWithSelector(
            mockDiamond.startBridgeTokensViaMock.selector,
            bridgeData
        );

        // This call should be made within the context of the diamond
        // and should show that it can access diamond storage
        vm.expectEmit(address(mockDiamond));
        emit ContextEvent("LIFI");
        vm.expectEmit(address(mockDiamond));
        emit LiFiTransferStarted(bridgeData);

        mockDiamond.standardizedSwapCall(data);
    }

    function testMakeABridgeCallWithinTheContextOfTheDiamond() public {
        ILiFi.BridgeData memory bridgeData;
        bytes memory data = abi.encodeWithSelector(
            mockDiamond.startBridgeTokensViaMock.selector,
            bridgeData
        );

        // This call should be made within the context of the diamond
        // and should show that it can access diamond storage
        vm.expectEmit(address(mockDiamond));
        emit ContextEvent("LIFI");
        vm.expectEmit(address(mockDiamond));
        emit LiFiTransferStarted(bridgeData);

        mockDiamond.standardizedBridgeCall(data);
    }

    function testMakeASwapAndBridgeCallWithinTheContextOfTheDiamond() public {
        ILiFi.BridgeData memory bridgeData;
        bytes memory data = abi.encodeWithSelector(
            mockDiamond.startBridgeTokensViaMock.selector,
            bridgeData
        );

        // This call should be made within the context of the diamond
        // and should show that it can access diamond storage
        vm.expectEmit(address(mockDiamond));
        emit ContextEvent("LIFI");
        vm.expectEmit(address(mockDiamond));
        emit LiFiTransferStarted(bridgeData);

        mockDiamond.standardizedSwapAndBridgeCall(data);
    }

    function testRevertsWhenCallingANonExistentFunction() public {
        bytes memory data = abi.encodeWithSelector(
            NotAContract.notAFunction.selector
        );

        vm.expectRevert(FunctionDoesNotExist.selector);

        mockDiamond.standardizedCall(data);
    }

    function testRevertsWhenCallingANonExistentSwapFunction() public {
        bytes memory data = abi.encodeWithSelector(
            NotAContract.notAFunction.selector
        );

        vm.expectRevert(FunctionDoesNotExist.selector);

        mockDiamond.standardizedSwapCall(data);
    }

    function testRevertsWhenCallingANonExistentBridgeFunction() public {
        bytes memory data = abi.encodeWithSelector(
            NotAContract.notAFunction.selector
        );

        vm.expectRevert(FunctionDoesNotExist.selector);

        mockDiamond.standardizedBridgeCall(data);
    }

    function testRevertsWhenCallingANonExistentSwapAndBridgeFunction() public {
        bytes memory data = abi.encodeWithSelector(
            NotAContract.notAFunction.selector
        );

        vm.expectRevert(FunctionDoesNotExist.selector);

        mockDiamond.standardizedSwapAndBridgeCall(data);
    }
}
