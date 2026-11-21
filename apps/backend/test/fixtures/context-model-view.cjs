const assert = require('node:assert/strict')

function readContextTree(markdown) {
  const tree = JSON.parse(markdown.match(/<!-- capybara:tree data=(\{[^\n]+?\}) -->/)[1])
  if (tree.version === 1) return tree
  assert.equal(tree.version, 2)
  assert.deepEqual(tree.columns, ['id', 'kind', 'hash', 'parent', 'title', 'children', 'totalChildren'])
  const idAt = number => {
    assert.ok(Number.isInteger(number) && number > 0 && number <= tree.nodes.length)
    return tree.nodes[number - 1][0]
  }
  return { ...tree, nodes: tree.nodes.map(([id, kind, hash, parent, title, children, totalChildren]) => ({
    id, kind, hash, ...(parent != null ? { parentId: idAt(parent) } : {}), ...(title != null ? { title } : {}),
    ...(children != null ? { childIds: children.map(idAt), totalChildren } : {}),
  })) }
}

function readContextEntries(markdown) {
  const { fileSources } = readContextTree(markdown)
  return [...markdown.matchAll(/<!-- capybara:entry-ref data=(\{[^\n]+?\}) -->/g)].map(match => {
    const entry = JSON.parse(match[1])
    return { ...entry, evidence: entry.evidence.map(({ source, ...evidence }) => {
      if (source === undefined) return evidence
      assert.ok(Number.isInteger(source) && source > 0 && fileSources?.[source - 1])
      return { ...fileSources[source - 1], ...evidence }
    }) }
  })
}

module.exports = { readContextTree, readContextEntries }
