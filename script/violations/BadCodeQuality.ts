/**
 * Violation: Code quality issues - uses `any`, poor error handling.
 * 
 * Convention violations:
 * - Obey .eslintrc.cjs; avoid `any` types
 * - Use proper error handling with consola.error()
 * - Exit with process.exit(1) on fatal errors
 * - Provide meaningful error messages
 * 
 * This file violates by using `any` types and not handling errors properly.
 */

import { consola } from 'consola'

// Violation: Uses `any` type instead of proper typing
function processData(data: any) {
  // Violation: Should use proper types (unknown with type narrowing, or specific interface)
  return data.value
}

// Violation: Uses `any` for error handling
function handleError(error: any) {
  // Violation: Should use proper error type (Error | unknown with narrowing)
  console.log(error.message) // Violation: Uses console.log instead of consola
}

// Violation: Doesn't exit with process.exit(1) on fatal errors
function fatalOperation() {
  try {
    // Some operation that might fail
    throw new Error('Fatal error')
  } catch (error) {
    // Violation: Should use consola.error() and process.exit(1)
    console.error('Error occurred') // Violation: Uses console.error instead of consola.error
    // Missing: process.exit(1)
  }
}

// Violation: Poor error messages
function badFunction() {
  try {
    // Operation
  } catch {
    // Violation: No error message, should provide meaningful message
    throw new Error('Error') // Violation: Generic error message
  }
}

// Violation: Uses `any` for function parameters
function processContract(contract: any) {
  // Violation: Should use proper type (e.g., from typechain or viem)
  return contract.address
}

export { processData, handleError, fatalOperation, badFunction, processContract }
