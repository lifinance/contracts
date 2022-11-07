// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

// used for pegged token with openzeppelin ERC20Burnable interface
// only compatible with PeggedTokenBridgeV2
interface IPeggedTokenBurnFrom {
    function mint(address _to, uint256 _amount) external;

    function burnFrom(address _from, uint256 _amount) external;
}
