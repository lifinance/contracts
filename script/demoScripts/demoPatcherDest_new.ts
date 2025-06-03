/**
 * Encode destination call message for ReceiverAcrossV3 using Patcher pattern
 */
function encodeDestinationCallMessage(
  transactionId: string,
  swapFromAmount: string,
  swapToAmountMin: string,
  receiver: string
): string {
  // Create the value getter for Patcher's WETH balance (after deposit)
  const patcherBalanceValueGetter = generateBalanceOfCalldata(BASE_PATCHER)

  // Generate needle for finding the amountIn position
  const processRouteAmountNeedle = generateNeedle()

  // Create processRoute calldata with needle
  const routeData =
    '0x02420000000000000000000000000000000000000601ffff0172ab388e2e2f6facef59e3c3fa2c4e29011c2d38014dac9d1769b9b304cb04741dcdeb2fc14abdf110000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

  const processRouteCallData = encodeFunctionData({
    abi: parseAbi([
      'function processRoute(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOutMin, address to, bytes memory route) payable returns (uint256 amountOut)',
    ]),
    functionName: 'processRoute',
    args: [
      BASE_WETH as `0x${string}`, // tokenIn - WETH on Base
      processRouteAmountNeedle as any, // amountIn - needle value (will be patched)
      BASE_USDC as `0x${string}`, // tokenOut - USDC on Base
      BigInt(swapToAmountMin), // amountOutMin - Minimum USDC out
      receiver as `0x${string}`, // to - Final recipient
      routeData, // route - Route data for WETH->USDC swap
    ],
  })

  // Find the processRoute amount offset
  const processRouteAmountOffset = findNeedleOffset(
    processRouteCallData,
    processRouteAmountNeedle
  )
  consola.info(
    `Found processRoute amountIn offset: ${processRouteAmountOffset} bytes`
  )

  // Generate calldata for depositAndExecuteWithDynamicPatches
  const depositAndExecuteCallData = encodeFunctionData({
    abi: parseAbi([
      'function depositAndExecuteWithDynamicPatches(address tokenAddress, address valueSource, bytes calldata valueGetter, address finalTarget, uint256 value, bytes calldata data, uint256[] calldata offsets, bool delegateCall) returns (bool success, bytes memory returnData)',
    ]),
    functionName: 'depositAndExecuteWithDynamicPatches',
    args: [
      BASE_WETH as `0x${string}`, // tokenAddress - WETH contract
      BASE_WETH as `0x${string}`, // valueSource - WETH contract
      patcherBalanceValueGetter, // valueGetter - balanceOf(Patcher) call
      BASE_LIFI_DEX_AGGREGATOR as `0x${string}`, // finalTarget - LiFiDEXAggregator
      0n, // value - no ETH being sent
      processRouteCallData as `0x${string}`, // data - processRoute call
      [processRouteAmountOffset], // offsets - position of amountIn parameter
      false, // delegateCall - false for regular call
    ],
  })

  // Create LibSwap.SwapData structure with single patcher call
  const swapData = [
    // Single call: Patcher deposits WETH from Executor, approves LiFiDexAggregator, and executes swap
    {
      callTo: BASE_PATCHER as `0x${string}`,
      approveTo: BASE_PATCHER as `0x${string}`,
      sendingAssetId: BASE_WETH as `0x${string}`,
      receivingAssetId: BASE_USDC as `0x${string}`,
      fromAmount: BigInt(swapFromAmount),
      callData: depositAndExecuteCallData as `0x${string}`,
      requiresDeposit: true,
    },
  ]

  // Encode the message payload for ReceiverAcrossV3.handleV3AcrossMessage
  const messagePayload = encodeAbiParameters(
    [
      { name: 'transactionId', type: 'bytes32' },
      {
        name: 'swapData',
        type: 'tuple[]',
        components: [
          { name: 'callTo', type: 'address' },
          { name: 'approveTo', type: 'address' },
          { name: 'sendingAssetId', type: 'address' },
          { name: 'receivingAssetId', type: 'address' },
          { name: 'fromAmount', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
          { name: 'requiresDeposit', type: 'bool' },
        ],
      },
      { name: 'receiver', type: 'address' },
    ],
    [transactionId as `0x${string}`, swapData, receiver as `0x${string}`]
  )

  consola.info(
    'Encoded destination call message using single Patcher deposit call:'
  )
  consola.info(
    '1. Patcher deposits WETH from Executor, approves LiFiDexAggregator, and executes swap in one call'
  )
  return messagePayload
}
