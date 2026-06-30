// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPaxosTransit } from "lifi/Interfaces/IPaxosTransit.sol";

/// @notice Minimal mock of the Paxos Transit station for facet unit tests.
///         Mirrors the real submitOrder funds flow: pulls offerAmount of offerAsset
///         from the caller (the Diamond) and records the forwarded native (LayerZero) fee.
contract MockTransitStation is IPaxosTransit {
    error OfferAssetPullFailed();

    event OrderSubmitted(
        bytes32 indexed uuid,
        address offerAsset,
        uint256 offerAmount,
        address receiver,
        uint256 nativeFee
    );

    uint256 public lastNativeFee;
    bytes32 public lastUuid;

    function submitOrder(
        Quote calldata quote,
        bytes calldata
    ) external payable override returns (bytes32 uuid) {
        if (
            !IERC20(quote.route.offerAsset).transferFrom(
                msg.sender,
                address(this),
                quote.offerAmount
            )
        ) {
            revert OfferAssetPullFailed();
        }

        lastNativeFee = msg.value;
        uuid = quote.salt;
        lastUuid = uuid;

        emit OrderSubmitted(
            uuid,
            quote.route.offerAsset,
            quote.offerAmount,
            quote.receiver,
            msg.value
        );
    }
}
