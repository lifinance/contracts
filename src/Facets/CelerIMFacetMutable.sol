// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { CelerIMFacetBase, IMessageBus, MsgDataTypes, IERC20, CelerIM } from "../Helpers/CelerIMFacetBase.sol";

/// @title CelerIMFacetMutable
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging tokens and data through CBridge
/// @notice This contract is exclusively used for mutable diamond contracts
/// @custom:version 2.0.0
contract CelerIMFacetMutable is CelerIMFacetBase {
    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _messageBus The contract address of the cBridge Message Bus
    /// @param _relayerOwner The address that will become the owner of the RelayerCelerIM contract
    /// @param _diamondAddress The address of the diamond contract that will be connected with the RelayerCelerIM
    /// @param _cfUSDC The contract address of the Celer Flow USDC
    constructor(
        IMessageBus _messageBus,
        address _relayerOwner,
        address _diamondAddress,
        address _cfUSDC
    ) CelerIMFacetBase(_messageBus, _relayerOwner, _diamondAddress, _cfUSDC) {}
}
