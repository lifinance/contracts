// VIOLATION: TypeScript tests should use Bun (describe/it/expect)
// VIOLATION: Missing proper test structure

// Test without describe block
const testFunction = () => {
  const result = 1 + 1;
  // VIOLATION: Not using proper expect assertions
  if (result !== 2) {
    throw new Error('Test failed');
  }
};

// VIOLATION: Not wrapped in describe/it blocks
testFunction();

// VIOLATION: No proper test coverage structure
function anotherTest() {
  const value = 'test';
  // VIOLATION: Manual assertion instead of expect
  if (value !== 'test') {
    console.error('Failed');
  }
}

// VIOLATION: Missing edge cases and error path testing
function helperFunction(input: number): number {
  return input * 2;
}

// VIOLATION: Test doesn't cover edge cases (negative, zero, large numbers)
// VIOLATION: No describe/it structure
const quickTest = () => {
  const result = helperFunction(5);
  if (result !== 10) {
    throw new Error('Math is broken');
  }
};

quickTest();

export { testFunction, anotherTest, quickTest };
