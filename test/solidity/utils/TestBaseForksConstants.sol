// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

abstract contract TestBaseForksConstants {
    // Forking
    uint256 internal constant DEFAULT_BLOCK_NUMBER_MAINNET = 15588208;

    // WALLET ADDRESSES (all networks)
    address internal constant REFUND_WALLET =
        0x317F8d18FB16E49a958Becd0EA72f8E153d25654;
    address internal constant WITHDRAW_WALLET =
        0x08647cc950813966142A416D40C382e2c5DB73bB;

    // Contract addresses (MAINNET)
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_UNISWAP =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_WRAPPED_NATIVE =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // Contract addresses (ARBITRUM)
    address internal constant ADDRESS_UNISWAP_ARB =
        0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant ADDRESS_SUSHISWAP_ARB =
        0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address internal constant ADDRESS_USDC_ARB =
        0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address internal constant ADDRESS_USDT_ARB =
        0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address internal constant ADDRESS_DAI_ARB =
        0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant ADDRESS_WRAPPED_NATIVE_ARB =
        0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    // Contract addresses (POLYGON)
    address internal constant ADDRESS_UNISWAP_POL =
        0xedf6066a2b290C185783862C7F4776A2C8077AD1;
    address internal constant ADDRESS_SUSHISWAP_POL =
        0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address internal constant ADDRESS_USDC_POL =
        0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359; // Circle USDC, decimals: 6
    address internal constant ADDRESS_USDCE_POL =
        0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174; // USDC.e
    address internal constant ADDRESS_USDT_POL =
        0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    address internal constant ADDRESS_DAI_POL =
        0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063;
    address internal constant ADDRESS_WETH_POL =
        0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
    address internal constant ADDRESS_WRAPPED_NATIVE_POL =
        0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270; // WMATIC
    // Contract addresses (BASE)
    address internal constant ADDRESS_UNISWAP_BASE =
        0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address internal constant ADDRESS_USDC_BASE =
        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant ADDRESS_USDT_BASE =
        0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant ADDRESS_DAI_BASE =
        0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address internal constant ADDRESS_WRAPPED_NATIVE_BASE =
        0x4200000000000000000000000000000000000006;
    // Contract addresses (OPTIMISM)
    address internal constant ADDRESS_UNISWAP_OPTIMISM =
        0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2;
    address internal constant ADDRESS_USDC_OPTIMISM =
        0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address internal constant ADDRESS_USDT_OPTIMISM =
        0x94b008aA00579c1307B0EF2c499aD98a8ce58e58;
    address internal constant ADDRESS_DAI_OPTIMISM =
        0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant ADDRESS_WRAPPED_NATIVE_OPTIMISM =
        0x4200000000000000000000000000000000000006;
    // User accounts (Whales: ETH only)
    address internal constant USER_USDC_WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
    address internal constant USER_DAI_WHALE =
        0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;
    address internal constant USER_WETH_WHALE =
        0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E;
}
