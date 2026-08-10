import path from 'node:path'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])

export interface MutableDeclaration {
  file: string
  line: number
  column: number
  keyword: 'let' | 'var'
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

export function isJavaScriptOrTypeScript(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath))
}

export function findMutableDeclarations(filePath: string, source: string): MutableDeclaration[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath)
  )
  const declarations: MutableDeclaration[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node)) {
      const keyword =
        node.flags & ts.NodeFlags.Let ? 'let' : node.flags & ts.NodeFlags.Const ? null : 'var'
      if (keyword) {
        const start = node.getStart(sourceFile)
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
        declarations.push({
          file: filePath,
          line: line + 1,
          column: character + 1,
          keyword,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return declarations
}
