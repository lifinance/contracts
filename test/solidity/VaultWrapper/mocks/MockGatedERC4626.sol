// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";

/// @notice ERC-4626 vault with its own depositor whitelist, standing in for an
///         access-gated underlying: deposits from a non-whitelisted caller (e.g. a
///         wrapper the vault's operator has not onboarded) revert with a vault-specific
///         error the wrapper must bubble up verbatim.
contract MockGatedERC4626 is MockERC4626 {
    error DepositorNotWhitelisted(address depositor);

    mapping(address => bool) public whitelisted;

    constructor(ERC20 _asset) MockERC4626(_asset, "Gated Yield", "gyTKN") {}

    function setWhitelisted(address _account, bool _whitelisted) external {
        whitelisted[_account] = _whitelisted;
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override returns (uint256) {
        if (!whitelisted[msg.sender])
            revert DepositorNotWhitelisted(msg.sender);

        return super.deposit(assets, receiver);
    }
}
