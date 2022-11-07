// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../safeguard/Ownable.sol";

/**
 * @title Example Multi-Bridge Pegged ERC20 token
 */
contract MultiBridgeToken is ERC20, Ownable {
    struct Supply {
        uint256 cap;
        uint256 total;
    }
    mapping(address => Supply) public bridges; // bridge address -> supply

    uint8 private immutable _decimals;

    event BridgeSupplyCapUpdated(address bridge, uint256 supplyCap);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    /**
     * @notice Mints tokens to an address. Increases total amount minted by the calling bridge.
     * @param _to The address to mint tokens to.
     * @param _amount The amount to mint.
     */
    function mint(address _to, uint256 _amount) external returns (bool) {
        Supply storage b = bridges[msg.sender];
        require(b.cap > 0, "invalid caller");
        b.total += _amount;
        require(b.total <= b.cap, "exceeds bridge supply cap");
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
     * @notice Burns tokens from an address. Decreases total amount minted if called by a bridge.
     * Alternative to {burnFrom} for compatibility with some bridge implementations.
     * See {_burnFrom}.
     * @param _from The address to burn tokens from.
     * @param _amount The amount to burn.
     */
    function burn(address _from, uint256 _amount) external returns (bool) {
        return _burnFrom(_from, _amount);
    }

    /**
     * @notice Burns tokens from an address. Decreases total amount minted if called by a bridge.
     * See {_burnFrom}.
     * @param _from The address to burn tokens from.
     * @param _amount The amount to burn.
     */
    function burnFrom(address _from, uint256 _amount) external returns (bool) {
        return _burnFrom(_from, _amount);
    }

    /**
     * @dev Burns tokens from an address, deducting from the caller's allowance.
     *      Decreases total amount minted if called by a bridge.
     * @param _from The address to burn tokens from.
     * @param _amount The amount to burn.
     */
    function _burnFrom(address _from, uint256 _amount) internal returns (bool) {
        Supply storage b = bridges[msg.sender];
        if (b.cap > 0 || b.total > 0) {
            // set cap to 1 would effectively disable a deprecated bridge's ability to burn
            require(b.total >= _amount, "exceeds bridge minted amount");
            unchecked {
                b.total -= _amount;
            }
        }
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
     * @notice Updates the supply cap for a bridge.
     * @param _bridge The bridge address.
     * @param _cap The new supply cap.
     */
    function updateBridgeSupplyCap(address _bridge, uint256 _cap) external onlyOwner {
        // cap == 0 means revoking bridge role
        bridges[_bridge].cap = _cap;
        emit BridgeSupplyCapUpdated(_bridge, _cap);
    }

    /**
     * @notice Returns the owner address. Required by BEP20.
     */
    function getOwner() external view returns (address) {
        return owner();
    }
}
