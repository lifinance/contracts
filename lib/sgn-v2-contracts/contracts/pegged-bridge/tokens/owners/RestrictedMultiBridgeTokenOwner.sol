// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "../../../safeguard/Ownable.sol";

interface IMultiBridgeToken {
    function updateBridgeSupplyCap(address _bridge, uint256 _cap) external;
}

// restrict multi-bridge token to effectively only have one bridge (minter)
contract RestrictedMultiBridgeTokenOwner is Ownable {
    address public immutable token;
    address public bridge;

    constructor(address _token, address _bridge) {
        token = _token;
        bridge = _bridge;
    }

    function updateBridgeSupplyCap(uint256 _cap) external onlyOwner {
        IMultiBridgeToken(token).updateBridgeSupplyCap(bridge, _cap);
    }

    function changeBridge(address _bridge, uint256 _cap) external onlyOwner {
        // set previous bridge cap to 1 to disable mint but still allow burn
        // till its total supply becomes zero
        IMultiBridgeToken(token).updateBridgeSupplyCap(bridge, 1);
        // set new bridge and cap
        IMultiBridgeToken(token).updateBridgeSupplyCap(_bridge, _cap);
        bridge = _bridge;
    }

    function revokeBridge(address _bridge) external onlyOwner {
        // set previous bridge cap to 0 to disable both mint and burn
        IMultiBridgeToken(token).updateBridgeSupplyCap(_bridge, 0);
    }
}
