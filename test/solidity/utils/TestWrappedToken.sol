// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import "solmate/tokens/ERC20.sol";

contract TestWrappedToken is ERC20 {
    error WithdrawError();

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) ERC20(_name, _symbol, _decimals) {}

    function mint(address _to, uint256 _amount) public {
        _mint(_to, _amount);
    }

    function burn(address _from, uint256 _amount) public {
        _burn(_from, _amount);
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        (bool success, ) = payable(msg.sender).call{ value: wad }("");
        if (!success) {
            revert WithdrawError();
        }
    }
}
