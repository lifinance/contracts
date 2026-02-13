/**
 * AI-powered Contract Change Analyzer
 * 
 * Uses AI (OpenAI/Anthropic) to generate semantic descriptions of contract changes
 */

interface AIAnalysisResult {
  summary: string
  breaking: string[]
  added: string[]
  changed: string[]
  removed: string[]
  fixed: string[]
  context: string
}

interface ContractDiff {
  file: string
  contractName: string
  oldContent: string
  newContent: string
  diff: string
}

/**
 * Analyze contract changes using AI
 */
export async function analyzeContractChangesWithAI(
  diff: ContractDiff,
  apiKey?: string,
  provider: 'openai' | 'anthropic' = 'openai'
): Promise<AIAnalysisResult> {
  const key = apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
  
  if (!key) {
    throw new Error('No API key provided. Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable')
  }

  if (provider === 'openai') {
    return analyzeWithOpenAI(diff, key)
  } else {
    return analyzeWithAnthropic(diff, key)
  }
}

/**
 * Analyze using OpenAI API
 */
async function analyzeWithOpenAI(diff: ContractDiff, apiKey: string): Promise<AIAnalysisResult> {
  const prompt = buildAnalysisPrompt(diff)
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content: 'You are a Solidity smart contract expert analyzing code changes for changelog generation. Provide concise, technical descriptions of what changed and why.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`)
    }

    const data = await response.json()
    const content = data.choices[0]?.message?.content || ''
    
    return parseAIResponse(content, diff.contractName)
  } catch (error) {
    console.error('Error calling OpenAI API:', error)
    throw error
  }
}

/**
 * Analyze using Anthropic Claude API
 */
async function analyzeWithAnthropic(diff: ContractDiff, apiKey: string): Promise<AIAnalysisResult> {
  const prompt = buildAnalysisPrompt(diff)
  
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 2000,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: `You are a Solidity smart contract expert analyzing code changes for changelog generation. Provide concise, technical descriptions of what changed and why.\n\n${prompt}`,
          },
        ],
      }),
    })

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.statusText}`)
    }

    const data = await response.json()
    const content = data.content[0]?.text || ''
    
    return parseAIResponse(content, diff.contractName)
  } catch (error) {
    console.error('Error calling Anthropic API:', error)
    throw error
  }
}

/**
 * Build analysis prompt for AI
 */
function buildAnalysisPrompt(diff: ContractDiff): string {
  return `Analyze the following Solidity contract changes and provide a structured changelog entry.

Contract: ${diff.contractName}
File: ${diff.file}

Git Diff:
\`\`\`diff
${diff.diff}
\`\`\`

Please analyze the changes and respond in the following JSON format:
{
  "summary": "One-sentence summary of all changes",
  "breaking": ["List of breaking changes with WHY they're breaking"],
  "added": ["List of added features/functions with WHAT they do"],
  "changed": ["List of modified features with WHAT changed and WHY"],
  "removed": ["List of removed features with WHAT was removed"],
  "fixed": ["List of bug fixes with WHAT was fixed"],
  "context": "Additional context about the changes (upgrade notes, security implications, etc.)"
}

Guidelines:
- Be concise but specific
- Focus on WHAT changed and WHY (not just "added function X")
- Flag breaking changes (storage layout, function signature changes, removals)
- Mention security implications if any
- Use technical language appropriate for smart contract developers
- Keep each item to 1-2 sentences max

Example of good descriptions:
- "Added \`batchTransfer\` function to enable gas-efficient multi-recipient transfers"
- "Modified \`withdraw\` to use checks-effects-interactions pattern, fixing reentrancy vulnerability"
- "Removed deprecated \`oldBridge\` function (use \`bridgeV2\` instead)"
- "Changed storage layout by adding new state variable, requires redeployment for upgradeable contracts"

Respond ONLY with the JSON object, no additional text.`
}

/**
 * Parse AI response into structured format
 */
function parseAIResponse(content: string, contractName: string): AIAnalysisResult {
  try {
    // Try to extract JSON from response (AI might add markdown formatting)
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response')
    }
    
    const parsed = JSON.parse(jsonMatch[0])
    
    // Validate required fields
    if (!parsed.summary || !Array.isArray(parsed.breaking) || !Array.isArray(parsed.added)) {
      throw new Error('Invalid JSON structure in AI response')
    }
    
    // Prefix all items with contract name
    const prefixItems = (items: string[]) => 
      items.map(item => `\`${contractName}\`: ${item}`)
    
    return {
      summary: parsed.summary,
      breaking: prefixItems(parsed.breaking || []),
      added: prefixItems(parsed.added || []),
      changed: prefixItems(parsed.changed || []),
      removed: prefixItems(parsed.removed || []),
      fixed: prefixItems(parsed.fixed || []),
      context: parsed.context || '',
    }
  } catch (error) {
    console.error('Error parsing AI response:', error)
    console.error('Raw response:', content)
    throw new Error(`Failed to parse AI response: ${error}`)
  }
}

/**
 * Get git diff for a file between two commits
 */
export function getFileDiff(file: string, oldCommit: string, newCommit: string): string {
  const { execSync } = require('child_process')
  try {
    return execSync(`git diff ${oldCommit} ${newCommit} -- ${file}`, { 
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    })
  } catch (error) {
    console.error(`Error getting diff for ${file}:`, error)
    return ''
  }
}

/**
 * Build ContractDiff object for AI analysis
 */
export function buildContractDiff(
  file: string,
  contractName: string,
  oldContent: string | null,
  newContent: string,
  diff: string
): ContractDiff {
  return {
    file,
    contractName,
    oldContent: oldContent || '',
    newContent,
    diff,
  }
}
