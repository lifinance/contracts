// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";

contract WithdrawFacet {
    address private constant NATIVE_ASSET = 0x0000000000000000000000000000000000000000; // address(0)

    event LogWithdraw(address indexed _assetAddress, address _to, uint256 amount);

    /**
     * @dev Withdraw asset.
     * @param _assetAddress Asset to be withdrawn.
     * @param _to address to withdraw to.
     * @param _amount amount of asset to withdraw.
     */
    function withdraw(
        address _assetAddress,
        address _to,
        uint256 _amount
    ) external {
        LibDiamond.enforceIsContractOwner();
        address sendTo = (_to == address(0)) ? msg.sender : _to;
        uint256 assetBalance;
        if (_assetAddress == NATIVE_ASSET) {
            address self = address(this); // workaround for a possible solidity bug
            require(_amount <= self.balance, "Requested amount less than balance.");
            (bool success, ) = payable(sendTo).call{ value: _amount }("");
            require(success, "Transfer failed.");
        } else {
            assetBalance = IERC20(_assetAddress).balanceOf(address(this));
            require(_amount <= assetBalance, "Requested amount less than balance.");
            SafeERC20.safeTransfer(IERC20(_assetAddress), sendTo, _amount);
        }
        emit LogWithdraw(_assetAddress, sendTo, _amount);
    }
}
