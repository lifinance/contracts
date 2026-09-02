/**
 * Fixtures are the real declaration shapes found across `src/`: every visibility,
 * interface and value types, and the comment forms that sit next to them. No
 * array fixture exists because solc rejects a non-value type as immutable.
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
    // Carries its own `/**` opener: the body is only a comment because the
    // opener precedes it, and that is what the masking pass reads. A bare `*`
    // line with no opener is code, and code mentioning the word is reported.
    ['a block-comment body', '    /**\n     * the immutable value\n     */'],
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

describe('comments and string literals are masked before anything reads a line', () => {
  it('parses both declarations on one line, rather than reporting the second', () => {
    // Valid Solidity, and nothing in CI reformats it — no workflow runs prettier
    // or solhint. The parser was anchored to the start of the line, so it could
    // only ever read the first, and the second was reported as unreadable.
    const source =
      'contract A {\n    address public immutable A_ONE; address public immutable A_TWO;\n}'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['A_ONE', 'A_TWO'])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it('parses three on one line, so the count comparison cannot pass by luck', () => {
    // The control the suite previously lacked: its fixture carried one
    // declaration, and the assertion could not fail, because a line-anchored
    // parser caps the parsed-per-line count at 1 by construction.
    const source =
      'contract A {\n    uint256 public immutable A_ONE; uint256 public immutable A_TWO; uint256 public immutable A_THREE;\n}'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['A_ONE', 'A_TWO', 'A_THREE'])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it.each([
    [
      'a line comment',
      'address public immutable OWNER; // the immutable owner',
    ],
    [
      'a natspec line',
      'uint256 public immutable FEE; /// @notice immutable fee',
    ],
    ['a natspec block', 'uint256 public immutable FEE; /** @dev immutable */'],
  ])('stays quiet when %s mentions the word', (_label, line) => {
    // A mention in a trailing comment is not a second declaration. Counting raw
    // occurrences turned each of these into a failing gate on correct code, and
    // the error told the author to put on one line a declaration that was
    // already on one line. Over 150 statements in `src/` carry a trailing
    // comment, so it is a shape the repo actually writes.
    const source = `contract A {\n    ${line}\n}`

    expect(parseImmutableDeclarations(source, 'src/A.sol')).toHaveLength(1)
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it('does not flag the word inside a string literal', () => {
    const source =
      'contract A {\n    string public constant NOTE = "immutable thing";\n}'

    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it('sees a declaration that an escaped quote used to swallow', () => {
    // Masking was a regex over quote pairs, which does not know about `\"`. The
    // odd quote count made the following pair span the declaration and delete
    // the keyword, so the immutable was neither parsed nor reported. It compiles
    // — solc reads the escaped quote as string content — so this was a real
    // immutable that was invisible, the one failure this module exists to stop.
    const source =
      'contract A {\n    string constant Q = "\\"";  address public immutable HIDDEN;\n}'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['HIDDEN'])
  })

  it('sees a declaration behind a leading block comment', () => {
    // A "does this line open with a comment?" test skipped the line in the
    // parser and excluded it from the reporter, so putting an inline block
    // comment in front of any declaration hid it in both directions at once.
    const source =
      'contract A {\n    /* set at construction */ address public immutable OWNER;\n}'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['OWNER'])
  })

  it('reads a declaration whose value an inline comment separates', () => {
    const source =
      'contract A {\n    address public immutable OWNER /* @dev owner */ = address(0);\n}'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['OWNER'])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it('reads a declaration sitting directly after an opening brace', () => {
    const source = 'contract A { address public immutable OWNER; }'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['OWNER'])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it('still reports a declaration wrapped across two lines', () => {
    // Masking must not buy its silence by making the genuinely unreadable shape
    // silent too.
    const source =
      'contract A {\n    address public\n        immutable WRAPPED;\n}'

    expect(parseImmutableDeclarations(source, 'src/A.sol')).toEqual([])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toHaveLength(1)
  })

  it('reports the line as written rather than as masked', () => {
    // Whoever has to fix it needs to see the shape they wrote.
    const source =
      'contract A {\n    address public /* why */ immutable\n        WRAPPED;\n}'
    const [first] = findUnreadableImmutableLines(source, 'src/A.sol')

    expect(first?.text).toBe('address public /* why */ immutable')
  })
})

describe('a modifier keyword is never captured as the name', () => {
  it.each([
    ['immutable before the visibility', 'uint256 immutable public'],
    ['immutable before private', 'uint256 immutable private'],
    ['immutable before internal', 'uint256 immutable internal'],
    [
      'an override on a public state variable',
      'uint256 public immutable override',
    ],
    ['payable with immutable first', 'address payable immutable public'],
  ])('reports, rather than inventing a declaration, for %s', (_label, head) => {
    // Each keyword order here is one solc accepts; the heads are abbreviated,
    // so a compilable form needs a base to override or a typed initialiser.
    // Accepting end-of-statement as a terminator let the pattern capture the
    // keyword as the name, which is worse than not parsing: the phantom made
    // the parsed count equal the mention count, so the reporter fell silent and
    // the real immutable on the next line was accounted for nowhere.
    const source = `contract A {\n    ${head}\n        FEE = 1;\n}`

    const parsed = parseImmutableDeclarations(source, 'src/A.sol')

    expect(parsed).toEqual([])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toHaveLength(1)
  })
})

describe('the masking pass, on the shapes that would silence a whole file', () => {
  it.each([
    ['an apostrophe in a line comment', "    // don't touch this"],
    ['an unbalanced quote in a line comment', '    // a " quote'],
    ['an apostrophe in a block comment', "    /* don't */"],
  ])('keeps reading declarations after %s', (_label, comment) => {
    // If a comment could open a string state, everything after it would be
    // masked until the next matching quote — deleting declarations silently and
    // file-wide. An apostrophe in a comment is the commonest way an unbalanced
    // quote enters real Solidity, so this is the highest-frequency route to the
    // failure the module exists to prevent.
    const source = `contract A {\n${comment}\n    address public immutable OWNER;\n}`

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['OWNER'])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it('treats /*/ as opening a comment without also closing it', () => {
    // solc reads `/*/` as an opener only; if the masker closed on the same
    // slash, the commented-out declaration would be read as live code and the
    // real one after it would be masked instead.
    const source =
      'contract A {\n    /*/ address public immutable HIDDEN = address(0); */\n    uint256 public immutable X = 1;\n}'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['X'])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it('keeps line numbers correct when a block comment spans lines', () => {
    // The masker replaces comment bodies in place and preserves newlines; if it
    // collapsed them, every reported line number after a block comment would be
    // wrong and the operator would be sent to the wrong place.
    const source =
      'contract A {\n    /* one\n       two */\n    address public\n        immutable WRAPPED;\n}'
    const [first] = findUnreadableImmutableLines(source, 'src/A.sol')

    expect(first?.line).toBe(5)
  })
})

describe('a name that merely begins with a modifier keyword is still a name', () => {
  it.each([
    'publicKey',
    'privateKeyHash',
    'internalRouter',
    'overrideAddress',
    'constantProduct',
    'immutableOwner',
    'transientStore',
    'public_KEY',
    'public0',
  ])('parses %s', (name) => {
    // The keyword exclusion must reject only the bare keyword. Without a
    // boundary on it, every one of these legal names stops parsing and the gate
    // goes red on correct code — and `immutableOwner` is the name the module's
    // own docstring uses as its example.
    const source = `contract A {\n    address public immutable ${name};\n}`

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual([name])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })

  it.each(['public$FEE', 'override$X', 'internal$R', 'immutable$I'])(
    'parses %s, where a word boundary would not have',
    (name) => {
      // `$` is legal in a Solidity identifier but is not a regex word
      // character, so a `\b` boundary reads these as the bare keyword and
      // fails the gate on code that compiles.
      const source = `contract A {\n    uint256 public immutable ${name} = 1;\n}`

      expect(
        parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
      ).toEqual([name])
      expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
    }
  )

  it.each(['public', 'private', 'internal', 'override'])(
    'still refuses the bare keyword %p as a name',
    (keyword) => {
      const source = `contract A {\n    uint256 immutable ${keyword}\n        FEE = 1;\n}`

      expect(parseImmutableDeclarations(source, 'src/A.sol')).toEqual([])
      // Refusing to parse is only half the property: a refusal nothing reports
      // is the invisible immutable the reporter exists to prevent.
      expect(findUnreadableImmutableLines(source, 'src/A.sol')).toHaveLength(1)
    }
  )

  it('parses an immutable named transient, which solc accepts', () => {
    // `transient` cannot be the modifier the exclusion guards against — solc
    // rejects it as a data location on an immutable — so excluding it would
    // only make this legal declaration unreadable and fail the gate.
    const source = 'contract A {\n    uint256 public immutable transient;\n}'

    expect(
      parseImmutableDeclarations(source, 'src/A.sol').map((d) => d.name)
    ).toEqual(['transient'])
    expect(findUnreadableImmutableLines(source, 'src/A.sol')).toEqual([])
  })
})
