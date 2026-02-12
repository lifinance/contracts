// VIOLATION: Missing describe block at top level
// VIOLATION: Poor test structure and coverage

import { expect } from 'bun:test';

// VIOLATION: Test not wrapped in describe/it
const myHelper = (x: number, y: number): number => {
  if (x < 0) throw new Error('Negative not allowed');
  if (y === 0) throw new Error('Division by zero');
  return x / y;
};

// VIOLATION: Only testing happy path, missing edge cases
const result1 = myHelper(10, 2);
expect(result1).toBe(5);

// VIOLATION: No error path testing
// VIOLATION: Not using it() blocks

// VIOLATION: Missing coverage for:
// - negative x input
// - zero y input (division by zero)
// - large numbers
// - decimal results

console.log('Tests passed (but poorly structured)');
