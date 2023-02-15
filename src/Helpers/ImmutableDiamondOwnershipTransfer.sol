// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";

contract ImmutableDiamondOwnershipTransfer {

    /// @notice Transfers ownership of diamond to address(0) (for immutable diamond)
    function transferOwnershipToZeroAddress() external  {
        // transfer ownership to 0 address
        LibDiamond.setContractOwner(address(0));
    }

}
