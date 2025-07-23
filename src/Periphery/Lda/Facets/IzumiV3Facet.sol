// src/Periphery/Lda/Facets/IzumiV3Facet.sol
contract IzumiV3Facet {
    using LibInputStream for uint256;
    using LibCallbackManager for *;

    function swapIzumiV3(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        // Move IzumiV3 swap logic here
    }

    function swapX2YCallback(uint256 amountX, bytes calldata data) external {
        LibCallbackManager.verifyCallbackSender();
        _handleIzumiV3SwapCallback(amountX, data);
        LibCallbackManager.clear();
    }

    function swapY2XCallback(uint256 amountY, bytes calldata data) external {
        LibCallbackManager.verifyCallbackSender();
        _handleIzumiV3SwapCallback(amountY, data);
        LibCallbackManager.clear();
    }
}