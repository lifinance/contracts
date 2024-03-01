// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IRoninBridgeGateway {
    enum Standard {
        ERC20,
        ERC721
    }

    /// @dev For ERC20:  the id must be 0 and the quantity is larger than 0.
    ///      For ERC721: the quantity must be 0.
    /// @param erc The standard of asset to bridge.
    /// @param id The id of asset if it's ERC721.
    /// @param quantity The amount of asset if it's ERC20.
    struct Info {
        Standard erc;
        uint256 id;
        uint256 quantity;
    }

    /// @param recipientAddr Recipient address on Ronin network.
    /// @param tokenAddr Token address to bridge.
    /// @param info Details of token to bridge.
    struct Request {
        address recipientAddr;
        address tokenAddr;
        Info info;
    }

    /// @notice Locks the assets and request deposit.
    /// @param _request Details of request.
    function requestDepositFor(Request calldata _request) external payable;
}
