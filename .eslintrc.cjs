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
    'curly': ['error', 'multi'], // Allow single-line statements without braces
    "import/no-self-import": 'error',
    "import/no-useless-path-segments": 'error',
    "import/no-unused-modules": 'error',
    "import/no-deprecated": 'error',
    "import/no-extraneous-dependencies": 'error',
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
    
    // Prevent potential errors
    'no-template-curly-in-string': 'error', // Warns about `${var}` in regular strings
    'no-throw-literal': 'error', // Requires throwing Error objects instead of literals
    
    // // TypeScript specific enhancements
    // '@typescript-eslint/explicit-member-accessibility': ['error', { // Enforce explicit accessibility modifiers
    //   accessibility: 'explicit',
    //   overrides: {
    //     constructors: 'no-public'
    //   }
    // }],
    // '@typescript-eslint/consistent-type-imports': ['error', { // Enforce consistent type imports
    //   prefer: 'type-imports'
    // }],
    // '@typescript-eslint/no-floating-promises': 'error', // Requires Promise handling
    
    // // Code style and maintainability
    // 'max-depth': ['error', 4], // Limit nesting depth
    // 'complexity': ['error', 15], // Limit cyclomatic complexity
    // 'max-lines-per-function': ['error', { 
    //   max: 50,
    //   skipBlankLines: true,
    //   skipComments: true
    // }],
    
    // // Modern JavaScript practices
    // 'prefer-template': 'error', // Encourage template literals over string concatenation
    // 'prefer-nullish-coalescing': 'error', // Encourage ?? over ||
    // 'prefer-optional-chain': 'error', // Encourage ?. over && chaining
    
    // // Import enhancements
    // 'import/no-mutable-exports': 'error', // Prevents exporting let or var
    // 'import/no-relative-parent-imports': 'error', // Prevents ../../../ style imports
    // 'import/no-namespace': 'error', // Prevents import * as namespace
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
