// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

contract AcrossFacetV4OutputAmountTest is Test {
    /// @notice Test the current output amount calculation formula
    function test_CurrentFormulaIssues() public {
        uint256 minAmount = 99 * 10 ** 6;
        uint256 multiplier = 1000000000000000000;

        uint256 result = (minAmount * multiplier) / 1e30;
        assertEq(
            result,
            0,
            "Current formula gives wrong result for 6->6 conversion"
        );

        minAmount = 99 * 10 ** 6;
        multiplier = 1000000000000000000000000000000;

        result = (minAmount * multiplier) / 1e30;
        assertEq(
            result,
            99 * 10 ** 6,
            "Current formula gives wrong result for 6->18 conversion"
        );

        minAmount = 99 * 10 ** 18;
        multiplier = 1000000;

        result = (minAmount * multiplier) / 1e30;
        assertEq(
            result,
            0,
            "Current formula gives wrong result for 18->6 conversion"
        );
    }

    /// @notice Test the alternative calculation approach
    function test_AlternativeFormula() public {
        uint256 minAmount = 99 * 10 ** 6;
        uint256 multiplier = 1000000000000000000;

        uint256 result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 6,
            "Alternative formula works for 6->6 conversion"
        );

        minAmount = 99 * 10 ** 6;
        multiplier = 1000000000000000000000000000000;

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 18,
            "Alternative formula works for 6->18 conversion"
        );

        minAmount = 99 * 10 ** 18;
        multiplier = 1000000;

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 6,
            "Alternative formula works for 18->6 conversion"
        );
    }

    /// @notice Test edge cases with very small and very large amounts
    function test_EdgeCases() public {
        uint256 minAmount = 1;
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)

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

        minAmount = 1000000 * 10 ** 18;
        multiplier = 1000000000000000000; // 1e18 (100%)

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
        uint256 minAmount = 99 * 10 ** 6;
        uint256 multiplier = 1000000000000000000;

        uint256 result = (minAmount * multiplier) / 1e6;
        assertEq(
            result,
            99 * 10 ** 18,
            "User's suggestion gives wrong result for 6->6"
        );

        minAmount = 99 * 10 ** 18;
        multiplier = 1000000000000000000;

        result = (minAmount * multiplier) / 1e6;
        assertEq(
            result,
            99 * 10 ** 30,
            "User's suggestion gives wrong result for 18->6"
        );
    }

    /// @notice Test the alternative approach where 100% = 1e6 and we divide by 1e6
    function test_AlternativeApproach100PercentEquals1e6() public {
        uint256 minAmount = 99 * 10 ** 6;
        uint256 multiplier = 1000000; // 1e6 (100% in this system)

        uint256 result = (minAmount * multiplier) / 1e6;
        assertEq(
            result,
            99 * 10 ** 6,
            "Alternative approach works for 6->6 conversion"
        );

        minAmount = 99 * 10 ** 6;
        multiplier = 1000000000000000000; // 1e18 (100% * 1e12 for 6->18)

        result = (minAmount * multiplier) / 1e6;
        assertEq(
            result,
            99 * 10 ** 18,
            "Alternative approach works for 6->18 conversion"
        );

        minAmount = 99 * 10 ** 18;
        multiplier = 1; // 1 (100% / 1e12 for 18->6)

        result = (minAmount * multiplier) / 1e6;
        assertEq(
            result,
            99 * 10 ** 12,
            "Alternative approach gives wrong result for 18->6 conversion"
        );
    }

    /// @notice Test the universal approach that handles all cases consistently
    function test_UniversalApproach() public {
        uint256 minAmount = 99 * 10 ** 6;
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)

        uint256 result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 6,
            "Universal approach works for 6->6 conversion"
        );

        minAmount = 99 * 10 ** 6;
        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 18,
            "Universal approach works for 6->18 conversion"
        );

        minAmount = 99 * 10 ** 18;
        multiplier = 1000000; // 1e6 (100% / 1e12)

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 6,
            "Universal approach works for 18->6 conversion"
        );

        minAmount = 99 * 10 ** 18;
        multiplier = 1000000000000000000; // 1e18 (100%)

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 18,
            "Universal approach works for 18->18 conversion"
        );

        minAmount = 99 * 10 ** 8;
        multiplier = 10000000000000000; // 1e16 (100% / 1e2)

        result = (minAmount * multiplier) / 1e18;
        assertEq(
            result,
            99 * 10 ** 6,
            "Universal approach works for 8->6 conversion"
        );
    }

    /// @notice Test the universal multiplier calculation formula
    function test_UniversalMultiplierFormula() public {
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)
        uint256 minAmount = 99 * 10 ** 6;
        uint256 result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 6, "6->6 conversion works");

        multiplier = 1000000000000000000000000000000; // 1e30 (100% * 1e12)
        minAmount = 99 * 10 ** 6;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 18, "6->18 conversion works");

        multiplier = 1000000; // 1e6 (100% / 1e12)
        minAmount = 99 * 10 ** 18;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 6, "18->6 conversion works");

        multiplier = 10000000000000000; // 1e16 (100% / 1e2)
        minAmount = 99 * 10 ** 8;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 6, "8->6 conversion works");

        multiplier = 100000000000000000000; // 1e20 (100% * 1e2)
        minAmount = 99 * 10 ** 6;
        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 99 * 10 ** 8, "6->8 conversion works");
    }

    /// @notice Test edge cases with the universal approach
    function test_UniversalApproachEdgeCases() public {
        uint256 minAmount = 1;
        uint256 multiplier = 1000000000000000000; // 1e18 (100%)

        uint256 result = (minAmount * multiplier) / 1e18;
        assertEq(result, 1, "Very small amounts work correctly");

        minAmount = 1000000 * 10 ** 18;
        multiplier = 1000000000000000000; // 1e18 (100%)

        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 1000000 * 10 ** 18, "Large amounts work correctly");

        minAmount = 100 * 10 ** 6;
        multiplier = 500000000000000000; // 5e17 (50%)

        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 50 * 10 ** 6, "50% multiplier works correctly");

        minAmount = 100 * 10 ** 6;
        multiplier = 2000000000000000000; // 2e18 (200%)

        result = (minAmount * multiplier) / 1e18;
        assertEq(result, 200 * 10 ** 6, "200% multiplier works correctly");

        minAmount = 100 * 10 ** 6;
        multiplier = type(uint128).max;

        result = (minAmount * multiplier) / 1e18;
        assertGt(result, 0, "Maximum multiplier works without overflow");
    }

    /// @notice Test all possible decimal combinations
    function test_AllDecimalCombinations() public {
        uint8[] memory decimals = new uint8[](4);
        decimals[0] = 6;
        decimals[1] = 8;
        decimals[2] = 18;
        decimals[3] = 0;

        for (uint256 i = 0; i < decimals.length; i++) {
            for (uint256 j = 0; j < decimals.length; j++) {
                uint8 inputDecimals = decimals[i];
                uint8 outputDecimals = decimals[j];

                uint256 minAmount = 99 * 10 ** inputDecimals;
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
