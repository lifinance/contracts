// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Example Pegged ERC20 token
 */
contract SingleBridgeToken is ERC20, Ownable {
    address public bridge;

    uint8 private immutable _decimals;

    event BridgeUpdated(address bridge);

    modifier onlyBridge() {
        require(msg.sender == bridge, "caller is not bridge");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address bridge_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        bridge = bridge_;
    }

    /**
     * @notice Mints tokens to an address.
     * @param _to The address to mint tokens to.
     * @param _amount The amount to mint.
     */
    function mint(address _to, uint256 _amount) external onlyBridge returns (bool) {
        _mint(_to, _amount);
        return true;
    }

    /**
     * @notice Burns tokens for msg.sender.
     * @param _amount The amount to burn.
     */
    function burn(uint256 _amount) external returns (bool) {
        _burn(msg.sender, _amount);
        return true;
    }

    /**
     * @notice Burns tokens from an address.
     * Alternative to {burnFrom} for compatibility with some bridge implementations.
     * See {_burnFrom}.
     * @param _from The address to burn tokens from.
     * @param _amount The amount to burn.
     */
    function burn(address _from, uint256 _amount) external returns (bool) {
        return _burnFrom(_from, _amount);
    }

    /**
     * @notice Burns tokens from an address.
     * See {_burnFrom}.
     * @param _from The address to burn tokens from.
     * @param _amount The amount to burn.
     */
    function burnFrom(address _from, uint256 _amount) external returns (bool) {
        return _burnFrom(_from, _amount);
    }

    /**
     * @dev Burns tokens from an address, deducting from the caller's allowance.
     * @param _from The address to burn tokens from.
     * @param _amount The amount to burn.
     */
    function _burnFrom(address _from, uint256 _amount) internal returns (bool) {
        _spendAllowance(_from, msg.sender, _amount);
        _burn(_from, _amount);
        return true;
    }

    /**
     * @notice Returns the decimals of the token.
     */
    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Updates the bridge address.
     * @param _bridge The bridge address.
     */
    function updateBridge(address _bridge) external onlyOwner {
        bridge = _bridge;
        emit BridgeUpdated(bridge);
    }

    /**
     * @notice Returns the owner address. Required by BEP20.
     */
    function getOwner() external view returns (address) {
        return owner();
    }
}
