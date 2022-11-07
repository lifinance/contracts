module.exports = {
  env: {
    es2021: true,
    mocha: true,
    node: true
  },
  root: true,
  extends: [
    'prettier',
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/errors',
    'plugin:import/warnings'
  ],
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-unused-vars': 'error',
    '@typescript-eslint/no-use-before-define': 'error',
    'arrow-body-style': 'off',
    camelcase: ['error', { allow: ['^.*__factory$'] }],
    'import/extensions': [
      'error',
      'ignorePackages',
      {
        js: 'never',
        ts: 'never'
      }
    ],
    'import/no-extraneous-dependencies': 'off',
    'import/no-useless-path-segments': 'off',
    'import/prefer-default-export': 'off',
    'no-console': 'off',
    'no-empty-function': 'off',
    'no-param-reassign': 'warn',
    'no-plusplus': ['off'],
    'no-underscore-dangle': 'warn',
    'no-unused-vars': 'off',
    'no-use-before-define': 'off',
    'prefer-destructuring': 'off',
    'prefer-template': 'off'
  },
  settings: {
    'import/resolver': {
      node: {
        extensions: ['.d.ts', '.js', '.ts']
      }
    }
  }
};
