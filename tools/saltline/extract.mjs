#!/usr/bin/env node
// Saltline bundle extractor.
//
// Saltline (the user's other AI-built game, see docs/saltline-reuse.md) only
// survives as one minified esbuild IIFE. This tool parses that bundle, runs a
// small lexical-scope analysis over every top-level statement, and pulls out a
// requested symbol together with the transitive closure of top-level
// declarations it depends on. three.js aliases (the bundle's `lt` namespace)
// are rewritten to `THREE.<Name>`, and the result is pretty-printed with
// esbuild so it can be read, renamed and ported by hand.
//
// Usage:
//   node tools/saltline/extract.mjs --modules                 list esbuild module namespaces
//   node tools/saltline/extract.mjs --find <text>             top-level statements containing text
//   node tools/saltline/extract.mjs <name...> [--out file]    extract symbols + dependencies
//        [--stop name,name]   treat these names as external (do not pull them in)
//        [--deps]             print the dependency list only
//
// The bundle path defaults to the local Saltline checkout; override with
// SALTLINE_BUNDLE=/path/to/saltline.js.

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { transformSync } from 'esbuild';

const BUNDLE = process.env.SALTLINE_BUNDLE || 'D:/Eray0/下载/Saltline/public/engine/saltline.js';

// three.js addons that the bundle inlined after the core; they are not in the
// `lt` namespace, so map them to our vendored addon modules by hand.
const ADDON_ALIASES = {};

function parseArgs(argv) {
  const out = { names: [], stop: new Set(), outFile: null, deps: false, modules: false, find: null, rename: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outFile = argv[++i];
    else if (a === '--stop') argv[++i].split(',').filter(Boolean).forEach((n) => out.stop.add(n));
    else if (a === '--deps') out.deps = true;
    else if (a === '--rename') {
      const spec = argv[++i];
      const pairs = fs.existsSync(spec) ? Object.entries(JSON.parse(fs.readFileSync(spec, 'utf8'))) : spec.split(',').map((p) => p.split('='));
      out.rename = new Map(pairs.filter(([k, v]) => k && v));
    }
    else if (a === '--modules') out.modules = true;
    else if (a === '--find') out.find = argv[++i];
    else out.names.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- scope analysis

function boundNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern': for (const q of p.properties) boundNames(q.type === 'RestElement' ? q.argument : q.value, out); break;
    case 'ArrayPattern': for (const q of p.elements) boundNames(q, out); break;
    case 'RestElement': boundNames(p.argument, out); break;
    case 'AssignmentPattern': boundNames(p.left, out); break;
    default: break;
  }
  return out;
}

// var-scoped names of a function body (does not cross function boundaries).
function collectVarNames(node, out) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'FunctionDeclaration': if (node.id) out.add(node.id.name); return;
    case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassDeclaration': case 'ClassExpression': return;
    case 'VariableDeclaration':
      if (node.kind === 'var') for (const d of node.declarations) boundNames(d.id).forEach((n) => out.add(n));
      for (const d of node.declarations) if (d.init) collectVarNames(d.init, out);
      return;
    default: break;
  }
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && collectVarNames(c, out));
    else if (v && typeof v.type === 'string') collectVarNames(v, out);
  }
}

function lexicalNames(statements, out) {
  for (const s of statements) {
    if (!s) continue;
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations) boundNames(d.id).forEach((n) => out.add(n));
    else if (s.type === 'ClassDeclaration' && s.id) out.add(s.id.name);
    else if (s.type === 'FunctionDeclaration' && s.id) out.add(s.id.name);
  }
  return out;
}

class Analyzer {
  constructor() { this.free = new Map(); /* name -> [{node, shorthand}] */ }
  ref(name, scopes, node, shorthand = false) {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return;
    if (!this.free.has(name)) this.free.set(name, []);
    this.free.get(name).push({ node, shorthand });
  }
  children(node, scopes) {
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') this.visit(c, scopes); }
      else if (v && typeof v.type === 'string') this.visit(v, scopes);
    }
  }
  pattern(p, scopes) { // binding pattern: only default values / computed keys are references
    if (!p) return;
    switch (p.type) {
      case 'Identifier': return;
      case 'ObjectPattern':
        for (const q of p.properties) {
          if (q.type === 'RestElement') this.pattern(q.argument, scopes);
          else { if (q.computed) this.visit(q.key, scopes); this.pattern(q.value, scopes); }
        }
        return;
      case 'ArrayPattern': for (const q of p.elements) this.pattern(q, scopes); return;
      case 'RestElement': this.pattern(p.argument, scopes); return;
      case 'AssignmentPattern': this.pattern(p.left, scopes); this.visit(p.right, scopes); return;
      default: this.visit(p, scopes); // MemberExpression in for-in heads etc.
    }
  }
  assignTarget(p, scopes) { // assignment pattern: identifiers are references
    if (!p) return;
    switch (p.type) {
      case 'Identifier': this.ref(p.name, scopes, p); return;
      case 'ObjectPattern':
        for (const q of p.properties) {
          if (q.type === 'RestElement') this.assignTarget(q.argument, scopes);
          else { if (q.computed) this.visit(q.key, scopes); this.assignTarget(q.value, scopes); }
        }
        return;
      case 'ArrayPattern': for (const q of p.elements) this.assignTarget(q, scopes); return;
      case 'RestElement': this.assignTarget(p.argument, scopes); return;
      case 'AssignmentPattern': this.assignTarget(p.left, scopes); this.visit(p.right, scopes); return;
      default: this.visit(p, scopes);
    }
  }
  fn(node, scopes) {
    const s = new Set();
    if (node.type === 'FunctionExpression' && node.id) s.add(node.id.name);
    if (node.type !== 'ArrowFunctionExpression') s.add('arguments');
    for (const p of node.params) boundNames(p).forEach((n) => s.add(n));
    if (node.body.type === 'BlockStatement') { collectVarNames(node.body, s); lexicalNames(node.body.body, s); }
    const inner = [...scopes, s];
    for (const p of node.params) this.pattern(p, inner);
    if (node.body.type === 'BlockStatement') for (const st of node.body.body) this.visit(st, inner);
    else this.visit(node.body, inner);
  }
  visit(node, scopes) {
    switch (node.type) {
      case 'Identifier': this.ref(node.name, scopes, node); return;
      case 'MemberExpression':
        this.visit(node.object, scopes);
        if (node.computed) this.visit(node.property, scopes);
        return;
      case 'Property':
        if (node.shorthand && node.value.type === 'Identifier') { this.ref(node.value.name, scopes, node.value, true); return; }
        if (node.computed) this.visit(node.key, scopes);
        this.visit(node.value, scopes);
        return;
      case 'MethodDefinition': case 'PropertyDefinition':
        if (node.computed) this.visit(node.key, scopes);
        if (node.value) this.visit(node.value, scopes);
        return;
      case 'StaticBlock': {
        const s = lexicalNames(node.body, new Set()); collectVarNames(node, s);
        for (const st of node.body) this.visit(st, [...scopes, s]);
        return;
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        this.fn(node, scopes); return;
      case 'ClassDeclaration': case 'ClassExpression': {
        const s = new Set(); if (node.id && node.type === 'ClassExpression') s.add(node.id.name);
        const inner = [...scopes, s];
        if (node.superClass) this.visit(node.superClass, inner);
        this.visit(node.body, inner);
        return;
      }
      case 'BlockStatement': case 'Program': {
        const s = lexicalNames(node.body, new Set());
        for (const st of node.body) this.visit(st, [...scopes, s]);
        return;
      }
      case 'SwitchStatement': {
        this.visit(node.discriminant, scopes);
        const all = node.cases.flatMap((c) => c.consequent);
        const inner = [...scopes, lexicalNames(all, new Set())];
        for (const c of node.cases) { if (c.test) this.visit(c.test, inner); for (const st of c.consequent) this.visit(st, inner); }
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const s = new Set();
        const head = node.type === 'ForStatement' ? node.init : node.left;
        if (head && head.type === 'VariableDeclaration' && head.kind !== 'var') head.declarations.forEach((d) => boundNames(d.id).forEach((n) => s.add(n)));
        const inner = [...scopes, s];
        if (node.type === 'ForStatement') {
          if (node.init) this.visit(node.init, inner);
          if (node.test) this.visit(node.test, inner);
          if (node.update) this.visit(node.update, inner);
        } else {
          if (node.left.type === 'VariableDeclaration') this.visit(node.left, inner);
          else this.assignTarget(node.left, inner);
          this.visit(node.right, inner);
        }
        this.visit(node.body, inner);
        return;
      }
      case 'VariableDeclaration':
        for (const d of node.declarations) { this.pattern(d.id, scopes); if (d.init) this.visit(d.init, scopes); }
        return;
      case 'CatchClause': {
        const s = new Set(boundNames(node.param));
        const inner = [...scopes, s];
        if (node.param) this.pattern(node.param, inner);
        this.visit(node.body, inner);
        return;
      }
      case 'AssignmentExpression': this.assignTarget(node.left, scopes); this.visit(node.right, scopes); return;
      case 'LabeledStatement': this.visit(node.body, scopes); return;
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return;
      default: this.children(node, scopes);
    }
  }
}

// ---------------------------------------------------------------- bundle model

function loadBundle() {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const call = ast.body.find((s) => s.type === 'ExpressionStatement')?.expression;
  const fnNode = call?.callee;
  if (!fnNode || !fnNode.body || fnNode.body.type !== 'BlockStatement') throw new Error('bundle is not a single IIFE');
  const stmts = fnNode.body.body;

  // `br(ns,{Name:()=>alias,...})` namespaces (esbuild __export calls).
  const namespaces = new Map(); // ns -> [{exportName, alias}]
  const scanNs = (expr) => {
    if (expr?.type === 'CallExpression' && expr.callee.type === 'Identifier' && expr.arguments.length === 2
      && expr.arguments[0].type === 'Identifier' && expr.arguments[1].type === 'ObjectExpression') {
      const list = [];
      for (const p of expr.arguments[1].properties) {
        if (p.type !== 'Property' || p.value.type !== 'ArrowFunctionExpression' || p.value.body.type !== 'Identifier') return;
        list.push({ exportName: p.key.name ?? p.key.value, alias: p.value.body.name });
      }
      namespaces.set(expr.arguments[0].name, list);
    }
  };
  for (const s of stmts) {
    if (s.type === 'ExpressionStatement') {
      if (s.expression.type === 'SequenceExpression') s.expression.expressions.forEach(scanNs); else scanNs(s.expression);
    } else if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations) if (d.init) scanNs(d.init);
    }
  }

  const threeNs = namespaces.get('lt');
  const threeAlias = new Map((threeNs || []).map((e) => [e.alias, e.exportName]));

  const declIndex = new Map(); // name -> stmt index
  stmts.forEach((s, i) => {
    let names = [];
    if (s.type === 'VariableDeclaration') names = s.declarations.flatMap((d) => boundNames(d.id));
    else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) names = [s.id.name];
    for (const n of names) declIndex.set(n, i);
  });
  let threeEnd = -1;
  for (const a of threeAlias.keys()) if (declIndex.has(a)) threeEnd = Math.max(threeEnd, declIndex.get(a));

  const cache = new Map();
  const freeOf = (i) => {
    if (!cache.has(i)) {
      const an = new Analyzer();
      const s = stmts[i];
      // References to the statement's own top-level names stay free so they
      // are renamed/rewritten together with every other top-level reference.
      an.visit(s, []);
      cache.set(i, an.free);
    }
    return cache.get(i);
  };
  return { src, stmts, namespaces, threeAlias, declIndex, threeEnd, freeOf };
}

function closure(b, roots, stop) {
  const want = new Set();
  const external = new Map(); // three alias -> name
  const unresolvedThree = new Set();
  const globals = new Set();
  const queue = [];
  for (const r of roots) {
    if (!b.declIndex.has(r)) throw new Error(`no top-level declaration named "${r}"`);
    queue.push(b.declIndex.get(r));
  }
  while (queue.length) {
    const i = queue.pop();
    if (want.has(i)) continue;
    want.add(i);
    for (const name of b.freeOf(i).keys()) {
      if (stop.has(name)) continue;
      if (b.threeAlias.has(name)) { external.set(name, b.threeAlias.get(name)); continue; }
      if (ADDON_ALIASES[name]) { external.set(name, ADDON_ALIASES[name]); continue; }
      const j = b.declIndex.get(name);
      if (j === undefined) { globals.add(name); continue; }
      if (j <= b.threeEnd) { unresolvedThree.add(name); continue; }
      queue.push(j);
    }
  }
  return { want: [...want].sort((a, c) => a - c), external, unresolvedThree, globals };
}

function declIdentifiers(s) {
  const ids = [];
  const walk = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') ids.push(p);
    else if (p.type === 'ObjectPattern') p.properties.forEach((q) => walk(q.type === 'RestElement' ? q.argument : q.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(walk);
    else if (p.type === 'RestElement') walk(p.argument);
    else if (p.type === 'AssignmentPattern') walk(p.left);
  };
  if (s.type === 'VariableDeclaration') s.declarations.forEach((d) => walk(d.id));
  else if (s.id) ids.push(s.id);
  return ids;
}

function emit(b, idxs, external, stop, rename = new Map()) {
  let out = '';
  for (const i of idxs) {
    const s = b.stmts[i];
    const reps = [];
    for (const [name, refs] of b.freeOf(i)) {
      if (rename.has(name) && !external.has(name)) {
        for (const { node, shorthand } of refs) reps.push({ start: node.start, end: node.end, text: shorthand ? `${name}: ${rename.get(name)}` : rename.get(name) });
        continue;
      }
      if (!external.has(name) || stop.has(name)) continue;
      for (const { node, shorthand } of refs) reps.push({ start: node.start, end: node.end, text: shorthand ? `${name}: THREE.${external.get(name)}` : `THREE.${external.get(name)}` });
    }
    for (const id of declIdentifiers(s)) if (rename.has(id.name)) reps.push({ start: id.start, end: id.end, text: rename.get(id.name) });
    reps.sort((a, c) => c.start - a.start);
    let code = b.src.slice(s.start, s.end);
    for (const r of reps) code = code.slice(0, r.start - s.start) + r.text + code.slice(r.end - s.start);
    out += code + (code.endsWith(';') || code.endsWith('}') ? '\n' : ';\n');
  }
  return out;
}

// ---------------------------------------------------------------- CLI

const args = parseArgs(process.argv.slice(2));
const b = loadBundle();

if (args.modules) {
  for (const [ns, list] of b.namespaces) {
    if (ns === 'lt') { console.log(`lt (three.js) — ${list.length} exports`); continue; }
    console.log(`${ns}: ${list.map((e) => `${e.exportName}=${e.alias}`).join(', ')}`);
  }
  console.log(`three.js region ends at top-level statement ${b.threeEnd} of ${b.stmts.length}`);
  process.exit(0);
}

if (args.find) {
  b.stmts.forEach((s, i) => {
    const code = b.src.slice(s.start, s.end);
    const at = code.indexOf(args.find);
    if (at < 0) return;
    const names = [...b.declIndex].filter(([, j]) => j === i).map(([n]) => n);
    console.log(`#${i} [${names.join(',') || s.type}] ${code.length}B …${code.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, ' ')}…`);
  });
  process.exit(0);
}

if (!args.names.length) { console.error('nothing to extract; see header for usage'); process.exit(1); }

const c = closure(b, args.names, args.stop);
const report = [
  `// roots: ${args.names.join(', ')}`,
  `// statements: ${c.want.length}`,
  `// three.js: ${[...new Set(c.external.values())].sort().join(', ')}`,
  c.unresolvedThree.size ? `// UNRESOLVED three-internal: ${[...c.unresolvedThree].join(', ')}` : '',
  c.globals.size ? `// globals: ${[...c.globals].sort().join(', ')}` : '',
  args.stop.size ? `// stopped (external): ${[...args.stop].join(', ')}` : '',
].filter(Boolean).join('\n');

if (args.deps) {
  console.log(report);
  for (const i of c.want) {
    const names = [...b.declIndex].filter(([, j]) => j === i).map(([n]) => n);
    console.log(`#${i} ${names.join(',')} ${b.stmts[i].end - b.stmts[i].start}B`);
  }
  process.exit(0);
}

let code = `import * as THREE from 'three';\n${emit(b, c.want, c.external, args.stop, args.rename)}`;
try { code = transformSync(code, { loader: 'js', format: 'esm', target: 'esnext', legalComments: 'inline' }).code; }
catch (e) { console.error('esbuild reformat failed; writing raw code', e.message); }
const text = `${report}\n${code}`;
if (args.outFile) { fs.mkdirSync(path.dirname(args.outFile), { recursive: true }); fs.writeFileSync(args.outFile, text); console.log(report); console.log(`wrote ${args.outFile} (${text.length} bytes)`); }
else process.stdout.write(text);
