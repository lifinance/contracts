pragma solidity ^0.8.17;

contract TransferEventEmitter {
    event TokensTransferred(
        address token,
        address from,
        address to,
        uint256 amount
    );

    function emitTransferEvent(
        address token,
        address from,
        address to,
        uint256 amount
    ) external {
        emit TokensTransferred(token, from, to, amount);
    }
}
