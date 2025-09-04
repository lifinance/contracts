module.exports = {
  singleQuote: true,
  bracketSpacing: true,
  semi: false,
  trailingComma: 'es5',
  printWidth: 80,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    {
      files: '*.sol',
      options: {
        printWidth: 79,
        tabWidth: 4,
      },
    },
    {
      files: '*.ts',
      options: {
        parser: 'typescript',
      },
    },
  ],
}
