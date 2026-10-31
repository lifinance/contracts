// Prettier formats *.sol here (TS/JS use oxfmt, see .oxfmtrc.json). It stays on
// Prettier 2 + prettier-plugin-solidity 1.x: Prettier 3 + plugin 2 reformats
// src/*.sol, and any src/*.sol change alters those contracts' bytecode metadata.
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
        singleQuote: false,
      },
    },
  ],
}
