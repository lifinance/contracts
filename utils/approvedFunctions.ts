const TRAILING_56_NIBBLES = '0'.repeat(56)

export default [
  '0xa5be382e', // swapExactETHForTokens(uint256,uint256,address[],address,uint256)
  '0xfc374157', // swapETHForExactTokens(uint256,uint256,address[],address,uint256)
  '0x18cbafe5', // swapExactTokensForETH(uint256,uint256,address[],address,uint256)
  '0x4a25d94a', // swapTokensForExactETH(uint256,uint256,address[],address,uint256)
  '0x38ed1739', // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
  '0x8803dbee', // swapTokensForExactTokens(uint256,uint256,address[],address,uint256)
  '0x7c025200', // swap(address,(address,address,address,address,uint256,uint256,uint256,bytes),bytes)
  '0x7617b389', // ??
  '0x90411a32', // swap(address,(address,address,address,address,uint256,uint256,uint256,uint256,address,bytes),(uint256,uint256,uint256,bytes)[])
  '0x54e3f31b', // simpleSwap((address,address,uint256,uint256,uint256,address[],bytes,uint256[],uint256[],address,address,uint256,bytes,uint256,bytes16))
  '0x415565b0', // transformERC20(address,address,uint256,uint256,(uint32,bytes)[])
  '0xc43c9ef6', // sellToPancakeSwap(address[],uint256,uint256,uint8)
  '0xfb3bdb41', // swapETHForExactTokens(uint256,address[],address,uint256)
  '0xdb3e2198', // exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
  '0x91695586', // swap(uint8,uint8,uint256,uint256,uint256)
].map((hex) => `${hex}${TRAILING_56_NIBBLES}`)
