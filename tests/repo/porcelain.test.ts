import { describe, expect, it } from 'vitest'

import { parsePorcelainV2 } from '../../src/repo/porcelain.js'
import { bytes } from '../../src/repo/process.js'

describe('porcelain v2 -z parser', () => {
  it('classifies tracked, untracked and rename records without splitting paths', () => {
    const rename = '2 R. N... 100644 100644 100644 abcdef abcdef R100 -new name.txt'
    const output = [
      '1 .M N... 100644 100644 100644 abcdef abcdef modified file.ts',
      '1 A. N... 100644 100644 100644 000000 abcdef added file.ts',
      '1 D. N... 100644 000000 000000 abcdef 000000 deleted file.ts',
      rename,
      'old name.txt',
      '? -untracked file.txt',
    ].join('\0') + '\0'

    const parsed = parsePorcelainV2(bytes(output))
    expect(parsed.modified.map(item => item.path)).toEqual(['modified file.ts'])
    expect(parsed.added.map(item => item.path)).toEqual(['added file.ts'])
    expect(parsed.deleted.map(item => item.path)).toEqual(['deleted file.ts'])
    expect(parsed.renamed).toEqual([{ path: '-new name.txt', oldPath: 'old name.txt', index: true, worktree: false }])
    expect(parsed.untracked).toEqual([{ path: '-untracked file.txt', index: false, worktree: true }])
    expect(parsed.staged).toEqual(['added file.ts', 'deleted file.ts', '-new name.txt'])
    expect(parsed.unstaged).toEqual(['modified file.ts'])
    expect(parsed.diagnostics).toHaveLength(0)
  })

  it('keeps going after malformed and unknown records', () => {
    const parsed = parsePorcelainV2('x unknown\0? valid.txt\0')
    expect(parsed.untracked[0]?.path).toBe('valid.txt')
    expect(parsed.diagnostics.length).toBe(1)
  })

  it('parses unmerged type-u paths at their correct field offset', () => {
    const parsed = parsePorcelainV2('u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict 文件.txt\0')
    expect(parsed.modified).toEqual([{ path: 'conflict 文件.txt', index: true, worktree: true }])
  })
})
