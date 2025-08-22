// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

contract AcrossFacetV4OutputAmountTest is Test {
    /// @notice Test the current output amount calculation formula
    function test_CurrentFormulaIssues() public {
        // Current formula: (minAmount * outputAmountMultiplier) / 1e30

        // Test case 1: 6 decimal input to 6 decimal output
        uint256 minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)

        uint256 result = (minAmount * multiplier) / 1e30;
        // result = (99 * 10^6 * 1e18) / 1e30 = 99 * 10^-6 = 0.000099
        // This is wrong! We want 99 * 10^6

        assertEq(
            result,
            0,
            "Current formula gives wrong result for 6->6 conversion"
        );

        // Test case 2: 6 decimal input to 18 decimal output
        minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)

        result = (minAmount * multiplier) / 1e30;
        // result = (99 * 10^6 * 1e30) / 1e30 = 99 * 10^6
        // This is wrong! We want 99 * 10^18

        assertEq(
            result,
            99 * 10 ** 6,
            "Current formula gives wrong result for 6->18 conversion"
        );

        // Test case 3: 18 decimal input to 6 decimal output
        minAmount = 99 * 10 ** 18; // 99 tokens (18 decimals)
        multiplier = 1000000; // 1e6 (100% / 1e12)

        result = (minAmount * multiplier) / 1e30;
        // result = (99 * 10^18 * 1e6) / 1e30 = 99 * 10^-6
        // This is wrong! We want 99 * 10^6

        assertEq(
            result,
            0,
            "Current formula gives wrong result for 18->6 conversion"
        );
    }

    /// @notice Test the alternative calculation approach
    function test_AlternativeFormula() public {
        // Alternative formula: (minAmount * outputAmountMultiplier) / 1e18

        // Test case 1: 6 decimal input to 6 decimal output
        uint256 minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)

        uint256 result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^6 * 1e18) / 1e18 = 99 * 10^6
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 6,
            "Alternative formula works for 6->6 conversion"
        );

        // Test case 2: 6 decimal input to 18 decimal output
        minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^6 * 1e30) / 1e18 = 99 * 10^18
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 18,
            "Alternative formula works for 6->18 conversion"
        );

        // Test case 3: 18 decimal input to 6 decimal output
        minAmount = 99 * 10 ** 18; // 99 tokens (18 decimals)
        multiplier = 1000000; // 1e6 (100% / 1e12)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^18 * 1e6) / 1e18 = 99 * 10^6
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 6,
            "Alternative formula works for 18->6 conversion"
        );
    }

    /// @notice Test edge cases with very small and very large amounts
    function test_EdgeCases() public {
        // Test with very small amounts
        uint256 minAmount = 1; // 1 wei
        uint256 multiplier = 1000000000000000000; // 1e18

        uint256 result = (minAmount * multiplier) / 1e30;
        assertEq(
            result,
            0,
            "Very small amounts result in 0 with current formula"
        );

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            1,
            "Very small amounts work correctly with alternative formula"
        );

        // Test with very large amounts
        minAmount = 1000000 * 10 ** 18; // 1M tokens
        multiplier = 1000000000000000000; // 1e18

        result = (minAmount * multiplier) / 1e30;
        assertEq(
            result,
            1000000 * 10 ** 6,
            "Large amounts give wrong result with current formula"
        );

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            1000000 * 10 ** 18,
            "Large amounts work correctly with alternative formula"
        );
    }

    /// @notice Demonstrate the user's suggestion about dividing by 1e6
    function test_UserSuggestion() public {
        // User's suggestion: divide by 1e6 and adjust multiplier accordingly

        // For 6->6 conversion:
        uint256 minAmount = 99 * 10 ** 6;
        uint256 multiplier = 1000000000000000000; // 1e18 (normal 100%)

        uint256 result = (minAmount * multiplier) / 1e6;
        // result = (99 * 10^6 * 1e18) / 1e6 = 99 * 10^18
        // This is wrong! We want 99 * 10^6

        assertEq(
            result,
            99 * 10 ** 18,
            "User's suggestion gives wrong result for 6->6"
        );

        // For 18->6 conversion:
        minAmount = 99 * 10 ** 18;
        multiplier = 1000000000000000000; // 1e18 (normal 100%)

        result = (minAmount * multiplier) / 1e6;
        // result = (99 * 10^18 * 1e18) / 1e6 = 99 * 10^30
        // This is wrong! We want 99 * 10^6

        assertEq(
            result,
            99 * 10 ** 30,
            "User's suggestion gives wrong result for 18->6"
        );

        // The user's suggestion would work if we adjust the multiplier:
        // For 6->6: multiplier = 1e6, divide by 1e6
        // For 18->6: multiplier = 1e6, divide by 1e6
        // For 6->18: multiplier = 1e30, divide by 1e6

        // But this approach is inconsistent and doesn't scale well
    }

    /// @notice Test the alternative approach where 100% = 1e6 and we divide by 1e6
    function test_AlternativeApproach100PercentEquals1e6() public {
        // Alternative approach: 100% = 1e6, divide by 1e6

        // Test case 1: 6 decimal input to 6 decimal output
        uint256 minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        uint256 multiplier = 1000000; // 1e6 (100% in this system)

        uint256 result = (minAmount * multiplier) / 1e6;
        // result = (99 * 10^6 * 1e6) / 1e6 = 99 * 10^6
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 6,
            "Alternative approach works for 6->6 conversion"
        );

        // Test case 2: 6 decimal input to 18 decimal output
        minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        multiplier = 1000000000000000000; // 1e18 (100% * 1e12 for 6->18)

        result = (minAmount * multiplier) / 1e6;
        // result = (99 * 10^6 * 1e18) / 1e6 = 99 * 10^18
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 18,
            "Alternative approach works for 6->18 conversion"
        );

        // Test case 3: 18 decimal input to 6 decimal output
        minAmount = 99 * 10 ** 18; // 99 tokens (18 decimals)
        multiplier = 1; // 1 (100% / 1e6 for 18->6)

        result = (minAmount * multiplier) / 1e6;
        // result = (99 * 10^18 * 1) / 1e6 = 99 * 10^12
        // This is wrong! We want 99 * 10^6

        assertEq(
            result,
            99 * 10 ** 12,
            "Alternative approach gives wrong result for 18->6 conversion"
        );

        // Let's try with the correct multiplier for 18->6:
        multiplier = 1; // 1 (100% / 1e12 for 18->6)

        result = (minAmount * multiplier) / 1e6;
        // result = (99 * 10^18 * 1) / 1e6 = 99 * 10^12
        // Still wrong! We need a different approach

        // The issue is that for 18->6, we need to divide by 1e12, not 1e6
        // So this approach doesn't work consistently
    }

    /// @notice Test the universal approach that handles all cases consistently
    function test_UniversalApproach() public {
        // Universal approach: Always divide by 1e18 and adjust multiplier accordingly

        // Test case 1: 6 decimal input to 6 decimal output
        uint256 minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)

        uint256 result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^6 * 1e18) / 1e18 = 99 * 10^6
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 6,
            "Universal approach works for 6->6 conversion"
        );

        // Test case 2: 6 decimal input to 18 decimal output
        minAmount = 99 * 10 ** 6; // 99 USDC (6 decimals)
        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^6 * 1e30) / 1e18 = 99 * 10^18
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 18,
            "Universal approach works for 6->18 conversion"
        );

        // Test case 3: 18 decimal input to 6 decimal output
        minAmount = 99 * 10 ** 18; // 99 tokens (18 decimals)
        multiplier = 1000000; // 1e6 (100% / 1e12)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^18 * 1e6) / 1e18 = 99 * 10^6
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 6,
            "Universal approach works for 18->6 conversion"
        );

        // Test case 4: 18 decimal input to 18 decimal output
        minAmount = 99 * 10 ** 18; // 99 tokens (18 decimals)
        multiplier = 1000000000000000000; // 1e18 (100%)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^18 * 1e18) / 1e18 = 99 * 10^18
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 18,
            "Universal approach works for 18->18 conversion"
        );

        // Test case 5: 8 decimal input to 6 decimal output (e.g., USDT to USDC)
        minAmount = 99 * 10 ** 8; // 99 USDT (8 decimals)
        multiplier = 100000000000000000000; // 1e20 (100% * 1e2)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^8 * 1e20) / 1e18 = 99 * 10^10
        // Wait, this is wrong! We want 99 * 10^6

        // Let me correct this:
        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^8 * 1e30) / 1e18 = 99 * 10^20
        // Still wrong! Let me think about this...

        // For 8->6 conversion, we need to reduce by 2 decimals
        // So multiplier should be 1e16 (100% / 1e2)
        multiplier = 10000000000000000; // 1e16 (100% / 1e2)

        result = (minAmount * multiplier) / 1e18;
        // result = (99 * 10^8 * 1e16) / 1e18 = 99 * 10^6
        // This is correct!

        assertEq(
            result,
            99 * 10 ** 6,
            "Universal approach works for 8->6 conversion"
        );
    }

    /// @notice Test the universal multiplier calculation formula
    function test_UniversalMultiplierFormula() public {
        // Universal formula: multiplier = 1e18 * (10^(outputDecimals - inputDecimals))

        // Test 6->6: multiplier = 1e18 * 10^(6-6) = 1e18 * 10^0 = 1e18
        uint256 multiplier = 1000000000000000000; // 1e18
        uint256 minAmount = 99 * 10 ** 6;
        uint256 result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 6, "6->6 conversion works");

        // Test 6->18: multiplier = 1e18 * 10^(18-6) = 1e18 * 10^12 = 1e30
        multiplier = 1000000000000000000000000000000; // 1e30
        minAmount = 99 * 10 ** 6;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 18, "6->18 conversion works");

        // Test 18->6: multiplier = 1e18 * 10^(6-18) = 1e18 * 10^(-12) = 1e6
        multiplier = 1000000; // 1e6
        minAmount = 99 * 10 ** 18;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 6, "18->6 conversion works");

        // Test 8->6: multiplier = 1e18 * 10^(6-8) = 1e18 * 10^(-2) = 1e16
        multiplier = 10000000000000000; // 1e16
        minAmount = 99 * 10 ** 8;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 6, "8->6 conversion works");

        // Test 6->8: multiplier = 1e18 * 10^(8-6) = 1e18 * 10^2 = 1e20
        multiplier = 100000000000000000000; // 1e20
        minAmount = 99 * 10 ** 6;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 8, "6->8 conversion works");
    }

    /// @notice Test edge cases with the universal approach
    function test_UniversalApproachEdgeCases() public {
        // Test with very small amounts
        uint256 minAmount = 1; // 1 wei
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)

        uint256 result = (minAmount * multiplier) / 1e18;
        assertEq(result, 1, "Very small amounts work correctly");

        // Test with very large amounts
        minAmount = 1000000 * 10 ** 18; // 1M tokens
        multiplier = 1000000000000000000; // 1e18 (100%)

        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 1000000 * 10 ** 18, "Large amounts work correctly");

        // Test with 50% multiplier
        minAmount = 100 * 10 ** 6; // 100 USDC
        multiplier = 500000000000000000; // 5e17 (50%)

        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 50 * 10 ** 6, "50% multiplier works correctly");

        // Test with 200% multiplier
        minAmount = 100 * 10 ** 6; // 100 USDC
        multiplier = 2000000000000000000; // 2e18 (200%)

        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 200 * 10 ** 6, "200% multiplier works correctly");

        // Test with maximum multiplier (type(uint128).max)
        minAmount = 100 * 10 ** 6; // 100 USDC
        multiplier = type(uint128).max;

        result = (minAmount * multiplier) / 1e18;
        // This should work without overflow
        assertGt(result, 0, "Maximum multiplier works without overflow");
    }

    /// @notice Test all possible decimal combinations
    function test_AllDecimalCombinations() public {
        // Test all combinations from 0 to 18 decimals
        uint8[] memory decimals = new uint8[](4);
        decimals[0] = 6; // USDC, USDT
        decimals[1] = 8; // USDT (some implementations)
        decimals[2] = 18; // ETH, most ERC20s
        decimals[3] = 0; // Some tokens have 0 decimals

        for (uint256 i = 0; i < decimals.length; i++) {
            for (uint256 j = 0; j < decimals.length; j++) {
                uint8 inputDecimals = decimals[i];
                uint8 outputDecimals = decimals[j];

                uint256 minAmount = 99 * 10 ** inputDecimals;

                // Calculate multiplier: 1e18 * 10^(outputDecimals - inputDecimals)
                uint256 multiplier;

                if (outputDecimals >= inputDecimals) {
                    uint256 decimalDiff = outputDecimals - inputDecimals;
                    multiplier = 1000000000000000000 * (10 ** decimalDiff);
                } else {
                    uint256 decimalDiff = inputDecimals - outputDecimals;
                    multiplier = 1000000000000000000 / (10 ** decimalDiff);
                }

                uint256 result = (minAmount * multiplier) / 1e18;
                uint256 expected = 99 * 10 ** outputDecimals;

                assertEq(
                    result,
                    expected,
                    string(
                        abi.encodePacked(
                            "Conversion from ",
                            uint256(inputDecimals),
                            " to ",
                            uint256(outputDecimals),
                            " decimals failed"
                        )
                    )
                );
            }
        }
    }
}
