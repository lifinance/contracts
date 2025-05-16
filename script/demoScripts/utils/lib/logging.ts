// Simple logging utilities for demo scripts

/**
 * Log a key-value pair with formatting
 */
export function logKeyValue(key: string, value: string | number | bigint): void {
  console.log(`${key}: ${value}`)
}

/**
 * Log a section header with formatting
 */
export function logSectionHeader(text: string): void {
  console.log(`\n=== ${text} ===`)
}

/**
 * Log a success message with formatting
 */
export function logSuccess(text: string): void {
  console.log(`✅ ${text}`)
}