type Hunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/

function splitText(value: string): string[] {
  if (!value) return []
  const normalized = value.replaceAll('\r\n', '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
}

function parseHunks(diff: string): Hunk[] {
  const lines = diff.replaceAll('\r\n', '\n').split('\n')
  if (!lines.some((line) => line.startsWith('--- a/')) || !lines.some((line) => line.startsWith('+++ b/'))) {
    throw new Error('variable patch must contain Git unified diff file headers')
  }
  const hunks: Hunk[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = HUNK_HEADER.exec(lines[index] ?? '')
    if (!match) continue
    const hunk: Hunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
      lines: [],
    }
    index += 1
    while (index < lines.length && !lines[index]?.startsWith('@@ ')) {
      const line = lines[index] ?? ''
      if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) break
      if (line === '\\ No newline at end of file') {
        index += 1
        continue
      }
      if (line && ![' ', '+', '-'].includes(line[0] ?? '')) throw new Error(`invalid unified diff line: ${line}`)
      if (line) hunk.lines.push(line)
      index += 1
    }
    index -= 1
    const oldLines = hunk.lines.filter((line) => line[0] !== '+').length
    const newLines = hunk.lines.filter((line) => line[0] !== '-').length
    if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) {
      throw new Error('unified diff hunk line counts do not match its header')
    }
    hunks.push(hunk)
  }
  if (hunks.length === 0) throw new Error('variable patch must contain at least one unified diff hunk')
  return hunks
}

export function applyUnifiedDiff(before: string, diff: string): string {
  const source = splitText(before)
  const output: string[] = []
  let sourceIndex = 0
  for (const hunk of parseHunks(diff)) {
    const targetIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    if (targetIndex < sourceIndex || targetIndex > source.length) throw new Error('unified diff hunk is out of order')
    output.push(...source.slice(sourceIndex, targetIndex))
    sourceIndex = targetIndex
    for (const line of hunk.lines) {
      const marker = line[0]
      const content = line.slice(1)
      if (marker === '+') {
        output.push(content)
        continue
      }
      if (source[sourceIndex] !== content) {
        throw new Error(`unified diff context mismatch at source line ${sourceIndex + 1}`)
      }
      if (marker === ' ') output.push(content)
      sourceIndex += 1
    }
  }
  output.push(...source.slice(sourceIndex))
  return output.join('\n')
}
