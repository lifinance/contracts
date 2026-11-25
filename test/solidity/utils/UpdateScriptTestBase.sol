// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

/// @dev Base for tests that run a deploy/update script's own JSON read through a harness
///      inheriting the script
abstract contract UpdateScriptTestBase is Test {
    uint256 internal constant MAINNET_CHAIN_ID = 1;
    /// @dev LibAsset.isContract counts an address as a contract only above 23 bytes of code
    uint256 internal constant MIN_CONTRACT_CODE_SIZE = 24;

    /// @dev Call before deploying a harness: the script base reads these in its constructor.
    ///      Every suite sets the same values, because forge shares process env across suites.
    function _setMainnetScriptEnv() internal {
        vm.chainId(MAINNET_CHAIN_ID);

        vm.setEnv("NETWORK", "mainnet");
        vm.setEnv("FILE_SUFFIX", "");
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(uint256(1))));
        vm.setEnv("USE_DEF_DIAMOND", "true");
    }

    /// @return args The ABI-encoded arguments of `_callData`, once its selector is checked
    function _initArgs(bytes memory _callData, bytes4 _expectedSelector)
        internal
        pure
        returns (bytes memory args)
    {
        assertEq(bytes4(_callData), _expectedSelector);

        args = new bytes(_callData.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = _callData[i + 4];
        }
    }
}
