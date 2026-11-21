export interface FileExcerpt {
  start: number
  end: number
  text: string
  file: string
  line: number
}

interface FileReadResult {
  path: string
  start_line: number
  end_line: number
  lines: Array<{ line: number; text: string }>
  content: string
}

export function readFileContentView(value: unknown): { result: FileReadResult; numbered: boolean } | undefined {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 5) return
  const result = value as Partial<FileReadResult>
  if (typeof result.path !== 'string' || typeof result.content !== 'string'
    || !Number.isSafeInteger(result.start_line) || !Number.isSafeInteger(result.end_line)
    || !Array.isArray(result.lines) || !result.lines.length || result.lines.some((item, index) =>
      !item || Object.keys(item).length !== 2 || item.line !== result.start_line! + index || typeof item.text !== 'string')
    || result.end_line !== result.lines.at(-1)!.line) return
  const numbered = result.content === result.lines.map(line => `${line.line}: ${line.text}`).join('\n')
  if (!numbered && result.content !== result.lines.map(line => line.text).join('\n')) return
  return { result: result as FileReadResult, numbered }
}

export const MAX_ARTIFACT_PAGE_CHARACTERS = 2_000
export const MAX_ARTIFACT_PAGE_LINES = 32
export const FILE_LINE_PAGE_RANGE_DIAGNOSTIC = 'select a smaller line range within the original read, or use offset and limit for long lines'

/** Return complete original lines from the range actually returned by the read. */
export function fileArtifactLinePage(result: FileReadResult, start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < result.start_line
    || end < start || end > result.end_line || end - start + 1 > MAX_ARTIFACT_PAGE_LINES) return
  const lines = result.lines.slice(start - result.start_line, end - result.start_line + 1)
  if (JSON.stringify(lines).length > MAX_ARTIFACT_PAGE_CHARACTERS) return
  return { file: result.path, start_line: start, end_line: end, lines }
}

export function describeFileLinePageFailure(result: FileReadResult, start: number, end: number): string {
  const containedStart = Math.max(start, result.start_line)
  const page = firstFileArtifactLinePage(result, containedStart, Math.min(end, result.end_line))
  if (page) return `${FILE_LINE_PAGE_RANGE_DIAGNOSTIC}. Valid first page for this range: start_line=${page.start_line}, end_line=${page.end_line}.`
  return `${FILE_LINE_PAGE_RANGE_DIAGNOSTIC}. Original read covers lines ${result.start_line} through ${result.end_line}.`
}

export function firstFileArtifactLinePage(result: FileReadResult, start: number, end: number) {
  if (start < result.start_line || end > result.end_line || end < start) return
  for (let pageEnd = Math.min(end, start + MAX_ARTIFACT_PAGE_LINES - 1); pageEnd >= start; pageEnd--) {
    const page = fileArtifactLinePage(result, start, pageEnd)
    if (page) return page
  }
}

/** Map the canonical file-result view to UTF-16 ranges in its immutable raw JSON. */
export function readFileExcerpts(raw: string, maxCharacters: number): FileExcerpt[] | undefined {
  let envelope: { ok?: boolean; result?: unknown }
  try {
    envelope = JSON.parse(raw)
    if (JSON.stringify(envelope) !== raw || envelope?.ok !== true || Object.keys(envelope).length !== 2) return
  } catch { return }
  const view = readFileContentView(envelope.result)
  if (!view) return
  const { result } = view
  const lines = result.lines
  const marker = '"lines":'
  const lineArrayStart = raw.indexOf(marker + JSON.stringify(lines))
  if (lineArrayStart < 0) return
  let offset = lineArrayStart + marker.length + 1
  const excerpts: FileExcerpt[] = []
  for (const line of lines) {
    const serialized = JSON.stringify(line)
    const valueStart = offset + serialized.indexOf('"text":') + '"text":'.length + 1
    offset += serialized.length + 1
    const sentences = line.text.matchAll(/[^。！？]+[。！？]*|[。！？]+/gu)
    let consumed = 0
    for (const match of sentences) {
      const text = match[0].trim()
      const untrimmed = match[0]
      const start = valueStart + JSON.stringify(line.text.slice(0, match.index)).length - 2
      const end = start + JSON.stringify(untrimmed).length - 2
      if (JSON.stringify(untrimmed).slice(1, -1) !== raw.slice(start, end) || end - start > maxCharacters) return
      consumed += untrimmed.length
      if (text) excerpts.push({ start, end, text: untrimmed, file: result.path, line: line.line })
    }
    if (line.text.length !== consumed) return
  }
  return excerpts.length ? excerpts : undefined
}
