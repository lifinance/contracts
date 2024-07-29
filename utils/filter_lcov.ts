import * as readline from 'readline'
import * as fs from 'fs'

// this script helps to produce a clean (test) coverage report for our Solidity contracts
// forge coverage usually checks coverage for all contracts (including test and script contracts)
// we will generate a LCOV report with forge coverage, then filter out all unwanted data (keep only coverage info for src/ folder)
async function filterLcov(
  inputFile: string,
  outputFile: string,
  excludePatterns: string[]
) {
  const fileStream = fs.createReadStream(inputFile)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  const output = fs.createWriteStream(outputFile)

  let include = true
  for await (const line of rl) {
    if (line.startsWith('SF:')) {
      include = true
      for (const pattern of excludePatterns) {
        if (line.includes(pattern)) {
          include = false
          break
        }
      }
    }
    if (include) {
      output.write(line + '\n')
    }
  }

  output.close()
}

const args = process.argv.slice(2)
if (args.length < 3) {
  console.error(
    'Usage: ts-node filter_lcov.ts input_file output_file pattern1 [pattern2 ...]'
  )
  process.exit(1)
}

const [inputFile, outputFile, ...excludePatterns] = args

filterLcov(inputFile, outputFile, excludePatterns)
  .then(() => console.log('Filtering complete'))
  .catch((err) => console.error('Error during filtering:', err))
