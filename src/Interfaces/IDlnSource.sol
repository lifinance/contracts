// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface IDlnSource {
    struct OrderCreation {
        // the address of the ERC-20 token you are giving;
        // use the zero address to indicate you are giving a native blockchain token (ether, matic, etc).
        address giveTokenAddress;
        // the amount of tokens you are giving
        uint256 giveAmount;
        // the address of the ERC-20 token you are willing to take on the destination chain
        bytes takeTokenAddress;
        // the amount of tokens you are willing to take on the destination chain
        uint256 takeAmount;
        // the ID of the chain where an order should be fulfilled.
        // Use the list of supported chains mentioned above
        uint256 takeChainId;
        // the address on the destination chain where the funds
        // should be sent to upon order fulfillment
        bytes receiverDst;
        // the address on the source (current) chain who is allowed to patch the order
        // giving more input tokens and thus making the order more attractive to takers, just in case
        address givePatchAuthoritySrc;
        // the address on the destination chain who is allowed to patch the order
        // decreasing the take amount and thus making the order more attractive to takers, just in case
        bytes orderAuthorityAddressDst;
        // an optional address restricting anyone in the open market from fulfilling
        // this order but the given address. This can be useful if you are creating a order
        //  for a specific taker. By default, set to empty bytes array (0x)
        bytes allowedTakerDst; // *optional
        // set to an empty bytes array (0x)
        bytes externalCall; // N/A, *optional
        // an optional address on the source (current) chain where the given input tokens
        // would be transferred to in case order cancellation is initiated by the orderAuthorityAddressDst
        // on the destination chain. This property can be safely set to an empty bytes array (0x):
        // in this case, tokens would be transferred to the arbitrary address specified
        // by the orderAuthorityAddressDst upon order cancellation
        bytes allowedCancelBeneficiarySrc; // *optional
    }

    function globalFixedNativeFee() external returns (uint256);

    function createOrder(
        OrderCreation calldata _orderCreation,
        bytes calldata _affiliateFee,
        uint32 _referralCode,
        bytes calldata _permitEnvelope
    ) external payable returns (bytes32 orderId);
}
