module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // Allows for the parsing of modern ECMAScript features
    sourceType: 'module', // Allows for the use of imports
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
  },
  env: {
    node: true,
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
    // General JavaScript rules
    'no-empty': 'off',
    'no-empty-function': 'off',
    'eqeqeq': ['error', 'always'],
    'prefer-const': 'error',
    'curly': ['error', 'multi'], // Allow single-line statements without braces
    'no-template-curly-in-string': 'error', // Warns about `${var}` in regular strings
    'no-throw-literal': 'error', // Requires throwing Error objects instead of literals
    '@typescript-eslint/return-await': ['error', 'in-try-catch'], // More nuanced control over return await
    'no-var': 'error', // Prefer let/const over var
    'no-unused-expressions': 'error', // Prevents unused expressions
    'no-eval': 'error', // Prevents eval() usage
    'default-case': 'error', // Requires default case in switch statements

    // TypeScript-specific rules
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    }],
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { // Enforce consistent type imports
      prefer: 'type-imports'
    }],
    '@typescript-eslint/explicit-member-accessibility': ['error', { 
      accessibility: 'explicit' 
    }], // Enforce explicit accessibility modifiers
    '@typescript-eslint/await-thenable': 'error', // Ensures await is only used with Promises

    // Promise and async/await rules
    'no-async-promise-executor': 'error', // Disallows async functions as Promise executors

    // Import/Export rules
    'no-duplicate-imports': 'error',
    'import/no-cycle': 'error',
    'import/first': 'error', // Ensures all imports are at the top of the file
    'import/no-duplicates': 'error', // Consolidates import statements from the same module
    'import/no-self-import': 'error',
    'import/no-useless-path-segments': 'error',
    'import/no-unused-modules': 'error',
    'import/no-deprecated': 'error',
    'import/no-extraneous-dependencies': 'error',
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
    'import/no-default-export': 'error', // Prefer named exports
    'import/no-mutable-exports': 'error', // Prevents mutable exports

    // Code style consistency
    '@typescript-eslint/consistent-type-definitions': ['error', 'interface'], // Prefer interface over type
    '@typescript-eslint/method-signature-style': ['error', 'property'], // Consistent method signatures
    '@typescript-eslint/naming-convention': [
      'error',
      {
        selector: 'interface',
        format: ['PascalCase'],
        prefix: ['I']
      },
      {
        selector: 'typeAlias',
        format: ['PascalCase']
      },
      {
        selector: 'enum',
        format: ['PascalCase'],
        suffix: ['Enum']
      }
    ],
  },
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.eslint.json'
      }
    }
  },
}
