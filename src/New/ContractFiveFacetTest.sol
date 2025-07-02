// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FacetOne {
    address public admin; // slot 0

    function setAdmin(address _admin) external {
        admin = _admin;
    }

    function getAdmin() external view returns (address) {
        return admin;
    }
}
