// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

struct MandateOutput {
    /// @dev Oracle implementation responsible for collecting the proof from settler on output chain.
    bytes32 oracle;
    /// @dev Output Settler on the output chain responsible for settling the output payment.
    bytes32 settler;
    uint256 chainId;
    bytes32 token;
    uint256 amount;
    bytes32 recipient;
    /// @dev Data that will be delivered to recipient through the settlement callback on the output chain. Can be used
    /// to schedule additional actions.
    bytes call;
    /// @dev Additional output context for the output settlement, encoding order types or other information.
    bytes context;
}

struct StandardOrder {
    address user;
    uint256 nonce;
    uint256 originChainId;
    uint32 expires;
    uint32 fillDeadline;
    address localOracle;
    uint256[2][] inputs;
    MandateOutput[] outputs;
}

interface IBroadcastableSettler {
    function broadcast(StandardOrder calldata order) external;
}
