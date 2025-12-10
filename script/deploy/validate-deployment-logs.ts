#!/usr/bin/env bun

/**
 * Deployment Logs Validation Script
 *
 * This script validates the integrity and consistency of deployment logs
 * between MongoDB and the local JSON file. It helps ensure data quality
 * during the migration from JSON-based to MongoDB-based logging.
 *
 * Features:
 * - Compare record counts between MongoDB and JSON
 * - Identify missing or extra records in either source
 * - Detect data inconsistencies
 * - Find duplicate entries
 * - Validate data integrity (timestamps, addresses, etc.)
 */

import { readFileSync } from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  DatabaseConnectionManager,
  type IConfig,
  type IDeploymentRecord,
  RecordTransformer,
  createDeploymentKey,
} from './shared/mongo-log-utils'

/**
 * Configuration for validation
 */
const config: IConfig = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  batchSize: 100,
  databaseName: 'contract-deployments',
}

const logFilePath = path.join(
  process.cwd(),
  'deployments/_deployments_log_file.json'
)

/**
 * Results of the validation
 */
interface IValidationResults {
  environment: string
  timestamp: string
  mongoRecordCount: number
  jsonRecordCount: number
  missingInMongo: IDeploymentRecord[]
  missingInJson: IDeploymentRecord[]
  duplicatesInMongo: Array<{ key: string; count: number }>
  duplicatesInJson: Array<{ key: string; count: number }>
  inconsistencies: Array<{
    key: string
    field: string
    mongoValue: unknown
    jsonValue: unknown
  }>
  versionMismatches: Array<{
    key: string
    mongoVersion: string
    jsonVersion: string
  }>
  passed: boolean
}

/**
 * Validates deployment logs between MongoDB and JSON file
 */
class DeploymentValidator {
  private dbManager: DatabaseConnectionManager

  public constructor(config: IConfig) {
    this.dbManager = DatabaseConnectionManager.getInstance(config)
  }

  /**
   * Connects to MongoDB
   */
  public async connect(): Promise<void> {
    await this.dbManager.connect()
  }

  /**
   * Disconnects from MongoDB
   */
  public async disconnect(): Promise<void> {
    await this.dbManager.disconnect()
  }

  /**
   * Loads records from MongoDB
   */
  private async loadFromMongo(
    environment: 'staging' | 'production'
  ): Promise<IDeploymentRecord[]> {
    const collection =
      this.dbManager.getCollection<IDeploymentRecord>(environment)
    return collection.find({}).toArray()
  }

  /**
   * Loads records from JSON file
   */
  private loadFromJson(
    environment: 'staging' | 'production'
  ): IDeploymentRecord[] {
    try {
      const jsonData = JSON.parse(readFileSync(logFilePath, 'utf8'))
      return RecordTransformer.processJsonData(jsonData, environment)
    } catch (error) {
      consola.error(`Failed to load JSON file: ${error}`)
      return []
    }
  }

  /**
   * Finds duplicate records in an array
   */
  private findDuplicates(
    records: IDeploymentRecord[]
  ): Array<{ key: string; count: number }> {
    const keyCounts = new Map<string, number>()

    for (const record of records) {
      const key = createDeploymentKey(record)
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1)
    }

    return Array.from(keyCounts.entries())
      .filter(([_key, count]) => count > 1)
      .map(([key, count]) => ({ key, count }))
  }

  /**
   * Compares two records for inconsistencies
   */
  private compareRecords(
    mongoRecord: IDeploymentRecord,
    jsonRecord: IDeploymentRecord
  ): Array<{ field: string; mongoValue: unknown; jsonValue: unknown }> {
    const inconsistencies: Array<{
      field: string
      mongoValue: unknown
      jsonValue: unknown
    }> = []

    // Compare key fields (including version to ensure it matches)
    const fieldsToCompare: Array<keyof IDeploymentRecord> = [
      'version', // Ensure version numbers match
      'address',
      'optimizerRuns',
      'constructorArgs',
      'salt',
      'verified',
      'solcVersion',
      'evmVersion',
      'zkSolcVersion',
    ]

    for (const field of fieldsToCompare) {
      const mongoValue = mongoRecord[field]
      const jsonValue = jsonRecord[field]

      // Handle undefined/null normalization (MongoDB stores null, JSON may have undefined)
      const normalizedMongoValue =
        mongoValue === undefined || mongoValue === null ? '' : mongoValue
      const normalizedJsonValue =
        jsonValue === undefined || jsonValue === null ? '' : jsonValue

      if (normalizedMongoValue !== normalizedJsonValue)
        inconsistencies.push({
          field,
          mongoValue,
          jsonValue,
        })
    }

    return inconsistencies
  }

  /**
   * Validates deployment logs for a given environment
   */
  public async validate(
    environment: 'staging' | 'production'
  ): Promise<IValidationResults> {
    consola.info(`Validating ${environment} deployment logs...`)

    // Load records from both sources
    const mongoRecords = await this.loadFromMongo(environment)
    const jsonRecords = this.loadFromJson(environment)

    consola.info(`MongoDB: ${mongoRecords.length} records`)
    consola.info(`JSON: ${jsonRecords.length} records`)

    // Create maps for quick lookup
    const mongoMap = new Map<string, IDeploymentRecord>()
    const jsonMap = new Map<string, IDeploymentRecord>()

    for (const record of mongoRecords) {
      const key = createDeploymentKey(record)
      mongoMap.set(key, record)
    }

    for (const record of jsonRecords) {
      const key = createDeploymentKey(record)
      jsonMap.set(key, record)
    }

    // Find records missing in MongoDB
    const missingInMongo = jsonRecords.filter(
      (record) => !mongoMap.has(createDeploymentKey(record))
    )

    // Find records missing in JSON
    const missingInJson = mongoRecords.filter(
      (record) => !jsonMap.has(createDeploymentKey(record))
    )

    // Find duplicates
    const duplicatesInMongo = this.findDuplicates(mongoRecords)
    const duplicatesInJson = this.findDuplicates(jsonRecords)

    // Find inconsistencies in records that exist in both
    const inconsistencies: Array<{
      key: string
      field: string
      mongoValue: unknown
      jsonValue: unknown
    }> = []

    const versionMismatches: Array<{
      key: string
      mongoVersion: string
      jsonVersion: string
    }> = []

    for (const [key, mongoRecord] of mongoMap.entries()) {
      const jsonRecord = jsonMap.get(key)
      if (jsonRecord) {
        const recordInconsistencies = this.compareRecords(
          mongoRecord,
          jsonRecord
        )
        for (const inc of recordInconsistencies) {
          inconsistencies.push({
            key,
            field: inc.field,
            mongoValue: inc.mongoValue,
            jsonValue: inc.jsonValue,
          })

          // Track version mismatches separately for special attention
          if (inc.field === 'version') {
            versionMismatches.push({
              key,
              mongoVersion: String(inc.mongoValue),
              jsonVersion: String(inc.jsonValue),
            })
          }
        }
      }
    }

    // Determine if validation passed
    const passed =
      missingInMongo.length === 0 &&
      missingInJson.length === 0 &&
      duplicatesInMongo.length === 0 &&
      duplicatesInJson.length === 0 &&
      inconsistencies.length === 0 &&
      versionMismatches.length === 0

    return {
      environment,
      timestamp: new Date().toISOString(),
      mongoRecordCount: mongoRecords.length,
      jsonRecordCount: jsonRecords.length,
      missingInMongo,
      missingInJson,
      duplicatesInMongo,
      duplicatesInJson,
      inconsistencies,
      versionMismatches,
      passed,
    }
  }

  /**
   * Prints validation results in a human-readable format
   */
  public printResults(results: IValidationResults): void {
    consola.box(`Validation Results - ${results.environment}`)

    // Summary
    consola.info('\n=== Summary ===')
    consola.info(`Timestamp: ${results.timestamp}`)
    consola.info(`MongoDB Records: ${results.mongoRecordCount}`)
    consola.info(`JSON Records: ${results.jsonRecordCount}`)
    consola.info(
      `Difference: ${Math.abs(
        results.mongoRecordCount - results.jsonRecordCount
      )}`
    )

    // Missing in MongoDB
    if (results.missingInMongo.length > 0) {
      consola.warn(
        `\n=== Missing in MongoDB (${results.missingInMongo.length}) ===`
      )
      for (const record of results.missingInMongo.slice(0, 10)) {
        // Show first 10
        consola.warn(
          `  ${record.contractName} on ${record.network} v${record.version} at ${record.address}`
        )
      }
      if (results.missingInMongo.length > 10)
        consola.warn(`  ... and ${results.missingInMongo.length - 10} more`)
    }

    // Missing in JSON
    if (results.missingInJson.length > 0) {
      consola.warn(
        `\n=== Missing in JSON (${results.missingInJson.length}) ===`
      )
      consola.info(
        'These records exist in MongoDB but not in local JSON (possibly from other developers)'
      )
      for (const record of results.missingInJson.slice(0, 10)) {
        // Show first 10
        consola.warn(
          `  ${record.contractName} on ${record.network} v${record.version} at ${record.address}`
        )
      }
      if (results.missingInJson.length > 10)
        consola.warn(`  ... and ${results.missingInJson.length - 10} more`)
    }

    // Duplicates in MongoDB
    if (results.duplicatesInMongo.length > 0) {
      consola.error(
        `\n=== Duplicates in MongoDB (${results.duplicatesInMongo.length}) ===`
      )
      for (const dup of results.duplicatesInMongo)
        consola.error(`  ${dup.key} appears ${dup.count} times`)
    }

    // Duplicates in JSON
    if (results.duplicatesInJson.length > 0) {
      consola.error(
        `\n=== Duplicates in JSON (${results.duplicatesInJson.length}) ===`
      )
      for (const dup of results.duplicatesInJson)
        consola.error(`  ${dup.key} appears ${dup.count} times`)
    }

    // Version Mismatches (CRITICAL)
    if (results.versionMismatches.length > 0) {
      consola.error(
        `\n=== VERSION MISMATCHES (${results.versionMismatches.length}) ===`
      )
      consola.error(
        'CRITICAL: Version numbers do not match between MongoDB and JSON!'
      )
      for (const mismatch of results.versionMismatches) {
        consola.error(`  ${mismatch.key}`)
        consola.error(`    MongoDB Version: ${mismatch.mongoVersion}`)
        consola.error(`    JSON Version: ${mismatch.jsonVersion}`)
      }
    }

    // Inconsistencies
    if (results.inconsistencies.length > 0) {
      consola.warn(
        `\n=== Data Inconsistencies (${results.inconsistencies.length}) ===`
      )
      // Filter out version mismatches as they're shown above
      const nonVersionInconsistencies = results.inconsistencies.filter(
        (inc) => inc.field !== 'version'
      )
      for (const inc of nonVersionInconsistencies.slice(0, 20)) {
        // Show first 20
        consola.warn(`  ${inc.key}`)
        consola.warn(`    Field: ${inc.field}`)
        consola.warn(`    MongoDB: ${JSON.stringify(inc.mongoValue)}`)
        consola.warn(`    JSON: ${JSON.stringify(inc.jsonValue)}`)
      }
      if (nonVersionInconsistencies.length > 20)
        consola.warn(`  ... and ${nonVersionInconsistencies.length - 20} more`)
    }

    // Overall status
    consola.info('\n=== Overall Status ===')
    if (results.passed) {
      consola.success('✓ Validation PASSED - Data is consistent')
    } else {
      consola.error('✗ Validation FAILED - Data inconsistencies detected')
      consola.info('\nRecommended actions:')

      if (results.versionMismatches.length > 0) {
        consola.error('  - CRITICAL: Fix version mismatches immediately!')
        consola.error(
          '    Version numbers must match between MongoDB and JSON for the same deployment'
        )
      }

      if (results.missingInMongo.length > 0)
        consola.info(
          '  - Run sync in merge mode to add missing entries to MongoDB'
        )

      if (results.missingInJson.length > 0)
        consola.info(
          '  - This is expected if other developers have made deployments'
        )

      if (
        results.duplicatesInMongo.length > 0 ||
        results.duplicatesInJson.length > 0
      )
        consola.info('  - Investigate and remove duplicate entries')

      if (results.inconsistencies.length > 0)
        consola.info('  - Review inconsistencies and update records as needed')
      // Filter out version mismatches as they're shown above
      const nonVersionInconsistencies = results.inconsistencies.filter(
        (inc) => inc.field !== 'version'
      )
      for (const inc of nonVersionInconsistencies.slice(0, 20)) {
        // Show first 20
        consola.warn(`  ${inc.key}`)
        consola.warn(`    Field: ${inc.field}`)
        consola.warn(`    MongoDB: ${JSON.stringify(inc.mongoValue)}`)
        consola.warn(`    JSON: ${JSON.stringify(inc.jsonValue)}`)
      }
      if (nonVersionInconsistencies.length > 20)
        consola.warn(`  ... and ${nonVersionInconsistencies.length - 20} more`)
    }

    // Overall status
    consola.info('\n=== Overall Status ===')
    if (results.passed) {
      consola.success('✓ Validation PASSED - Data is consistent')
    } else {
      consola.error('✗ Validation FAILED - Data inconsistencies detected')
      consola.info('\nRecommended actions:')

      if (results.versionMismatches.length > 0) {
        consola.error('  - CRITICAL: Fix version mismatches immediately!')
        consola.error(
          '    Version numbers must match between MongoDB and JSON for the same deployment'
        )
      }

      if (results.missingInMongo.length > 0)
        consola.info(
          '  - Run sync in merge mode to add missing entries to MongoDB'
        )

      if (results.missingInJson.length > 0)
        consola.info(
          '  - This is expected if other developers have made deployments'
        )

      if (
        results.duplicatesInMongo.length > 0 ||
        results.duplicatesInJson.length > 0
      )
        consola.info('  - Investigate and remove duplicate entries')

      if (results.inconsistencies.length > 0)
        consola.info('  - Review inconsistencies and update records as needed')
    }
  }
}

// Define CLI command
const validateCommand = defineCommand({
  meta: {
    name: 'validate-deployment-logs',
    description:
      'Validate consistency between MongoDB and JSON deployment logs',
    version: '1.0.0',
  },
  args: {
    env: {
      type: 'string',
      description: 'Environment to validate (staging, production, or all)',
      default: 'all',
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed output',
      default: false,
    },
  },
  async run({ args }) {
    // Validate environment
    if (
      args.env !== 'staging' &&
      args.env !== 'production' &&
      args.env !== 'all'
    ) {
      consola.error('Environment must be "staging", "production", or "all"')
      process.exit(1)
    }

    const validator = new DeploymentValidator(config)

    try {
      await validator.connect()

      const environments: Array<'staging' | 'production'> =
        args.env === 'all' ? ['staging', 'production'] : [args.env]

      const allResults: IValidationResults[] = []

      for (const env of environments) {
        const results = await validator.validate(env)
        allResults.push(results)

        if (args.verbose || environments.length === 1)
          validator.printResults(results)
        else {
          // Compact output for 'all' mode
          const status = results.passed ? '✓ PASSED' : '✗ FAILED'
          consola.info(
            `${env}: ${status} (MongoDB: ${results.mongoRecordCount}, JSON: ${results.jsonRecordCount})`
          )
        }
      }

      // Summary for 'all' mode
      if (environments.length > 1) {
        consola.info('\n=== Summary ===')
        const allPassed = allResults.every((r) => r.passed)
        if (allPassed)
          consola.success('All environments validated successfully')
        else {
          consola.error('Some environments have validation issues')
          consola.info('Run with specific environment for detailed results')
        }
      }

      // Exit with error code if validation failed
      const anyFailed = allResults.some((r) => !r.passed)
      if (anyFailed) process.exit(1)
    } catch (error) {
      consola.error('Validation failed:', error)
      process.exit(1)
    } finally {
      await validator.disconnect()
    }
  },
})

// Run the CLI
runMain(validateCommand)

export { DeploymentValidator, type IValidationResults }
