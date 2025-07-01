// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error NoFacetSet();

contract Diamond {
    fallback() external payable {
        address facet = _getFacet();
        if (facet == address(0)) revert NoFacetSet();

        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    function _getFacet() internal view returns (address facet) {
        facet = address(0x1000000000000000000000000000000000000001);
    }
}
