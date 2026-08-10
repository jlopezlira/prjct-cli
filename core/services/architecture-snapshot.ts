/**
 * Structural architecture overview — one-shot for agents (CBM get_architecture-inspired).
 * Pure reads over symbol graph + import graph + file inventory. No LLM.
 */

import { loadGraph } from '../domain/import-graph'
import {
  fileFanInByFile,
  hasSymbolIndex,
  listAllSymbols,
  loadMeta,
  searchSymbols,
} from '../domain/symbol-graph'

export interface ArchitectureSnapshot {
  ready: boolean
  builtAt: string | null
  symbols: number
  edges: number
  files: number
  languages: Array<{ ext: string; count: number }>
  kinds: Array<{ kind: string; count: number }>
  routes: Array<{ name: string; file: string; line: number }>
  hotspots: Array<{ file: string; fanIn: number; symbolCount: number }>
  entryCandidates: Array<{ name: string; file: string; kind: string }>
  packages: string[]
  note: string
}

const ENTRY_NAME = /^(main|index|app|server|cli|handler|router|bootstrap|init|start|run|default)$/i

export function buildArchitectureSnapshot(projectId: string): ArchitectureSnapshot {
  const meta = loadMeta(projectId)
  const ready = hasSymbolIndex(projectId)
  if (!ready) {
    return {
      ready: false,
      builtAt: meta?.builtAt ?? null,
      symbols: 0,
      edges: 0,
      files: 0,
      languages: [],
      kinds: [],
      routes: [],
      hotspots: [],
      entryCandidates: [],
      packages: [],
      note: 'No symbol index. Run `prjct sync` or `prjct code reindex`.',
    }
  }

  const symbols = listAllSymbols(projectId)
  const kindMap = new Map<string, number>()
  const fileMap = new Map<string, number>()
  const langMap = new Map<string, number>()
  const routes: ArchitectureSnapshot['routes'] = []
  const entryCandidates: ArchitectureSnapshot['entryCandidates'] = []

  for (const s of symbols) {
    kindMap.set(s.kind, (kindMap.get(s.kind) ?? 0) + 1)
    fileMap.set(s.file, (fileMap.get(s.file) ?? 0) + 1)
    const ext = s.file.includes('.') ? s.file.slice(s.file.lastIndexOf('.')) : '(none)'
    langMap.set(ext, (langMap.get(ext) ?? 0) + 1)
    if (s.kind === 'route') {
      routes.push({
        name: s.name,
        file: s.file,
        line: s.startLine,
      })
    }
    if (
      s.exported &&
      ENTRY_NAME.test(s.name) &&
      (s.kind === 'function' || s.kind === 'class') &&
      !/__tests__|\.test\.|\.spec\.|fixtures?\//i.test(s.file)
    ) {
      entryCandidates.push({
        name: s.name,
        file: s.file,
        kind: s.kind,
      })
    }
  }

  // Hotspots: top files by call fan-in (cap work)
  const files = [...fileMap.keys()]
  const hotspotScores: ArchitectureSnapshot['hotspots'] = []
  const fanInByFile = fileFanInByFile(projectId)
  // Sample up to 400 files for fan-in cost
  const sample = files.length > 400 ? files.slice(0, 400) : files
  for (const f of sample) {
    const fanIn = fanInByFile.get(f) ?? 0
    if (fanIn > 0) {
      hotspotScores.push({
        file: f,
        fanIn,
        symbolCount: fileMap.get(f) ?? 0,
      })
    }
  }
  hotspotScores.sort((a, b) => b.fanIn - a.fanIn)

  // Package roots from import graph + symbol files. The graph also preserves
  // top-level directories whose files contain imports but no indexed symbol.
  const packages = new Set<string>()
  const graph = loadGraph(projectId)
  if (graph) {
    for (const f2 of Object.keys(graph.forward).slice(0, 2000)) {
      const top = f2.includes('/') ? f2.slice(0, f2.indexOf('/')) : f2
      if (top && !top.startsWith('.')) packages.add(top)
    }
  }
  for (const f3 of files.slice(0, 2000)) {
    const top = f3.includes('/') ? f3.slice(0, f3.indexOf('/')) : '.'
    if (top && top !== '.') packages.add(top)
  }

  // Also surface high-export classes as entry-ish
  if (entryCandidates.length < 8) {
    for (const s2 of symbols) {
      if (entryCandidates.length >= 12) break
      if (s2.exported && s2.kind === 'class' && !entryCandidates.some((e) => e.file === s2.file)) {
        entryCandidates.push({
          name: s2.name,
          file: s2.file,
          kind: s2.kind,
        })
      }
    }
  }

  void searchSymbols // keep import stable for future filters

  return {
    ready: true,
    builtAt: meta?.builtAt ?? null,
    symbols: meta?.symbolCount ?? symbols.length,
    edges: meta?.edgeCount ?? 0,
    files: meta?.fileCount ?? fileMap.size,
    languages: [...langMap.entries()]
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    kinds: [...kindMap.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    routes: routes.slice(0, 30),
    hotspots: hotspotScores.slice(0, 15),
    entryCandidates: entryCandidates.slice(0, 15),
    packages: [...packages].sort().slice(0, 40),
    note: 'Structural only (symbol + import graphs). Narrative architecture lives in prjct analysis / memory decisions.',
  }
}

export function formatArchitectureMd(snap: ArchitectureSnapshot): string {
  if (!snap.ready) {
    return `## Architecture\n\n> ${snap.note}\n`
  }
  const lines = [
    '## Architecture (structural)',
    '',
    `- **Symbols**: ${snap.symbols} · **Edges**: ${snap.edges} · **Files**: ${snap.files}`,
    snap.builtAt ? `- **Index built**: ${snap.builtAt}` : '',
    '',
    '### Languages (by symbol files)',
    ...snap.languages.map((l) => `- \`${l.ext}\`: ${l.count}`),
    '',
    '### Symbol kinds',
    ...snap.kinds.map((k) => `- **${k.kind}**: ${k.count}`),
    '',
    '### Top-level packages / dirs',
    snap.packages.length ? snap.packages.map((p) => `\`${p}\``).join(', ') : '_none detected_',
    '',
    '### Hotspots (call fan-in)',
    ...(snap.hotspots.length
      ? snap.hotspots.map(
          (h) => `- \`${h.file}\` — fan-in **${h.fanIn}** · ${h.symbolCount} symbol(s)`
        )
      : ['_no call edges yet_']),
    '',
    '### Entry candidates',
    ...(snap.entryCandidates.length
      ? snap.entryCandidates.map((e) => `- **${e.name}** (${e.kind}) — \`${e.file}\``)
      : ['_none_']),
    '',
    '### Routes',
    ...(snap.routes.length
      ? snap.routes.map((r) => `- \`${r.name}\` — \`${r.file}:${r.line}\``)
      : ['_no HTTP route nodes detected_']),
    '',
    `_${snap.note}_`,
  ]
  return lines.filter((l) => l !== '').join('\n')
}

export function formatArchitectureText(snap: ArchitectureSnapshot): string {
  if (!snap.ready) return `architecture: ${snap.note}`
  return [
    `Architecture: ${snap.symbols} symbols · ${snap.edges} edges · ${snap.files} files`,
    `Kinds: ${snap.kinds.map((k) => `${k.kind}=${k.count}`).join(' ')}`,
    `Hotspots: ${
      snap.hotspots
        .slice(0, 5)
        .map((h) => `${h.file}(${h.fanIn})`)
        .join(', ') || '—'
    }`,
    `Packages: ${snap.packages.slice(0, 12).join(', ')}`,
    'Detail: prjct code architecture --md',
  ].join('\n')
}
