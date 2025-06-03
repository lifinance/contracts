module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020, // Allows for the parsing of modern ECMAScript features
    sourceType: 'module', // Allows for the use of imports
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  env: {
    node: true,
    commonjs: true,
    es6: true,
  },
  plugins: [
    '@typescript-eslint',
    'import'
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    // // General
    // 'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    'no-empty': 'off',
    'no-empty-function': 'off',
    
    // TypeScript specific
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    // '@typescript-eslint/explicit-function-return-type': ['error', {
    //   allowExpressions: true,
    //   allowTypedFunctionExpressions: true,
    // }],
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    }],
    '@typescript-eslint/no-misused-promises': 'error',
    'no-duplicate-imports': 'error',
    'eqeqeq': ['error', 'always'],
    'prefer-const': 'error',
    'import/no-cycle': 'error',
    'import/first': 'error', // Ensures all imports are at the top of the file
    'import/no-duplicates': 'error', // Consolidates import statements from the same module
    'no-async-promise-executor': 'error', // Disallows async functions as Promise executors
    'no-promise-executor-return': 'error', // Disallows returning values from Promise executors
    'require-atomic-updates': 'error', // Prevents race conditions with async/await
    
    // Import rules
    'import/order': ['error', {
      'groups': [
        'builtin',
        'external',
        'internal',
        'parent',
        'sibling',
        'index',
      ],
      'newlines-between': 'always',
      'alphabetize': { order: 'asc' }
    }],
  },
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.json'
      }
    }
  },
}
