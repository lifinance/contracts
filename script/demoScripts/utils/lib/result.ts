/**
 * Result type for handling success and error cases
 */
export type Result<E, T> = Left<E> | Right<T>

/**
 * Left type for error cases
 */
export interface Left<E> {
  readonly _type: 'Left'
  readonly error: E
}

/**
 * Right type for success cases
 */
export interface Right<T> {
  readonly _type: 'Right'
  readonly data: T
}

/**
 * Create a Left result (error case)
 */
export function left<E, T>(error: E): Result<E, T> {
  return { _type: 'Left', error }
}

/**
 * Create a Right result (success case)
 */
export function right<E, T>(data: T): Result<E, T> {
  return { _type: 'Right', data }
}