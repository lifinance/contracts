// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  ACCEPTED_FALSE_RED_RULES,
  adjudicateRefusal,
  evaluatePromotion,
  renderBudgetReport,
  summariseGate,
  type IShadowObservation,
} from './false-refusal-budget'

const observation = (
  overrides: Partial<IShadowObservation> = {}
): IShadowObservation => ({
  gate: 'G-test',
  slot: 'somenetwork/SomeFacet@1.0.0',
  refused: true,
  reason: 'refused',
  ...overrides,
})

const budgetOf = (observations: IShadowObservation[], denominator = 10) =>
  summariseGate({
    gate: 'G-test',
    corpus: 'test rows',
    denominator,
    coverageNote: 'test',
    observations,
  })

describe('the accepted-false-red rule list', () => {
  it('has unique ids and a remedy on every rule', () => {
    const ids = ACCEPTED_FALSE_RED_RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of ACCEPTED_FALSE_RED_RULES) {
      expect(rule.remedy.length).toBeGreaterThan(0)
      expect(rule.namedBy.length).toBeGreaterThan(0)
    }
  })

  // Pinned by literal grade rather than by comparing rule.remedyGrade to
  // itself: the promotion criterion turns entirely on these three values, and
  // an assertion that moves with the constant would let all three become grey
  // with the suite still green.
  it('grades the two compiler-set classes red and the config class grey', () => {
    const grades = Object.fromEntries(
      ACCEPTED_FALSE_RED_RULES.map((rule) => [rule.id, rule.remedyGrade])
    )
    expect(grades).toEqual({
      'AFR-1-retired-pin': 'red',
      'AFR-2-cross-profile-network': 'red',
      'AFR-3-unresolvable-network': 'grey',
    })
  })
})

describe('adjudicateRefusal', () => {
  it('sorts a refusal carrying a known rule id into accepted-false-red', () => {
    const result = adjudicateRefusal(
      observation({ ruleId: 'AFR-1-retired-pin' })
    )
    expect(result.adjudication).toBe('accepted-false-red')
    expect(result.rule?.id).toBe('AFR-1-retired-pin')
  })

  it('sorts a refusal carrying no rule id into unexplained', () => {
    const result = adjudicateRefusal(observation())
    expect(result.adjudication).toBe('unexplained')
    expect(result.rule).toBeUndefined()
  })

  it('sorts a refusal naming a rule that does not exist into unexplained', () => {
    const result = adjudicateRefusal(
      observation({ ruleId: 'AFR-99-invented-on-the-spot' })
    )
    expect(result.adjudication).toBe('unexplained')
  })

  it('sorts a true positive as one even when a rule id is also supplied', () => {
    const result = adjudicateRefusal(
      observation({ truePositive: true, ruleId: 'AFR-1-retired-pin' })
    )
    expect(result.adjudication).toBe('true-positive')
  })
})

describe('summariseGate', () => {
  it('counts only refusals, and carries the denominator through', () => {
    const budget = budgetOf(
      [
        observation({ refused: false, reason: '' }),
        observation({ ruleId: 'AFR-1-retired-pin' }),
        observation({ ruleId: 'AFR-1-retired-pin' }),
        observation({ truePositive: true }),
        observation(),
      ],
      5
    )
    expect(budget.denominator).toBe(5)
    expect(budget.refusals).toBe(4)
    expect(budget.falseRefusalRate).toBeCloseTo(0.8)
    expect(budget.acceptedFalseReds).toBe(2)
    expect(budget.truePositives).toBe(1)
    expect(budget.unexplained).toBe(1)
    expect(budget.byRule).toEqual([['AFR-1-retired-pin', 2]])
  })

  it('reports no rate at all when nothing was measured', () => {
    const budget = budgetOf([], 0)
    expect(budget.falseRefusalRate).toBeUndefined()
  })

  it('refuses a numerator that can exceed its denominator', () => {
    expect(() => budgetOf([observation(), observation()], 1)).toThrow(
      /not a measurement/
    )
  })
})

describe('evaluatePromotion — the shipped control', () => {
  it('promotes a gate measured on real rows with nothing unexplained and no red class', () => {
    const budget = budgetOf([observation({ refused: false, reason: '' })], 100)
    const verdict = evaluatePromotion(budget)
    expect(verdict.mayEnforce).toBe(true)
    expect(verdict.blockers).toEqual([])
  })

  it('refuses to promote a gate measured on 0 rows', () => {
    const verdict = evaluatePromotion(budgetOf([], 0))
    expect(verdict.mayEnforce).toBe(false)
    expect(verdict.blockers.join(' ')).toContain('measured on 0 rows')
  })

  it('refuses to promote a gate carrying one unexplained refusal', () => {
    const verdict = evaluatePromotion(budgetOf([observation()], 100))
    expect(verdict.mayEnforce).toBe(false)
    expect(verdict.blockers.join(' ')).toContain('1 unexplained refusal')
  })

  it('refuses to promote a gate whose accepted class grades red', () => {
    const verdict = evaluatePromotion(
      budgetOf([observation({ ruleId: 'AFR-1-retired-pin' })], 100)
    )
    expect(verdict.mayEnforce).toBe(false)
    expect(verdict.blockers.join(' ')).toContain('grades red, not grey')
  })

  // The paired present for the clause above: a grey class must NOT block, or
  // the criterion is "no false reds at all" wearing the grading rule's name.
  it('promotes a gate whose only accepted class grades grey', () => {
    const verdict = evaluatePromotion(
      budgetOf([observation({ ruleId: 'AFR-3-unresolvable-network' })], 100)
    )
    expect(verdict.mayEnforce).toBe(true)
  })

  it('reports every blocker, not just the first', () => {
    const verdict = evaluatePromotion(
      budgetOf([observation(), observation({ ruleId: 'AFR-1-retired-pin' })], 2)
    )
    expect(verdict.blockers.length).toBe(2)
  })
})

describe('renderBudgetReport', () => {
  it('prints a denominator on every row and never a bare dash for no data', () => {
    const lines = renderBudgetReport([
      budgetOf([observation({ ruleId: 'AFR-1-retired-pin' })], 100),
      budgetOf([], 0),
    ])
    expect(lines[2]).toContain('1 / 100')
    expect(lines[3]).toContain('0 / 0')
    expect(lines[3]).toContain('measured on 0')
    expect(lines[3]).not.toContain('0.0%')
  })
})
