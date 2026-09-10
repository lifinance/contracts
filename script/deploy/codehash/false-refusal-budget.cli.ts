/**
 * Prints the WP-8.4 false-refusal budget for this checkout.
 *
 * Takes no arguments on purpose. Every input is the repository itself, and a
 * flag that narrowed the corpus would be a way to reach a rate of zero by
 * measuring less.
 *
 * Exit code is 1 when any gate carries an unexplained refusal, so CI can hold
 * the budget at 0 without anyone reading the table. It is NOT 1 merely because
 * a gate is not promotable — that is the expected state of a report-only gate.
 */

import { consola } from 'consola'

import { evaluatePromotion, renderBudgetReport } from './false-refusal-budget'
import { loadRepoCorpus, runShadowBudget } from './false-refusal-budget-run'

const main = async (): Promise<void> => {
  // The gates log a line per call, and the corpus is ~2,300 calls. Only the
  // info stream is dropped: a gate states its verdict by throwing or by what
  // it returns, never by logging, so nothing the budget counts is suppressed.
  const level = consola.level
  consola.level = 1
  const budgets = await runShadowBudget(loadRepoCorpus(process.cwd()))
  consola.level = level

  for (const line of renderBudgetReport(budgets)) consola.log(line)

  consola.log('')
  let unexplained = 0
  for (const budget of budgets) {
    unexplained += budget.unexplained
    const verdict = evaluatePromotion(budget)
    if (verdict.mayEnforce) {
      consola.log(`${budget.gate}: may flip report-only to blocking.`)
      continue
    }
    consola.log(`${budget.gate}: stays report-only.`)
    for (const blocker of verdict.blockers) consola.log(`  - ${blocker}`)
  }

  consola.log('')
  consola.log(`Unexplained refusals across every gate: ${unexplained}`)
  if (unexplained > 0) process.exitCode = 1
}

void main()
