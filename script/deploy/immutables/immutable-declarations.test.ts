/**
 * Fixtures are the real declaration shapes found across `src/`: every visibility,
 * interface and value types, arrays, and the comment forms that sit next to them.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  findUnreadableImmutableLines,
  parseImmutableDeclarations,
} from './immutable-declarations'

const parse = (source: string) =>
  parseImmutableDeclarations(source, 'src/Facets/Example.sol')

describe('parseImmutableDeclarations', () => {
  it.each([
    [
      'a public interface type',
      '    IGlacisAirlift public immutable AIRLIFT;',
      'AIRLIFT',
      'IGlacisAirlift',
      'public',
    ],
    [
      'a private interface type',
      '    IOmniBridge private immutable foreignOmniBridge;',
      'foreignOmniBridge',
      'IOmniBridge',
      'private',
    ],
    [
      'a public address',
      '    address public immutable POOL_MANAGER;',
      'POOL_MANAGER',
      'address',
      'public',
    ],
    [
      'a private address',
      '    address private immutable erc20Predicate;',
      'erc20Predicate',
      'address',
      'private',
    ],
    ['a bool', '    bool public immutable IS_HUB;', 'IS_HUB', 'bool', 'public'],
    [
      'a uint256',
      '    uint256 public immutable RECOVER_GAS;',
      'RECOVER_GAS',
      'uint256',
      'public',
    ],
    [
      'an internal visibility',
      '    address internal immutable OWNER;',
      'OWNER',
      'address',
      'internal',
    ],
    [
      'a payable address, which is two words',
      '    address payable public immutable POLYMER_FEE_RECEIVER;',
      'POLYMER_FEE_RECEIVER',
      'address payable',
      'public',
    ],
  ])('reads %s', (_label, line, name, type, visibility) => {
    const found = parse(`contract A {\n${line}\n}`)

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ name, type, visibility })
  })

  it('records where each one is, because the registry has to point at it', () => {
    const found = parse(
      'contract A {\n\n    address public immutable ONE;\n    bool private immutable TWO;\n}'
    )

    expect(found.map((d) => [d.name, d.line])).toEqual([
      ['ONE', 3],
      ['TWO', 4],
    ])
    expect(found[0]?.file).toBe('src/Facets/Example.sol')
  })

  it('omits visibility when the declaration does', () => {
    // Solidity allows it; the default is internal, but recording what is written
    // rather than what it means keeps the registry honest about the source.
    const found = parse('contract A {\n    address immutable OWNER;\n}')

    expect(found).toHaveLength(1)
    expect(found[0]?.visibility).toBeUndefined()
    expect(found[0]?.name).toBe('OWNER')
  })

  it.each([
    [
      'a line comment mentioning the word',
      '    // this value is immutable once set',
    ],
    ['a docstring line', '     * @notice immutable after construction'],
    ['a block comment opener', '    /* immutable */'],
    ['a string containing it', '    string memory note = "immutable";'],
    ['a variable merely named like it', '    address public immutableOwner;'],
    [
      'a constant, which is a different thing',
      '    address public constant ZERO = address(0);',
    ],
  ])('does not mistake %s for a declaration', (_label, line) => {
    expect(parse(`contract A {\n${line}\n}`)).toEqual([])
  })

  it('finds every declaration in a file, not just the first', () => {
    const found = parse(
      [
        'contract A {',
        '    IGasZip public immutable GAS_ZIP_ROUTER;',
        '    address private immutable erc20Predicate;',
        '    uint256 public immutable RECOVER_GAS;',
        '}',
      ].join('\n')
    )

    expect(found.map((d) => d.name)).toEqual([
      'GAS_ZIP_ROUTER',
      'erc20Predicate',
      'RECOVER_GAS',
    ])
  })

  it('keeps a trailing comment out of the type', () => {
    const found = parse(
      'contract A {\n    address public immutable OWNER; // set at construction\n}'
    )

    expect(found[0]).toMatchObject({ name: 'OWNER', type: 'address' })
  })
})

describe('findUnreadableImmutableLines', () => {
  it('reports a declaration wrapped across lines', () => {
    // The shape CodeRabbit found. It parses as nothing, so without this the
    // immutable is never asked for — invisible rather than unanswered.
    const source = [
      'contract A {',
      '    IVeryLongInterfaceName',
      '        public',
      '        immutable',
      '        SOME_TARGET;',
      '}',
    ].join('\n')

    const unreadable = findUnreadableImmutableLines(source, 'src/A.sol')

    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).toMatchObject({ line: 4, file: 'src/A.sol' })
    expect(parseImmutableDeclarations(source, 'src/A.sol')).toEqual([])
  })

  it('says nothing about a declaration it can read', () => {
    const source = 'contract A {\n    address public immutable OWNER;\n}'

    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it.each([
    ['a line comment', '    // set once, immutable thereafter'],
    ['a natspec tag', '    /// @notice immutable after construction'],
    ['a block-comment body', '     * the immutable value'],
    ['a mid-line natspec tag', '    /** @dev immutable */'],
  ])('does not report %s', (_label, line) => {
    expect(
      findUnreadableImmutableLines(`contract A {\n${line}\n}`, 'src/A.sol')
    ).toEqual([])
  })

  it('reports the payable form if the parser ever loses it again', () => {
    // Guards the regression directly: this line parses today, so it must not be
    // reported — and if the type pattern narrows again, it becomes an error
    // rather than silence.
    const source =
      'contract A {\n    address payable public immutable FEE_RECEIVER;\n}'

    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
    expect(parseImmutableDeclarations(source, 'src/A.sol')).toHaveLength(1)
  })
})
