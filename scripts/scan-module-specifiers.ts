type StringLiteral = {
  readonly end: number
  readonly value: string
}

type Word = {
  readonly end: number
  readonly word: string
}

const isIdentifierStart = (character: string | undefined): boolean =>
  character !== undefined && /[A-Za-z_$]/u.test(character)

const isIdentifierPart = (character: string | undefined): boolean =>
  character !== undefined && /[A-Za-z0-9_$]/u.test(character)

const skipWhitespace = (source: string, start: number): number => {
  let index = start
  while (/\s/u.test(source[index] ?? '')) index += 1
  return index
}

const readStringLiteral = (source: string, start: number): StringLiteral | undefined => {
  const quote = source[start]
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined

  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      const escaped = source[index + 1]
      if (escaped !== undefined) value += escaped
      index += 1
      continue
    }
    if (character === quote) return { end: index + 1, value }
    value += character
  }

  return undefined
}

const skipCommentOrString = (source: string, start: number): number | undefined => {
  if (source.startsWith('//', start)) {
    const newline = source.indexOf('\n', start + 2)
    return newline === -1 ? source.length : newline + 1
  }
  if (source.startsWith('/*', start)) {
    const end = source.indexOf('*/', start + 2)
    return end === -1 ? source.length : end + 2
  }
  const literal = readStringLiteral(source, start)
  return literal?.end
}

const readWord = (source: string, start: number): Word => {
  let end = start + 1
  while (isIdentifierPart(source[end])) end += 1
  return { end, word: source.slice(start, end) }
}

const addLiteral = (
  specifiers: Set<string>,
  literal: StringLiteral | undefined,
  path: string
): void => {
  if (literal === undefined) return
  if (literal.value.includes('${')) {
    throw new Error(`Unverifiable dynamic module specifier in ${path}`)
  }
  specifiers.add(literal.value)
}

const readCallSpecifier = (
  source: string,
  start: number,
  specifiers: Set<string>,
  path: string,
  kind: string
): number => {
  const open = skipWhitespace(source, start)
  if (source[open] !== '(') return start
  const literal = readStringLiteral(source, skipWhitespace(source, open + 1))
  if (literal === undefined) throw new Error(`Unverifiable ${kind} in ${path}`)
  addLiteral(specifiers, literal, path)
  return open + 1
}

const readDeclarationSpecifier = (
  source: string,
  start: number,
  specifiers: Set<string>,
  path: string
): number => {
  let index = skipWhitespace(source, start)
  if (source[index] === '"' || source[index] === "'" || source[index] === '`') {
    const literal = readStringLiteral(source, index)
    addLiteral(specifiers, literal, path)
    return literal?.end ?? index + 1
  }

  while (index < source.length) {
    const skipped = skipCommentOrString(source, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }
    if (isIdentifierStart(source[index])) {
      const token = readWord(source, index)
      if (token.word === 'from') {
        const literal = readStringLiteral(source, skipWhitespace(source, token.end))
        addLiteral(specifiers, literal, path)
        return literal?.end ?? token.end
      }
      index = token.end
      continue
    }
    index += 1
  }

  return index
}

export const scanModuleSpecifiers = (source: string, path = '<source>'): string[] => {
  const specifiers = new Set<string>()
  let index = 0

  while (index < source.length) {
    const skipped = skipCommentOrString(source, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }
    if (!isIdentifierStart(source[index])) {
      index += 1
      continue
    }

    const token = readWord(source, index)
    if (token.word === 'import') {
      const afterImport = skipWhitespace(source, token.end)
      if (source[afterImport] === '(') {
        readCallSpecifier(source, afterImport, specifiers, path, 'dynamic import')
      } else if (source.slice(afterImport, afterImport + 4) === 'type') {
        const afterType = skipWhitespace(source, afterImport + 4)
        if (source[afterType] === '(')
          readCallSpecifier(source, afterType, specifiers, path, 'dynamic import')
        else readDeclarationSpecifier(source, afterType, specifiers, path)
      } else {
        readDeclarationSpecifier(source, afterImport, specifiers, path)
      }
    } else if (token.word === 'export') {
      readDeclarationSpecifier(source, token.end, specifiers, path)
    } else if (
      (token.word === 'require' || token.word === '__require') &&
      source[index - 1] !== '.'
    ) {
      readCallSpecifier(
        source,
        token.end,
        specifiers,
        path,
        token.word === '__require' ? 'emitted helper require' : 'static require'
      )
    }
    index = token.end
  }

  return [...specifiers]
}
