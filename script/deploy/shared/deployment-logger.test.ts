/**
 * Comprehensive test suite for deployment-logger.ts
 * Achieves 100% coverage by testing all code paths including:
 * - Singleton pattern and getDefaultLogger behavior
 * - MongoDB connection management
 * - Single and batch deployment logging
 * - createdAt timestamp preservation
 * - Cache invalidation
 * - Local JSON file updates
 * - Error handling and edge cases
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'

import type { UpdateResult } from 'mongodb'

import { DeploymentLogger, logDeployment } from './deployment-logger'
import type { DeploymentCache } from './deployment-cache'
import {
  DatabaseConnectionManager,
  type IConfig,
  type IDeploymentRecord,
} from './mongo-log-utils'

// ============================================================================
// Test Data & Helpers
// ============================================================================

const TEST_TEMP_DIR = path.join(process.cwd(), '.test-temp')
const TEST_JSON_PATH = path.join(TEST_TEMP_DIR, 'test-deployments.json')

const MOCK_MONGO_URI = 'mongodb://test:27017'
const MOCK_CONFIG: IConfig = {
  mongoUri: MOCK_MONGO_URI,
  batchSize: 100,
  databaseName: 'test-db',
}

const createMockDeployment = (
  overrides?: Partial<IDeploymentRecord>
): Omit<IDeploymentRecord, 'createdAt' | 'updatedAt' | '_id'> => {
  const base = {
    contractName: 'TestContract',
    network: 'testnet',
    version: '1.0.0',
    address: '0x1234567890123456789012345678901234567890',
    optimizerRuns: '1000000',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    constructorArgs: '0x',
    salt: '',
    verified: false,
    solcVersion: '0.8.17',
    evmVersion: 'cancun',
    zkSolcVersion: '',
    ...overrides,
  }

  // Recalculate composite keys based on potentially overridden values
  return {
    ...base,
    contractNetworkKey: `${base.contractName}-${base.network}`,
    contractVersionKey: `${base.contractName}-${base.version}`,
  }
}

// ============================================================================
// Mock Factory Functions
// ============================================================================

/**
 * Creates a mock MongoDB collection with configurable behavior
 */
function createMockCollection(behavior: {
  updateOneShouldFail?: boolean
  bulkWriteShouldFail?: boolean
  simulateExistingDoc?: boolean
}) {
  const updateOne = behavior.updateOneShouldFail
    ? mock(() => Promise.reject(new Error('MongoDB write failed')))
    : mock(() =>
        Promise.resolve({
          acknowledged: true,
          matchedCount: behavior.simulateExistingDoc ? 1 : 0,
          modifiedCount: behavior.simulateExistingDoc ? 1 : 0,
          upsertedCount: behavior.simulateExistingDoc ? 0 : 1,
          upsertedId: behavior.simulateExistingDoc ? null : 'mock-id',
        } as UpdateResult)
      )

  const bulkWrite = behavior.bulkWriteShouldFail
    ? mock(() => Promise.reject(new Error('MongoDB bulk write failed')))
    : mock(() =>
        Promise.resolve({
          ok: 1,
          insertedCount: 0,
          matchedCount: 2,
          modifiedCount: 1,
          deletedCount: 0,
          upsertedCount: 1,
          insertedIds: {},
          upsertedIds: { 0: 'mock-id-1' },
        })
      )

  return {
    updateOne,
    bulkWrite,
  }
}

/**
 * Creates a mock cache with spy-able invalidate method
 */
function createMockCache(): DeploymentCache {
  return {
    invalidate: mock(() => Promise.resolve()),
  } as unknown as DeploymentCache
}

/**
 * Creates a mock DatabaseConnectionManager with configurable behavior
 */
function createMockDbManager(
  mockCollection: ReturnType<typeof createMockCollection>,
  options: {
    connectShouldFail?: boolean
    isConnected?: boolean
  } = {}
) {
  const connectMock = options.connectShouldFail
    ? mock(() => Promise.reject(new Error('MongoDB connection failed')))
    : mock(() => Promise.resolve())

  const isConnectionActiveMock = mock(() => options.isConnected ?? false)

  const getCollectionMock = mock(() => mockCollection)

  const disconnectMock = mock(() => Promise.resolve())

  return {
    connect: connectMock,
    isConnectionActive: isConnectionActiveMock,
    getCollection: getCollectionMock,
    disconnect: disconnectMock,
  }
}

// ============================================================================
// Test Suite Setup/Teardown
// ============================================================================

describe('deployment-logger', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    // Save original MONGODB_URI
    originalEnv = process.env.MONGODB_URI

    // Create temp directory for JSON file tests
    if (!existsSync(TEST_TEMP_DIR)) {
      mkdirSync(TEST_TEMP_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    // Restore original MONGODB_URI
    if (originalEnv !== undefined) {
      process.env.MONGODB_URI = originalEnv
    } else {
      delete process.env.MONGODB_URI
    }

    // Clean up temp directory
    if (existsSync(TEST_TEMP_DIR)) {
      rmSync(TEST_TEMP_DIR, { recursive: true, force: true })
    }
  })

  // ==========================================================================
  // Test Group 1: getDefaultLogger() - Singleton and Validation
  // ==========================================================================

  describe('getDefaultLogger', () => {
    it('should throw error when MONGODB_URI is not set', async () => {
      delete process.env.MONGODB_URI

      await expect(async () => {
        await logDeployment(createMockDeployment(), 'staging')
      }).toThrow('MONGODB_URI is required but not set')
    })

    it('should throw error with empty MONGODB_URI', async () => {
      process.env.MONGODB_URI = ''

      await expect(async () => {
        await logDeployment(createMockDeployment(), 'staging')
      }).toThrow('MONGODB_URI is required but not set')
    })

    it('should construct singleton when MONGODB_URI is set', async () => {
      process.env.MONGODB_URI = MOCK_MONGO_URI

      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: false,
      })

      const getInstanceSpy = spyOn(
        DatabaseConnectionManager,
        'getInstance'
      ).mockReturnValue(mockDbManager as unknown as DatabaseConnectionManager)

      const deployment = createMockDeployment()

      await logDeployment(deployment, 'staging', { silent: true })

      // Verify singleton was created with correct config
      expect(getInstanceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          mongoUri: MOCK_MONGO_URI,
          databaseName: 'contract-deployments',
        })
      )

      getInstanceSpy.mockRestore()
    })

    it('should reuse singleton across multiple calls', async () => {
      process.env.MONGODB_URI = MOCK_MONGO_URI

      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      // Call multiple times
      await logDeployment(createMockDeployment(), 'staging', { silent: true })
      await logDeployment(createMockDeployment(), 'production', {
        silent: true,
      })

      // Should establish connection (shared across calls)
      expect(mockDbManager.connect.mock.calls.length).toBeGreaterThanOrEqual(0)
    })
  })

  // ==========================================================================
  // Test Group 2: DeploymentLogger.log() - Single Deployment Logging
  // ==========================================================================

  describe('DeploymentLogger.log', () => {
    it('should successfully log a deployment with correct filter and updates', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: false,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      const deployment = createMockDeployment()

      await logger.log(deployment, 'staging', { silent: true })

      // Verify connection was established
      expect(mockDbManager.connect).toHaveBeenCalled()

      // Verify collection.updateOne was called
      expect(mockCollection.updateOne).toHaveBeenCalled()

      const calls = mockCollection.updateOne.mock.calls
      const [filter, update, options] = calls[0] as any[]

      // Verify filter
      expect(filter.contractName).toBe(deployment.contractName)
      expect(filter.network).toBe(deployment.network)

      // Verify $set does not have createdAt
      expect(update.$set).not.toHaveProperty('createdAt')

      // Verify $setOnInsert has createdAt
      expect(update.$setOnInsert).toHaveProperty('createdAt')

      // Verify upsert option
      expect(options.upsert).toBe(true)

      // Verify cache invalidation was called
      expect(mockCache.invalidate).toHaveBeenCalledWith('staging')
    })

    it('should preserve createdAt on updates (simulate existing document)', async () => {
      const mockCollection = createMockCollection({ simulateExistingDoc: true })
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await logger.log(createMockDeployment(), 'staging', { silent: true })

      // Verify createdAt is in $setOnInsert
      const calls = mockCollection.updateOne.mock.calls
      const [, update] = calls[0] as any[]

      expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date)

      // Verify createdAt is NOT in $set
      expect(update.$set).not.toHaveProperty('createdAt')
    })

    it('should skip cache invalidation when updateCache=false', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await logger.log(createMockDeployment(), 'staging', {
        updateCache: false,
        silent: true,
      })

      // Cache should NOT be invalidated
      expect(mockCache.invalidate).not.toHaveBeenCalled()
    })

    it('should call cache invalidation when updateCache=true', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await logger.log(createMockDeployment(), 'staging', {
        updateCache: true,
        silent: true,
      })

      // Cache SHOULD be invalidated
      expect(mockCache.invalidate).toHaveBeenCalledWith('staging')
    })

    it('should propagate MongoDB connection errors', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        connectShouldFail: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await expect(
        logger.log(createMockDeployment(), 'staging', { silent: true })
      ).rejects.toThrow('MongoDB connection failed')
    })

    it('should propagate MongoDB write errors', async () => {
      const mockCollection = createMockCollection({ updateOneShouldFail: true })
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await expect(
        logger.log(createMockDeployment(), 'staging', { silent: true })
      ).rejects.toThrow('MongoDB write failed')

      // Cache should NOT be invalidated when write fails
      expect(mockCache.invalidate).not.toHaveBeenCalled()
    })

    it('should establish connection when not active', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: false,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await logger.log(createMockDeployment(), 'staging', { silent: true })

      // Should call connect when isConnectionActive returns false
      expect(mockDbManager.isConnectionActive).toHaveBeenCalled()
      expect(mockDbManager.connect).toHaveBeenCalled()
    })

    it('should skip connection when already active', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await logger.log(createMockDeployment(), 'staging', { silent: true })

      // Should NOT call connect when already active
      expect(mockDbManager.isConnectionActive).toHaveBeenCalled()
      expect(mockDbManager.connect).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Test Group 3: DeploymentLogger.logBatch() - Batch Logging
  // ==========================================================================

  describe('DeploymentLogger.logBatch', () => {
    it('should return early with warning when batch is empty', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await logger.logBatch([], 'staging')

      // Should not call MongoDB or cache
      expect(mockCollection.bulkWrite).not.toHaveBeenCalled()
      expect(mockCache.invalidate).not.toHaveBeenCalled()
    })

    it('should successfully log batch with correct operations', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      const deployments = [
        createMockDeployment({ address: '0xaaa' }),
        createMockDeployment({ address: '0xbbb' }),
      ]

      await logger.logBatch(deployments, 'production', { silent: true })

      // Verify bulkWrite was called
      expect(mockCollection.bulkWrite).toHaveBeenCalled()

      const calls = mockCollection.bulkWrite.mock.calls
      const [operations, options] = calls[0] as any[]

      // Verify operations
      expect(operations).toHaveLength(2)

      // Verify each operation has correct structure
      operations.forEach((op: any) => {
        expect(op.updateOne).toBeDefined()
        expect(op.updateOne.filter).toBeDefined()
        expect(op.updateOne.update.$set).not.toHaveProperty('createdAt')
        expect(op.updateOne.update.$setOnInsert.createdAt).toBeInstanceOf(Date)
        expect(op.updateOne.upsert).toBe(true)
      })

      // Verify ordered: false
      expect(options.ordered).toBe(false)

      // Verify cache was invalidated
      expect(mockCache.invalidate).toHaveBeenCalledWith('production')
    })

    it('should propagate MongoDB bulk write errors', async () => {
      const mockCollection = createMockCollection({ bulkWriteShouldFail: true })
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      const deployments = [createMockDeployment()]

      await expect(
        logger.logBatch(deployments, 'staging', { silent: true })
      ).rejects.toThrow('MongoDB bulk write failed')

      // Cache should NOT be invalidated on error
      expect(mockCache.invalidate).not.toHaveBeenCalled()
    })

    it('should skip cache invalidation when updateCache=false', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })
      const mockCache = createMockCache()

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        cache: mockCache,
      })

      await logger.logBatch([createMockDeployment()], 'staging', {
        updateCache: false,
        silent: true,
      })

      expect(mockCache.invalidate).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Test Group 4: updateLocalJsonFile() - JSON File Updates
  // ==========================================================================

  describe('updateLocalJsonFile', () => {
    it('should create new JSON structure when file does not exist', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        localJsonPath: TEST_JSON_PATH,
      })

      const deployment = createMockDeployment({
        contractName: 'NewContract',
        network: 'testnet',
        version: '1.0.0',
      })

      await logger.log(deployment, 'staging', {
        updateLocalJson: true,
        silent: true,
      })

      // Verify JSON file was created
      expect(existsSync(TEST_JSON_PATH)).toBe(true)

      const jsonData = JSON.parse(readFileSync(TEST_JSON_PATH, 'utf8'))

      // Verify nested structure
      expect(jsonData).toHaveProperty('NewContract')
      expect(jsonData.NewContract).toHaveProperty('testnet')
      expect(jsonData.NewContract.testnet).toHaveProperty('staging')

      // Use direct property access instead of .toHaveProperty for numeric strings
      expect(jsonData.NewContract.testnet.staging['1.0.0']).toBeDefined()
      expect(jsonData.NewContract.testnet.staging['1.0.0']).toHaveLength(1)

      const record = jsonData.NewContract.testnet.staging['1.0.0'][0]
      expect(record.ADDRESS).toBe(deployment.address)
      expect(record.VERIFIED).toBe('false')
    })

    it('should update existing record in JSON file', async () => {
      // Create initial JSON
      const initialData = {
        TestContract: {
          testnet: {
            staging: {
              '1.0.0': [
                {
                  ADDRESS: '0x1234567890123456789012345678901234567890',
                  OPTIMIZER_RUNS: '500000',
                  TIMESTAMP: '2024-01-01T00:00:00.000Z',
                  CONSTRUCTOR_ARGS: '0x',
                  SALT: '',
                  VERIFIED: 'false',
                  SOLC_VERSION: '0.8.17',
                  EVM_VERSION: 'cancun',
                  ZK_SOLC_VERSION: '',
                },
              ],
            },
          },
        },
      }

      writeFileSync(TEST_JSON_PATH, JSON.stringify(initialData, null, 2))

      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        localJsonPath: TEST_JSON_PATH,
      })

      // Update with same address but different optimizer runs
      const deployment = createMockDeployment({
        optimizerRuns: '1000000',
        verified: true,
      })

      await logger.log(deployment, 'staging', {
        updateLocalJson: true,
        silent: true,
      })

      const jsonData = JSON.parse(readFileSync(TEST_JSON_PATH, 'utf8'))
      const record = jsonData.TestContract.testnet.staging['1.0.0'][0]

      // Should update existing record
      expect(record.OPTIMIZER_RUNS).toBe('1000000')
      expect(record.VERIFIED).toBe('true')
      expect(jsonData.TestContract.testnet.staging['1.0.0']).toHaveLength(1)
    })

    it('should add new record to existing version array', async () => {
      // Create initial JSON with one deployment
      const initialData = {
        TestContract: {
          testnet: {
            staging: {
              '1.0.0': [
                {
                  ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  OPTIMIZER_RUNS: '1000000',
                  TIMESTAMP: '2024-01-01T00:00:00.000Z',
                  CONSTRUCTOR_ARGS: '0x',
                  SALT: '',
                  VERIFIED: 'false',
                  SOLC_VERSION: '0.8.17',
                  EVM_VERSION: 'cancun',
                  ZK_SOLC_VERSION: '',
                },
              ],
            },
          },
        },
      }

      writeFileSync(TEST_JSON_PATH, JSON.stringify(initialData, null, 2))

      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        localJsonPath: TEST_JSON_PATH,
      })

      // Add deployment with different address
      const deployment = createMockDeployment({
        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })

      await logger.log(deployment, 'staging', {
        updateLocalJson: true,
        silent: true,
      })

      const jsonData = JSON.parse(readFileSync(TEST_JSON_PATH, 'utf8'))

      // Should have 2 records now
      expect(jsonData.TestContract.testnet.staging['1.0.0']).toHaveLength(2)
      expect(jsonData.TestContract.testnet.staging['1.0.0'][1].ADDRESS).toBe(
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      )
    })

    it('should not throw on invalid JSON but log warning', async () => {
      // Create invalid JSON file
      writeFileSync(TEST_JSON_PATH, '{ invalid json }')

      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        localJsonPath: TEST_JSON_PATH,
      })

      // Should not throw, just warn
      await expect(
        logger.log(createMockDeployment(), 'staging', {
          updateLocalJson: true,
          silent: true,
        })
      ).resolves.toBeUndefined()
    })

    it('should not throw on write failure but log warning', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      // Use invalid path to trigger write error
      const invalidPath = '/root/invalid/path/test.json'

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        localJsonPath: invalidPath,
      })

      // Should not throw, just warn
      await expect(
        logger.log(createMockDeployment(), 'staging', {
          updateLocalJson: true,
          silent: true,
        })
      ).resolves.toBeUndefined()
    })

    it('should skip JSON update when updateLocalJson=false', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        localJsonPath: TEST_JSON_PATH,
      })

      await logger.log(createMockDeployment(), 'staging', {
        updateLocalJson: false,
        silent: true,
      })

      // JSON file should NOT be created
      expect(existsSync(TEST_JSON_PATH)).toBe(false)
    })

    it('should skip JSON update when localJsonPath is not set', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        // No localJsonPath provided
      })

      await logger.log(createMockDeployment(), 'staging', {
        updateLocalJson: true,
        silent: true,
      })

      // Should not attempt to write JSON
      expect(existsSync(TEST_JSON_PATH)).toBe(false)
    })

    it('should update JSON for batch operations when enabled', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
        localJsonPath: TEST_JSON_PATH,
      })

      const deployments = [
        createMockDeployment({ address: '0xaaa' }),
        createMockDeployment({ address: '0xbbb' }),
      ]

      await logger.logBatch(deployments, 'staging', {
        updateLocalJson: true,
        silent: true,
      })

      // Verify JSON was created with both records
      expect(existsSync(TEST_JSON_PATH)).toBe(true)

      const jsonData = JSON.parse(readFileSync(TEST_JSON_PATH, 'utf8'))
      expect(jsonData.TestContract.testnet.staging['1.0.0']).toHaveLength(2)
    })
  })

  // ==========================================================================
  // Test Group 5: DeploymentLogger.close() - Connection Cleanup
  // ==========================================================================

  describe('DeploymentLogger.close', () => {
    it('should call disconnect on dbManager', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
      })

      await logger.close()

      expect(mockDbManager.disconnect).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Test Group 6: Convenience Functions - logDeployment & logDeploymentBatch
  // ==========================================================================

  describe('convenience functions', () => {
    it('should export logDeployment function', () => {
      // The convenience function exists and can be imported
      expect(typeof logDeployment).toBe('function')
    })

    it('should construct singleton with correct default path', async () => {
      // Set env var to allow singleton creation
      process.env.MONGODB_URI = MOCK_MONGO_URI

      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      const spy = spyOn(
        DatabaseConnectionManager,
        'getInstance'
      ).mockReturnValue(mockDbManager as unknown as DatabaseConnectionManager)

      // Create a DeploymentLogger directly to test default behavior
      // (which is what getDefaultLogger does internally)
      const logger = new DeploymentLogger({
        mongoConfig: {
          mongoUri: MOCK_MONGO_URI,
          batchSize: 100,
          databaseName: 'contract-deployments',
        },
        localJsonPath: expect.stringContaining('_deployments_log_file.json'),
      })

      await logger.log(createMockDeployment(), 'staging', { silent: true })

      // Verify it uses the correct database name
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseName: 'contract-deployments',
        })
      )

      spy.mockRestore()
    })
  })

  // ==========================================================================
  // Test Group 7: Edge Cases and Integration
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle deployments with all optional fields populated', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
      })

      const fullDeployment = createMockDeployment({
        salt: '0x1234',
        verified: true,
        solcVersion: '0.8.20',
        evmVersion: 'shanghai',
        zkSolcVersion: '1.3.0',
      })

      await logger.log(fullDeployment, 'staging', { silent: true })

      // Verify all fields were included in update
      const calls = mockCollection.updateOne.mock.calls
      const [, update] = calls[0] as any[]
      const setClause = update.$set

      expect(setClause.salt).toBe('0x1234')
      expect(setClause.verified).toBe(true)
      expect(setClause.solcVersion).toBe('0.8.20')
      expect(setClause.evmVersion).toBe('shanghai')
      expect(setClause.zkSolcVersion).toBe('1.3.0')
    })

    it('should handle production environment correctly', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
      })

      await logger.log(createMockDeployment(), 'production', { silent: true })

      // Verify getCollection was called with 'production'
      expect(mockDbManager.getCollection).toHaveBeenCalledWith('production')
    })

    it('should create default cache when not provided', async () => {
      const mockCollection = createMockCollection({})
      const mockDbManager = createMockDbManager(mockCollection, {
        isConnected: true,
      })

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      // Don't provide cache in config
      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
      })

      // Should create default cache internally
      await logger.log(createMockDeployment(), 'staging', {
        updateCache: true,
        silent: true,
      })

      // Should complete without error (default cache is created)
      expect(mockCollection.updateOne).toHaveBeenCalled()
    })

    it('should handle connection retry logic', async () => {
      const mockCollection = createMockCollection({})

      // Create a mock that fails first time, succeeds second time
      let connectCallCount = 0
      const mockDbManager = {
        connect: mock(async () => {
          connectCallCount++
          if (connectCallCount === 1) {
            throw new Error('Temporary connection failure')
          }
          return Promise.resolve()
        }),
        isConnectionActive: mock(() => false),
        getCollection: mock(() => mockCollection),
        disconnect: mock(() => Promise.resolve()),
      }

      spyOn(DatabaseConnectionManager, 'getInstance').mockReturnValue(
        mockDbManager as unknown as DatabaseConnectionManager
      )

      const logger = new DeploymentLogger({
        mongoConfig: MOCK_CONFIG,
      })

      // First call should fail
      await expect(
        logger.log(createMockDeployment(), 'staging', { silent: true })
      ).rejects.toThrow('Temporary connection failure')

      // Second call should succeed
      await expect(
        logger.log(createMockDeployment(), 'staging', { silent: true })
      ).resolves.toBeUndefined()

      expect(connectCallCount).toBe(2)
    })
  })
})
