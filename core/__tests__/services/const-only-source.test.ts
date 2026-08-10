import { describe, expect, it } from 'bun:test'
import { findMutableDeclarations } from '../../services/const-only-source'

describe('const-only source guard', () => {
  it('reports let and var declarations with source locations', () => {
    expect(findMutableDeclarations('sample.ts', 'const a = 1\nlet b = 2\nvar c = 3')).toEqual([
      { file: 'sample.ts', line: 2, column: 1, keyword: 'let' },
      { file: 'sample.ts', line: 3, column: 1, keyword: 'var' },
    ])
  })

  it('ignores words inside strings and comments', () => {
    const source = `const fixture = 'let value = 1'\n// var old = true`
    expect(findMutableDeclarations('sample.ts', source)).toEqual([])
  })

  it('finds mutable for-loop declarations', () => {
    const source = 'for (let index = 0; index < 3; index += 1) {}'
    expect(findMutableDeclarations('sample.ts', source)).toEqual([
      { file: 'sample.ts', line: 1, column: 6, keyword: 'let' },
    ])
  })
})
