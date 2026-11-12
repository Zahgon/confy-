// Lint gate of the package, the JavaScript counterpart of the original `cargo clippy -- -D warnings` job.
// Every .js file under src/, test/, examples/ and scripts/ must parse as an ES module, must not declare a
// variable, function, class or import that it never uses, and must not use a name that is neither declared
// nor a global of the running Node.js. The parser is the acorn build that ships inside Node.js, so the lint
// needs no npm dependency; `npm run lint` starts it with --expose-internals to reach that build.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const acorn = require('internal/deps/acorn/acorn/dist/acorn')

const DIRS = ['src', 'test', 'examples', 'scripts']
const GLOBALS = new Set(Object.getOwnPropertyNames(globalThis))
const REPORTED_KINDS = new Set(['var', 'let', 'const', 'function', 'class', 'import'])

class Scope {
  constructor(parent, isFunction) {
    this.parent = parent
    this.isFunction = isFunction
    this.bindings = new Map()
  }

  functionScope() {
    let scope = this
    while (!scope.isFunction) scope = scope.parent
    return scope
  }

  lookup(name) {
    for (let scope = this; scope; scope = scope.parent) {
      const binding = scope.bindings.get(name)
      if (binding) return binding
    }
    return null
  }
}

function analyse(program) {
  const scopes = []
  const references = []

  const newScope = (parent, isFunction) => {
    const scope = new Scope(parent, isFunction)
    scopes.push(scope)
    return scope
  }
  const declare = (scope, id, kind, used = false) => {
    if (!scope.bindings.has(id.name)) scope.bindings.set(id.name, { id, kind, used })
  }
  const markUsed = (scope, id) => references.push({ scope, id })

  function declarePattern(pattern, scope, kind, outer) {
    switch (pattern.type) {
      case 'Identifier':
        declare(scope, pattern, kind)
        break
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') declarePattern(prop.argument, scope, kind, outer)
          else {
            if (prop.computed) visit(prop.key, outer)
            declarePattern(prop.value, scope, kind, outer)
          }
        }
        break
      case 'ArrayPattern':
        for (const element of pattern.elements) if (element) declarePattern(element, scope, kind, outer)
        break
      case 'RestElement':
        declarePattern(pattern.argument, scope, kind, outer)
        break
      case 'AssignmentPattern':
        declarePattern(pattern.left, scope, kind, outer)
        visit(pattern.right, outer)
        break
      default:
        visit(pattern, outer)
    }
  }

  // Assignment targets: identifiers and member expressions inside a pattern are uses, not declarations.
  function visitTarget(pattern, scope) {
    switch (pattern.type) {
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') visitTarget(prop.argument, scope)
          else {
            if (prop.computed) visit(prop.key, scope)
            visitTarget(prop.value, scope)
          }
        }
        break
      case 'ArrayPattern':
        for (const element of pattern.elements) if (element) visitTarget(element, scope)
        break
      case 'RestElement':
        visitTarget(pattern.argument, scope)
        break
      case 'AssignmentPattern':
        visitTarget(pattern.left, scope)
        visit(pattern.right, scope)
        break
      default:
        visit(pattern, scope)
    }
  }

  function visitFunction(node, scope) {
    const inner = newScope(scope, true)
    if (node.type === 'FunctionExpression' && node.id) declare(inner, node.id, 'self', true)
    if (node.type !== 'ArrowFunctionExpression') {
      inner.bindings.set('arguments', { id: null, kind: 'arguments', used: true })
    }
    for (const param of node.params) declarePattern(param, inner, 'param', inner)
    if (node.body.type === 'BlockStatement') visitStatements(node.body.body, inner)
    else visit(node.body, inner)
  }

  function visitClass(node, scope) {
    if (node.superClass) visit(node.superClass, scope)
    const inner = newScope(scope, false)
    if (node.type === 'ClassExpression' && node.id) declare(inner, node.id, 'self', true)
    for (const member of node.body.body) {
      if (member.type === 'StaticBlock') {
        visitStatements(member.body, newScope(inner, true))
        continue
      }
      if (member.computed) visit(member.key, inner)
      if (member.value) visit(member.value, newScope(inner, true))
    }
  }

  function visitStatements(statements, scope) {
    for (const statement of statements) visit(statement, scope)
  }

  function exportedNames(declaration) {
    if (declaration.type === 'VariableDeclaration') {
      const names = []
      const collect = (p) => {
        if (p.type === 'Identifier') names.push(p)
        else if (p.type === 'ObjectPattern') p.properties.forEach((q) => collect(q.type === 'RestElement' ? q.argument : q.value))
        else if (p.type === 'ArrayPattern') p.elements.forEach((q) => q && collect(q))
        else if (p.type === 'RestElement') collect(p.argument)
        else if (p.type === 'AssignmentPattern') collect(p.left)
      }
      declaration.declarations.forEach((d) => collect(d.id))
      return names
    }
    return declaration.id ? [declaration.id] : []
  }

  function visit(node, scope) {
    if (!node) return
    switch (node.type) {
      case 'Identifier':
        markUsed(scope, node)
        return
      case 'ImportDeclaration':
        for (const spec of node.specifiers) declare(scope, spec.local, 'import')
        return
      case 'ExportNamedDeclaration':
        if (node.declaration) {
          visit(node.declaration, scope)
          for (const id of exportedNames(node.declaration)) markUsed(scope, id)
        } else if (!node.source) {
          for (const spec of node.specifiers) markUsed(scope, spec.local)
        }
        return
      case 'ExportDefaultDeclaration': {
        const d = node.declaration
        visit(d, scope)
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) markUsed(scope, d.id)
        return
      }
      case 'ExportAllDeclaration':
        return
      case 'VariableDeclaration': {
        const target = node.kind === 'var' ? scope.functionScope() : scope
        for (const d of node.declarations) {
          declarePattern(d.id, target, node.kind, scope)
          visit(d.init, scope)
        }
        return
      }
      case 'FunctionDeclaration':
        if (node.id) declare(scope, node.id, 'function')
        visitFunction(node, scope)
        return
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node, scope)
        return
      case 'ClassDeclaration':
        if (node.id) declare(scope, node.id, 'class')
        visitClass(node, scope)
        return
      case 'ClassExpression':
        visitClass(node, scope)
        return
      case 'BlockStatement':
        visitStatements(node.body, newScope(scope, false))
        return
      case 'StaticBlock':
        visitStatements(node.body, newScope(scope, true))
        return
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const inner = newScope(scope, false)
        for (const key of ['init', 'left', 'right', 'test', 'update']) {
          const child = node[key]
          if (!child) continue
          if (key === 'left' && child.type !== 'VariableDeclaration') visitTarget(child, inner)
          else visit(child, inner)
        }
        visit(node.body, inner)
        return
      }
      case 'CatchClause': {
        const inner = newScope(scope, false)
        if (node.param) declarePattern(node.param, inner, 'param', inner)
        visitStatements(node.body.body, inner)
        return
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope)
        const inner = newScope(scope, false)
        for (const c of node.cases) {
          visit(c.test, inner)
          visitStatements(c.consequent, inner)
        }
        return
      }
      case 'AssignmentExpression':
        visitTarget(node.left, scope)
        visit(node.right, scope)
        return
      case 'MemberExpression':
        visit(node.object, scope)
        if (node.computed) visit(node.property, scope)
        return
      case 'Property':
        if (node.computed) visit(node.key, scope)
        visit(node.value, scope)
        return
      case 'LabeledStatement':
        visit(node.body, scope)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
      case 'Literal':
      case 'TemplateElement':
      case 'ThisExpression':
      case 'Super':
      case 'EmptyStatement':
      case 'DebuggerStatement':
      case 'PrivateIdentifier':
        return
      default:
        for (const [key, child] of Object.entries(node)) {
          if (key === 'type' || key === 'loc') continue
          if (Array.isArray(child)) for (const item of child) visitChild(item, scope)
          else visitChild(child, scope)
        }
    }
  }

  function visitChild(child, scope) {
    if (child && typeof child === 'object' && typeof child.type === 'string') visit(child, scope)
  }

  const root = newScope(null, true)
  visitStatements(program.body, root)

  const problems = []
  for (const { scope, id } of references) {
    const binding = scope.lookup(id.name)
    if (binding) binding.used = true
    else if (!GLOBALS.has(id.name)) problems.push([id.loc.start, `'${id.name}' is not defined`])
  }
  for (const scope of scopes) {
    for (const [name, binding] of scope.bindings) {
      if (!binding.used && REPORTED_KINDS.has(binding.kind) && !name.startsWith('_')) {
        problems.push([binding.id.loc.start, `'${name}' is declared but never used`])
      }
    }
  }
  return problems.sort((a, b) => a[0].line - b[0].line || a[0].column - b[0].column)
}

function lintFile(file) {
  let program
  try {
    program = acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    const loc = e.loc ?? { line: 0, column: 0 }
    return [`${file}:${loc.line}:${loc.column + 1}: ${e.message.replace(/ \(\d+:\d+\)$/, '')}`]
  }
  return analyse(program).map(([loc, message]) => `${file}:${loc.line}:${loc.column + 1}: ${message}`)
}

const files = []
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    if (entry.endsWith('.js')) files.push(path.join(dir, entry))
  }
}
files.sort()
const problems = files.flatMap(lintFile)
for (const line of problems) console.error(line)
if (problems.length) {
  console.error(`lint: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log(`lint: ${files.length} files ok`)
}
