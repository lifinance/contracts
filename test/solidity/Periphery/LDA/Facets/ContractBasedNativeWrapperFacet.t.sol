// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ContractBasedNativeWrapperFacet } from "lifi/Periphery/LDA/Facets/ContractBasedNativeWrapperFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ContractBasedNativeWrapperFacetTest
/// @author LI.FI (https://li.fi)
/// @notice Tests for ContractBasedNativeWrapperFacet functionality
/// @dev Tests the facet that handles dual-purpose native tokens like CELO
/// @custom:version 1.0.0
contract ContractBasedNativeWrapperFacetTest is Test {
    ContractBasedNativeWrapperFacet public contractBasedNativeWrapperFacet;
    address public contractBasedNativeToken;
    address public user;
    address public recipient;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public {
        contractBasedNativeWrapperFacet = new ContractBasedNativeWrapperFacet();

        // Deploy a mock contract-based native token (ERC20 that behaves like native)
        contractBasedNativeToken = address(new MockContractBasedNativeToken());

        user = makeAddr("user");
        recipient = makeAddr("recipient");

        // Give user some tokens
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            user,
            1000 ether
        );
    }

    // ==== Unwrap Tests ====

    function testUnwrapContractBasedNative() public {
        uint256 amount = 100 ether;

        // Prepare swap data with destination address
        bytes memory swapData = abi.encodePacked(recipient);

        // User approves the facet to spend their tokens
        vm.prank(user);
        IERC20(contractBasedNativeToken).approve(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        // Execute unwrap
        vm.prank(user);
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            user,
            contractBasedNativeToken,
            amount
        );

        // Check that recipient received the tokens
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount
        );
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    function testUnwrapContractBasedNativeFromContract() public {
        uint256 amount = 100 ether;

        // Prepare swap data with destination address
        bytes memory swapData = abi.encodePacked(recipient);

        // Give the facet some tokens directly
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        // Execute unwrap with from = address(this) (tokens already in contract)
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            address(contractBasedNativeWrapperFacet),
            contractBasedNativeToken,
            amount
        );

        // Check that recipient received the tokens
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount
        );
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    function testUnwrapContractBasedNativeToSelf() public {
        uint256 amount = 100 ether;

        // Prepare swap data with destination = address(this)
        bytes memory swapData = abi.encodePacked(
            address(contractBasedNativeWrapperFacet)
        );

        // Give the facet some tokens
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        // Execute unwrap with from = address(this) (tokens already in contract)
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            address(contractBasedNativeWrapperFacet),
            contractBasedNativeToken,
            amount
        );

        // Check that tokens stayed in the facet (destination = address(this))
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            amount
        );
    }

    function testUnwrapContractBasedNativeWithZeroAmount() public {
        uint256 amount = 0;

        // Prepare swap data with destination address
        bytes memory swapData = abi.encodePacked(recipient);

        // Execute unwrap with zero amount
        vm.prank(user);
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            user,
            contractBasedNativeToken,
            amount
        );

        // Check that no tokens were transferred
        assertEq(IERC20(contractBasedNativeToken).balanceOf(recipient), 0);
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    // ==== Wrap Tests ====

    function testWrapContractBasedNative() public {
        uint256 amount = 100 ether;

        // Prepare swap data with token address and destination
        bytes memory swapData = abi.encodePacked(
            contractBasedNativeToken,
            recipient
        );

        // Give the facet some tokens to "wrap"
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        // Execute wrap
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            amount
        );

        // Check that recipient received the tokens
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount
        );
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    function testWrapContractBasedNativeToSelf() public {
        uint256 amount = 100 ether;

        // Prepare swap data with destination = address(this)
        bytes memory swapData = abi.encodePacked(
            contractBasedNativeToken,
            address(contractBasedNativeWrapperFacet)
        );

        // Give the facet some tokens to "wrap"
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        // Execute wrap
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            amount
        );

        // Check that tokens stayed in the facet (destination = address(this))
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            amount
        );
    }

    function testWrapContractBasedNativeWithZeroAmount() public {
        uint256 amount = 0;

        // Prepare swap data with token address and destination
        bytes memory swapData = abi.encodePacked(
            contractBasedNativeToken,
            recipient
        );

        // Execute wrap with zero amount
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            amount
        );

        // Check that no tokens were transferred
        assertEq(IERC20(contractBasedNativeToken).balanceOf(recipient), 0);
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    // ==== Error Tests ====

    function testRevertWrapWithInvalidCallData() public {
        // Test with empty swapData (should revert)
        bytes memory emptySwapData = "";

        vm.expectRevert(InvalidCallData.selector);
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            emptySwapData,
            address(0),
            address(0),
            100 ether
        );
    }

    function testRevertWrapWithZeroTokenAddress() public {
        // Test with zero token address in swapData
        bytes memory swapData = abi.encodePacked(address(0), recipient);

        vm.expectRevert(InvalidCallData.selector);
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            100 ether
        );
    }

    function testRevertUnwrapWithInsufficientBalance() public {
        uint256 amount = 100 ether;

        // Prepare swap data with destination address
        bytes memory swapData = abi.encodePacked(recipient);

        // Try to unwrap more than user has (user has 1000 ether, try to unwrap 100 ether)
        // But don't approve the facet
        vm.prank(user);
        vm.expectRevert();
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            user,
            contractBasedNativeToken,
            amount
        );
    }

    // ==== Edge Case Tests ====

    function testUnwrapWithMaxUint256Amount() public {
        uint256 amount = type(uint256).max / 2; // Use half of max to avoid overflow issues

        // Give user a very large amount
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            user,
            amount
        );

        // Prepare swap data with destination address
        bytes memory swapData = abi.encodePacked(recipient);

        // User approves the facet to spend their tokens
        vm.prank(user);
        IERC20(contractBasedNativeToken).approve(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        // Execute unwrap
        vm.prank(user);
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            user,
            contractBasedNativeToken,
            amount
        );

        // Check that recipient received the tokens
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount
        );
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    function testWrapWithMaxUint256Amount() public {
        uint256 amount = type(uint256).max / 2; // Use half of max to avoid overflow issues

        // Give the facet a very large amount
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        // Prepare swap data with token address and destination
        bytes memory swapData = abi.encodePacked(
            contractBasedNativeToken,
            recipient
        );

        // Execute wrap
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            amount
        );

        // Check that recipient received the tokens
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount
        );
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    function testMultipleUnwrapOperations() public {
        uint256 amount = 50 ether;

        // Prepare swap data with destination address
        bytes memory swapData = abi.encodePacked(recipient);

        // User approves the facet to spend their tokens
        vm.prank(user);
        IERC20(contractBasedNativeToken).approve(
            address(contractBasedNativeWrapperFacet),
            amount * 2
        );

        // Execute first unwrap
        vm.prank(user);
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            user,
            contractBasedNativeToken,
            amount
        );

        // Execute second unwrap
        vm.prank(user);
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            user,
            contractBasedNativeToken,
            amount
        );

        // Check that recipient received both amounts
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount * 2
        );
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    function testMultipleWrapOperations() public {
        uint256 amount = 50 ether;

        // Prepare swap data with token address and destination
        bytes memory swapData = abi.encodePacked(
            contractBasedNativeToken,
            recipient
        );

        // Give the facet tokens for both operations
        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            address(contractBasedNativeWrapperFacet),
            amount * 2
        );

        // Execute first wrap
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            amount
        );

        // Execute second wrap
        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            amount
        );

        // Check that recipient received both amounts
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount * 2
        );
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(
                address(contractBasedNativeWrapperFacet)
            ),
            0
        );
    }

    // ==== Gas Tests ====

    function testGasUnwrapContractBasedNative() public {
        uint256 amount = 100 ether;
        bytes memory swapData = abi.encodePacked(recipient);

        vm.prank(user);
        IERC20(contractBasedNativeToken).approve(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        vm.prank(user);
        contractBasedNativeWrapperFacet.unwrapContractBasedNative(
            swapData,
            user,
            contractBasedNativeToken,
            amount
        );

        // Verify the operation succeeded
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount
        );
    }

    function testGasWrapContractBasedNative() public {
        uint256 amount = 100 ether;
        bytes memory swapData = abi.encodePacked(
            contractBasedNativeToken,
            recipient
        );

        MockContractBasedNativeToken(contractBasedNativeToken).mint(
            address(contractBasedNativeWrapperFacet),
            amount
        );

        contractBasedNativeWrapperFacet.wrapContractBasedNative(
            swapData,
            address(0),
            address(0),
            amount
        );

        // Verify the operation succeeded
        assertEq(
            IERC20(contractBasedNativeToken).balanceOf(recipient),
            amount
        );
    }
}

/// @notice Mock contract-based native token for testing
/// @dev Simulates a token with dual-purpose functionality like CELO
contract MockContractBasedNativeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    string public name = "Mock Contract-Based Native Token";
    string public symbol = "MOCK";
    uint8 public decimals = 18;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    error InsufficientBalance();
    error InsufficientAllowance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();

        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (allowance[from][msg.sender] < amount)
            revert InsufficientAllowance();

        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
