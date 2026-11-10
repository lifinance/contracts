// Prettier formats only src/**/*.sol (audited contracts). TS/JS uses oxfmt,
// test/ and script/ Solidity use forge fmt. prettier-plugin-solidity is pinned
// to 1.4.3 because 2.x reformats audited sources and changes their hashes.
module.exports = {
  plugins: ['prettier-plugin-solidity'],
  overrides: [
    {
      files: '*.sol',
      options: {
        printWidth: 79,
        tabWidth: 4,
        singleQuote: false,
        bracketSpacing: true,
        endOfLine: 'lf',
      },
    },
  ],
}
