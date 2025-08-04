import { utils } from 'ethers'

import type { BridgeData } from './bridgeDataHelpers'
import { createBridgeData, createDefaultBridgeData } from './bridgeDataHelpers'

describe('bridgeDataHelpers', () => {
  describe('createBridgeData', () => {
    it('should create a properly typed bridgeData object with all parameters', () => {
      const transactionId = utils.randomBytes(32)
      const bridge = 'acrossV4'
      const integrator = 'testIntegrator'
      const referrer = '0x1234567890123456789012345678901234567890'
      const sendingAssetId = '0x0000000000000000000000000000000000000001'
      const receiver = '0x0000000000000000000000000000000000000002'
      const minAmount = '1000000'
      const destinationChainId = 42161
      const hasSourceSwaps = true
      const hasDestinationCall = false

      const result = createBridgeData(
        transactionId,
        bridge,
        integrator,
        referrer,
        sendingAssetId,
        receiver,
        minAmount,
        destinationChainId,
        hasSourceSwaps,
        hasDestinationCall
      )

      // Verify all properties are correctly set
      expect(result.transactionId).toBe(transactionId)
      expect(result.bridge).toBe(bridge)
      expect(result.integrator).toBe(integrator)
      expect(result.referrer).toBe(referrer)
      expect(result.sendingAssetId).toBe(sendingAssetId)
      expect(result.receiver).toBe(receiver)
      expect(result.minAmount).toBe(minAmount)
      expect(result.destinationChainId).toBe(destinationChainId)
      expect(result.hasSourceSwaps).toBe(hasSourceSwaps)
      expect(result.hasDestinationCall).toBe(hasDestinationCall)

      // Verify type safety
      expect(typeof result.bridge).toBe('string')
      expect(typeof result.integrator).toBe('string')
      expect(typeof result.referrer).toBe('string')
      expect(typeof result.sendingAssetId).toBe('string')
      expect(typeof result.receiver).toBe('string')
      expect(typeof result.minAmount).toBe('string')
      expect(typeof result.destinationChainId).toBe('number')
      expect(typeof result.hasSourceSwaps).toBe('boolean')
      expect(typeof result.hasDestinationCall).toBe('boolean')
    })

    it('should handle zero address for sendingAssetId', () => {
      const result = createBridgeData(
        utils.randomBytes(32),
        'stargateV2',
        'test',
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000', // zero address
        '0x0000000000000000000000000000000000000001',
        '5000000',
        10,
        false,
        true
      )

      expect(result.sendingAssetId).toBe(
        '0x0000000000000000000000000000000000000000'
      )
    })

    it('should handle different bridge protocols', () => {
      const bridges = ['acrossV4', 'stargateV2', 'hop', 'celer', 'multichain']

      bridges.forEach((bridge) => {
        const result = createBridgeData(
          utils.randomBytes(32),
          bridge,
          'test',
          '0x0000000000000000000000000000000000000000',
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000002',
          '1000000',
          42161,
          false,
          false
        )

        expect(result.bridge).toBe(bridge)
      })
    })

    it('should handle different chain IDs', () => {
      const chainIds = [1, 10, 137, 42161, 43114]

      chainIds.forEach((chainId) => {
        const result = createBridgeData(
          utils.randomBytes(32),
          'test',
          'test',
          '0x0000000000000000000000000000000000000000',
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000002',
          '1000000',
          chainId,
          false,
          false
        )

        expect(result.destinationChainId).toBe(chainId)
      })
    })
  })

  describe('createDefaultBridgeData', () => {
    it('should create bridgeData with default values', () => {
      const bridge = 'acrossV4'
      const sendingAssetId = '0x0000000000000000000000000000000000000001'
      const receiver = '0x0000000000000000000000000000000000000002'
      const minAmount = '1000000'
      const destinationChainId = 42161

      const result = createDefaultBridgeData(
        bridge,
        sendingAssetId,
        receiver,
        minAmount,
        destinationChainId
      )

      // Verify required parameters
      expect(result.bridge).toBe(bridge)
      expect(result.sendingAssetId).toBe(sendingAssetId)
      expect(result.receiver).toBe(receiver)
      expect(result.minAmount).toBe(minAmount)
      expect(result.destinationChainId).toBe(destinationChainId)

      // Verify default values
      expect(result.integrator).toBe('demoScript')
      expect(result.referrer).toBe('0x0000000000000000000000000000000000000000')
      expect(result.hasSourceSwaps).toBe(false)
      expect(result.hasDestinationCall).toBe(false)
      expect(result.transactionId).toBeInstanceOf(Uint8Array)
      expect((result.transactionId as Uint8Array).length).toBe(32)
    })

    it('should create bridgeData with custom boolean flags', () => {
      const result = createDefaultBridgeData(
        'stargateV2',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '5000000',
        10,
        true, // hasSourceSwaps
        true // hasDestinationCall
      )

      expect(result.hasSourceSwaps).toBe(true)
      expect(result.hasDestinationCall).toBe(true)
    })

    it('should generate unique transactionId for each call', () => {
      const result1 = createDefaultBridgeData(
        'test',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '1000000',
        1
      )

      const result2 = createDefaultBridgeData(
        'test',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '1000000',
        1
      )

      // Transaction IDs should be different
      expect(result1.transactionId).not.toEqual(result2.transactionId)
    })

    it('should handle different amount formats', () => {
      const amounts = ['1000000', '5000000', '1000000000000000000', '0']

      amounts.forEach((amount) => {
        const result = createDefaultBridgeData(
          'test',
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000002',
          amount,
          1
        )

        expect(result.minAmount).toBe(amount)
      })
    })

    it('should handle different receiver address formats', () => {
      const receivers = [
        '0x0000000000000000000000000000000000000001',
        '0x1234567890123456789012345678901234567890',
        '0x0000000000000000000000000000000000000000', // zero address
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ]

      receivers.forEach((receiver) => {
        const result = createDefaultBridgeData(
          'test',
          '0x0000000000000000000000000000000000000001',
          receiver,
          '1000000',
          1
        )

        expect(result.receiver).toBe(receiver)
      })
    })
  })

  describe('BridgeData type', () => {
    it('should be properly typed as ILiFi.BridgeDataStruct', () => {
      // This test verifies that the type alias is working correctly
      const bridgeData: BridgeData = {
        transactionId: utils.randomBytes(32),
        bridge: 'test',
        integrator: 'test',
        referrer: '0x0000000000000000000000000000000000000000',
        sendingAssetId: '0x0000000000000000000000000000000000000001',
        receiver: '0x0000000000000000000000000000000000000002',
        minAmount: '1000000',
        destinationChainId: 1,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      }

      expect(bridgeData).toBeDefined()
      expect(typeof bridgeData.bridge).toBe('string')
      expect(typeof bridgeData.destinationChainId).toBe('number')
      expect(typeof bridgeData.hasSourceSwaps).toBe('boolean')
    })
  })

  describe('Edge cases and error handling', () => {
    it('should handle empty strings for optional parameters', () => {
      const result = createDefaultBridgeData(
        '',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '',
        0
      )

      expect(result.bridge).toBe('')
      expect(result.minAmount).toBe('')
      expect(result.destinationChainId).toBe(0)
    })

    it('should handle very large numbers', () => {
      //pre-commit-checker: not a secret
      const largeAmount =
        '9999999999999999999999999999999999999999999999999999999999999999'

      const result = createDefaultBridgeData(
        'test',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        largeAmount,
        999999
      )

      expect(result.minAmount).toBe(largeAmount)
      expect(result.destinationChainId).toBe(999999)
    })

    it('should handle boolean flag combinations', () => {
      const combinations = [
        { hasSourceSwaps: false, hasDestinationCall: false },
        { hasSourceSwaps: true, hasDestinationCall: false },
        { hasSourceSwaps: false, hasDestinationCall: true },
        { hasSourceSwaps: true, hasDestinationCall: true },
      ]

      combinations.forEach(({ hasSourceSwaps, hasDestinationCall }) => {
        const result = createDefaultBridgeData(
          'test',
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000002',
          '1000000',
          1,
          hasSourceSwaps,
          hasDestinationCall
        )

        expect(result.hasSourceSwaps).toBe(hasSourceSwaps)
        expect(result.hasDestinationCall).toBe(hasDestinationCall)
      })
    })
  })
})
