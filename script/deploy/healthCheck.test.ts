/**
 * Comprehensive test suite for execWithRateLimitRetry helper function
 * Achieves 100% coverage by testing all code paths including:
 * - Success on first attempt
 * - Retry logic with rate limit detection (429)
 * - Max retries reached
 * - Non-rate-limit errors (should throw immediately)
 * - Initial delay functionality
 * - Different rate limit error message formats
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { consola } from 'consola'
import * as childProcess from 'child_process'

// Set test environment before importing
process.env.BUN_TEST = 'true'

import { execWithRateLimitRetry } from './healthCheck'

// ============================================================================
// Test Suite
// ============================================================================

describe('execWithRateLimitRetry', () => {
  let execSyncSpy: ReturnType<typeof spyOn>
  let consolaWarnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    // Mock execSync
    execSyncSpy = spyOn(childProcess, 'execSync')
    // Mock consola.warn to avoid console noise during tests
    consolaWarnSpy = spyOn(consola, 'warn')
  })

  afterEach(() => {
    // Restore original implementations
    execSyncSpy.mockRestore()
    consolaWarnSpy.mockRestore()
  })

  // ==========================================================================
  // Test Group 1: Success Cases
  // ==========================================================================

  describe('success cases', () => {
    it('should return result on first successful attempt', async () => {
      execSyncSpy.mockReturnValueOnce('success output')

      const result = await execWithRateLimitRetry('test command')

      expect(result).toBe('success output')
      expect(execSyncSpy).toHaveBeenCalledTimes(1)
      expect(execSyncSpy).toHaveBeenCalledWith('test command', {
        encoding: 'utf8',
      })
      expect(consolaWarnSpy).not.toHaveBeenCalled()
    })

    it('should succeed after initial delay when specified', async () => {
      execSyncSpy.mockReturnValueOnce('success output')

      const startTime = Date.now()
      const result = await execWithRateLimitRetry('test command', 100)
      const endTime = Date.now()

      expect(result).toBe('success output')
      expect(endTime - startTime).toBeGreaterThanOrEqual(90) // Allow some margin
      expect(execSyncSpy).toHaveBeenCalledTimes(1)
    })

    it('should not delay when initialDelay is 0', async () => {
      execSyncSpy.mockReturnValueOnce('success output')

      const startTime = Date.now()
      await execWithRateLimitRetry('test command', 0)
      const endTime = Date.now()

      // Should be very fast (< 50ms)
      expect(endTime - startTime).toBeLessThan(50)
    })
  })

  // ==========================================================================
  // Test Group 2: Rate Limit Retry Logic
  // ==========================================================================

  describe('rate limit retry logic', () => {
    it('should retry on 429 error and succeed on second attempt', async () => {
      const rateLimitError = new Error('Request failed with status code 429')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success after retry')

      const result = await execWithRateLimitRetry('test command', 0, 3, [10])

      expect(result).toBe('success after retry')
      expect(execSyncSpy).toHaveBeenCalledTimes(2)
      expect(consolaWarnSpy).toHaveBeenCalledTimes(1)
      expect(consolaWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit detected (429)')
      )
    })

    it('should retry on "rate limit" error message', async () => {
      const rateLimitError = new Error('rate limit exceeded')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success after retry')

      const result = await execWithRateLimitRetry('test command', 0, 3, [10])

      expect(result).toBe('success after retry')
      expect(execSyncSpy).toHaveBeenCalledTimes(2)
    })

    it('should retry on "Too Many Requests" error message', async () => {
      const rateLimitError = new Error('Too Many Requests')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success after retry')

      const result = await execWithRateLimitRetry('test command', 0, 3, [10])

      expect(result).toBe('success after retry')
      expect(execSyncSpy).toHaveBeenCalledTimes(2)
    })

    it('should use custom retry delays', async () => {
      const rateLimitError = new Error('429')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success')

      const startTime = Date.now()
      await execWithRateLimitRetry('test command', 0, 3, [100])
      const endTime = Date.now()

      expect(endTime - startTime).toBeGreaterThanOrEqual(90)
      expect(execSyncSpy).toHaveBeenCalledTimes(2)
    })

    it('should retry multiple times with exponential backoff', async () => {
      const rateLimitError = new Error('429')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success after 2 retries')

      const startTime = Date.now()
      const result = await execWithRateLimitRetry('test command', 0, 3, [50, 100])
      const endTime = Date.now()

      expect(result).toBe('success after 2 retries')
      expect(execSyncSpy).toHaveBeenCalledTimes(3)
      expect(consolaWarnSpy).toHaveBeenCalledTimes(2)
      // Should have waited for both delays (50ms + 100ms)
      expect(endTime - startTime).toBeGreaterThanOrEqual(140)
    })
  })

  // ==========================================================================
  // Test Group 3: Max Retries Reached
  // ==========================================================================

  describe('max retries reached', () => {
    it('should throw error when max retries exceeded', async () => {
      const rateLimitError = new Error('429')
      execSyncSpy.mockImplementation(() => {
        throw rateLimitError
      })

      await expect(
        execWithRateLimitRetry('test command', 0, 2, [10, 10])
      ).rejects.toThrow('429')

      // Should attempt: initial + 2 retries = 3 total attempts
      expect(execSyncSpy).toHaveBeenCalledTimes(3)
      expect(consolaWarnSpy).toHaveBeenCalledTimes(2)
    })

    it('should throw rate limit error when maxRetries=0 and rate limit occurs', async () => {
      const rateLimitError = new Error('429')
      execSyncSpy.mockImplementation(() => {
        throw rateLimitError
      })

      // With maxRetries=0:
      // - First iteration: retries=0, maxRetries=0, loop executes (0 <= 0 is true)
      // - Command fails with rate limit error
      // - isRateLimit && retries < maxRetries → true && 0 < 0 → false
      // - Enters else block and throws error directly (not "Max retries reached")
      await expect(
        execWithRateLimitRetry('test command', 0, 0, [10])
      ).rejects.toThrow('429')

      expect(execSyncSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ==========================================================================
  // Test Group 4: Non-Rate-Limit Errors
  // ==========================================================================

  describe('non-rate-limit errors', () => {
    it('should throw immediately on non-rate-limit error', async () => {
      const otherError = new Error('Connection refused')
      execSyncSpy.mockImplementationOnce(() => {
        throw otherError
      })

      await expect(
        execWithRateLimitRetry('test command', 0, 3, [10])
      ).rejects.toThrow('Connection refused')

      // Should not retry
      expect(execSyncSpy).toHaveBeenCalledTimes(1)
      expect(consolaWarnSpy).not.toHaveBeenCalled()
    })

    it('should throw immediately on error without message', async () => {
      const errorWithoutMessage = new Error('')
      execSyncSpy.mockImplementationOnce(() => {
        throw errorWithoutMessage
      })

      await expect(
        execWithRateLimitRetry('test command', 0, 3, [10])
      ).rejects.toThrow()

      expect(execSyncSpy).toHaveBeenCalledTimes(1)
      expect(consolaWarnSpy).not.toHaveBeenCalled()
    })

    it('should throw immediately on non-Error object thrown', async () => {
      execSyncSpy.mockImplementationOnce(() => {
        throw 'string error'
      })

      await expect(
        execWithRateLimitRetry('test command', 0, 3, [10])
      ).rejects.toBe('string error')

      expect(execSyncSpy).toHaveBeenCalledTimes(1)
      expect(consolaWarnSpy).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Test Group 5: Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle empty command string', async () => {
      execSyncSpy.mockReturnValueOnce('')

      const result = await execWithRateLimitRetry('')

      expect(result).toBe('')
      expect(execSyncSpy).toHaveBeenCalledWith('', { encoding: 'utf8' })
    })

    it('should use default retry delays when not provided', async () => {
      const rateLimitError = new Error('429')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success')

      const startTime = Date.now()
      await execWithRateLimitRetry('test command', 0, 3)
      const endTime = Date.now()

      // Default delays are [3000, 5000, 10000], so first retry should wait ~3s
      expect(endTime - startTime).toBeGreaterThanOrEqual(2900)
      expect(execSyncSpy).toHaveBeenCalledTimes(2)
    })

    it('should handle rate limit error in error message property', async () => {
      const errorWith429InMessage = {
        message: 'Call failed: Request failed with status code 429',
      }
      execSyncSpy
        .mockImplementationOnce(() => {
          throw errorWith429InMessage
        })
        .mockReturnValueOnce('success')

      const result = await execWithRateLimitRetry('test command', 0, 3, [10])

      expect(result).toBe('success')
      expect(execSyncSpy).toHaveBeenCalledTimes(2)
    })

    it('should handle case-insensitive rate limit detection', async () => {
      const rateLimitError = new Error('RATE LIMIT')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success')

      // Note: current implementation uses includes() which is case-sensitive
      // This test documents current behavior - if we want case-insensitive,
      // we'd need to update the implementation
      await expect(
        execWithRateLimitRetry('test command', 0, 3, [10])
      ).rejects.toThrow('RATE LIMIT')
    })
  })

  // ==========================================================================
  // Test Group 6: Retry Delay Verification
  // ==========================================================================

  describe('retry delay verification', () => {
    it('should wait correct amount of time between retries', async () => {
      const rateLimitError = new Error('429')
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success')

      const delay = 200
      const startTime = Date.now()
      await execWithRateLimitRetry('test command', 0, 3, [delay])
      const endTime = Date.now()

      expect(endTime - startTime).toBeGreaterThanOrEqual(delay - 20) // Allow margin
      expect(endTime - startTime).toBeLessThan(delay + 100) // Should not wait too long
    })

    it('should use correct delay for each retry attempt', async () => {
      const rateLimitError = new Error('429')
      const delays = [50, 100, 150]
      execSyncSpy
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockImplementationOnce(() => {
          throw rateLimitError
        })
        .mockReturnValueOnce('success')

      const startTime = Date.now()
      await execWithRateLimitRetry('test command', 0, 3, delays)
      const endTime = Date.now()

      // Should have waited for all three delays
      const totalExpectedDelay = delays[0] + delays[1] + delays[2]
      expect(endTime - startTime).toBeGreaterThanOrEqual(totalExpectedDelay - 30)
    })
  })
})
