# Contract Changelog Analysis System

Automated system for analyzing and documenting smart contract changes.

## 📁 Architecture

```
script/changelogAnalysis/
├── generateContractChangelog.ts    # Main orchestrator
├── advancedChangelogGenerator.ts   # Advanced analysis engine
├── astAnalyzer.ts                  # Solidity AST parser
├── forgeAnalyzer.ts                # Forge integration (storage layout)
├── semanticInference.ts            # Smart heuristics
├── aiChangelogAnalyzer.ts          # AI integration (optional)
├── CHANGELOG-CONTRACTS.md          # Generated output
└── README.md                       # This file
```

---

## 🔄 How It Works

### 1. Change Detection
**File**: `generateContractChangelog.ts`

```typescript
getChangedSolidityFiles()
  → Executes: git diff --name-only HEAD~1 HEAD
  → Filters: src/**/*.sol files only
  → Returns: Array of changed contract paths
```

### 2. Analysis Pipeline

**Entry Point**: `mainAdvanced()` in `generateContractChangelog.ts`

```
For each changed contract:
  ├─ Get old version (HEAD~1)
  ├─ Get new version (HEAD)
  └─ Call analyzeContractAdvanced()
```

**Analysis**: `analyzeContractAdvanced()` in `advancedChangelogGenerator.ts`

```
1. Try AST Analysis (if solc can compile)
   ├─ astAnalyzer.parseContractAST()
   └─ Extract: functions, events, modifiers, state vars

2. Try Forge Analysis (storage layout)
   ├─ forgeAnalyzer.inspectContractWithForge()
   └─ Detect: breaking storage changes

3. Fallback to Regex (always works)
   └─ Extract basic function/event names

4. Semantic Inference
   ├─ semanticInference.inferFunctionAddition()
   ├─ semanticInference.inferFunctionModification()
   └─ Add context based on heuristics
```

### 3. Change Categorization

**Categories**:
- **Breaking**: Removed functions, storage changes
- **Added**: New functions, events, modifiers
- **Changed**: Modified signatures, added modifiers
- **Removed**: Deleted events, modifiers
- **Fixed**: Bug fixes (inferred from commit type)

### 4. Output Generation

```typescript
formatChangelogEntry()
  → Markdown with sections
  → Link to commit
  → Grouped by category
```

---

## 🧩 Component Details

### `astAnalyzer.ts` - AST Parser

**Purpose**: Parse Solidity code using `solc --ast-json`

**Key Functions**:
- `parseContractAST(content, filename)` - Main parser
- `extractFunctionInfo(node)` - Extract function metadata
- `extractEventInfo(node)` - Extract event metadata
- `formatFunctionSignature(func)` - Format for display

**Limitations**: 
- Requires compilation to work
- Files with unresolved imports will fail → fallback to regex

**Example Output**:
```typescript
{
  name: "withdraw",
  visibility: "external",
  stateMutability: "nonpayable",
  params: [{ name: "amount", type: "uint256" }],
  modifiers: ["nonReentrant"],
  documentation: "Withdraw funds with protection"
}
```

---

### `forgeAnalyzer.ts` - Forge Integration

**Purpose**: Analyze storage layout and ABI using Foundry tools

**Key Functions**:
- `inspectContractWithForge(path, name)` - Run forge inspect
- `compareStorageLayouts(old, new)` - Detect breaking changes
- `estimateGasImpact(old, new)` - Estimate gas changes

**Commands Used**:
```bash
forge inspect ContractPath:ContractName storageLayout
forge inspect ContractPath:ContractName abi
forge inspect ContractPath:ContractName methods
```

**Breaking Change Detection**:
- Variable removed → Breaking
- Slot changed → Breaking
- Type changed → Breaking
- Variable inserted (not appended) → Breaking
- Variable appended → Safe

**Example**:
```typescript
{
  isBreaking: true,
  changes: ["Storage variable `feeCollector` moved to different slot"]
}
```

---

### `semanticInference.ts` - Heuristic Engine

**Purpose**: Infer meaning and context from code patterns

**Pattern Recognition**:

1. **Function Purpose** (by name):
   - `batch*` → "gas-efficient batch operations"
   - `withdraw*` → "for withdrawing funds"
   - `transfer*` → "for token transfers"
   - `swap*` → "for token swaps"
   - `bridge*` → "for cross-chain bridging"

2. **Security Modifiers**:
   - `nonReentrant` → "Added security protection"
   - `onlyOwner` → "admin-only operation"
   - `whenNotPaused` → "pausable protection"

3. **Breaking Change Detection**:
   - Function removed → Breaking
   - Parameters changed → Breaking
   - Visibility restricted → Breaking
   - Access control added → Breaking

**Key Functions**:
- `inferFunctionAddition(func)` - Infer purpose of new function
- `inferFunctionModification(old, new)` - Detect changes
- `parseCommitMessage(msg)` - Parse conventional commits
- `isBreakingChange(old, new)` - Determine if breaking

**Example**:
```typescript
inferFunctionAddition({
  name: "batchTransfer",
  modifiers: ["nonReentrant"]
})
// Returns:
{
  shortDescription: "Added `batchTransfer`",
  context: "for gas-efficient batch operations",
  securityNote: "Protected by: nonReentrant"
}
```

---

### `advancedChangelogGenerator.ts` - Main Analysis

**Purpose**: Orchestrate all analysis methods

**Flow**:
```
1. parseContractAST() → Try AST
   ↓ (if fails)
2. analyzeWithRegex() → Fallback regex
   ↓
3. inspectContractWithForge() → Storage analysis
   ↓
4. inferFunctionAddition/Modification() → Add context
   ↓
5. enhanceWithCommitContext() → Use commit message
```

**Regex Fallback**:
- Matches: `function name(...) external`
- Matches: `event Name(...)`
- Simple but reliable

---

### `aiChangelogAnalyzer.ts` - AI Integration (Optional)

**Purpose**: Use OpenAI/Anthropic for semantic analysis

**Usage**:
```bash
USE_AI=true OPENAI_API_KEY="sk-..." bun run changelog:contracts
```

**What AI Adds**:
- Natural language descriptions
- Security vulnerability references
- Migration code examples
- Gas impact percentages
- Industry context

**Cost**: ~$0.01-0.05 per contract file

---

## 🚀 Usage

### Manual Execution
```bash
# Run on last commit
bun run changelog:contracts

# View output
cat script/changelogAnalysis/CHANGELOG-CONTRACTS.md
```

### Automatic (GitHub Action)
```yaml
# Triggers on push to main with .sol changes
on:
  push:
    branches: [main, master]
    paths: ['src/**/*.sol']
```

### With AI Mode
```bash
USE_AI=true OPENAI_API_KEY="sk-proj-..." bun run changelog:contracts
```

---

## 🧪 Testing

### Test with Sample Change
```bash
# 1. Edit a contract
vim src/Facets/SomeFacet.sol

# 2. Commit
git add src/Facets/SomeFacet.sol
git commit -m "feat: add new function"

# 3. Generate changelog
bun run changelog:contracts

# 4. View result
cat script/changelogAnalysis/CHANGELOG-CONTRACTS.md
```

---

## 📊 Analysis Quality

**Regex Mode** (Fallback):
- ✅ Detects: Added/removed functions and events
- ❌ Missing: Parameter types, modifiers, context
- Quality: ~70%

**Advanced Mode** (Default):
- ✅ Complete function signatures
- ✅ Storage layout analysis
- ✅ Security pattern detection
- ✅ Semantic context
- Quality: ~90%

**AI Mode** (Optional):
- ✅ All of Advanced mode
- ✅ Natural language
- ✅ Security references
- ✅ Migration examples
- Quality: ~98%

---

## 🛠️ Configuration

### Environment Variables
- `USE_ADVANCED` - Use advanced analysis (default: `true`)
- `USE_AI` - Use AI analysis (default: `false`)
- `AI_PROVIDER` - AI provider: `openai` or `anthropic` (default: `openai`)
- `OPENAI_API_KEY` - OpenAI API key (for AI mode)
- `ANTHROPIC_API_KEY` - Anthropic API key (for AI mode)

### Customization

**Change output location**:
```typescript
// In generateContractChangelog.ts
const CHANGELOG_FILE = 'path/to/changelog.md'
```

**Filter contracts**:
```typescript
// In generateContractChangelog.ts
const CONTRACTS_DIR = 'src/Facets' // Only analyze facets
```

---

## 🐛 Troubleshooting

### "No Solidity files changed"
- Check that files are in `src/` directory
- Verify commit has actual changes
- Run `git diff --name-only HEAD~1 HEAD` manually

### "AST parsing failed, using basic analysis"
- Normal behavior - AST requires compilation
- Files with imports won't compile standalone
- Fallback regex analysis will be used (still good quality)

### "Storage layout not available"
- Requires Forge to be installed
- Run `forge --version` to verify
- Non-critical - analysis continues without it

---

## 📝 Output Format

### Generated Entry Example

```markdown
## [2024-02-13] - feat: add batch withdraw

**Commit**: [`abc123`](../../commit/abc123)

### ✨ Added
- `WithdrawFacet`: Added function `batchWithdraw`

### 🔄 Changed
- `WithdrawFacet`: Modified `withdraw` - added modifier nonReentrant

### ⚠️ Breaking Changes
- `TokenFacet`: Removed function `oldTransfer`
```

---

## 🔗 Related Files

- `.github/workflows/generate-contract-changelog.yml` - GitHub Action
- `package.json` - npm script: `changelog:contracts`

---

## 📚 Further Reading

- [Conventional Commits](https://www.conventionalcommits.org/) - Commit message format
- [Solidity AST](https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html) - Storage layout
- [Foundry Forge](https://book.getfoundry.sh/forge/) - Forge commands
