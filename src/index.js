// PANINI — public API. Browser and Node, same module, no build step.

import * as lexer from './lexer.js';
import * as parser from './parser.js';
import * as types from './types.js';
import * as values from './values.js';
import { Interpreter } from './interpreter.js';
import { Runtime, Host, Environment } from './runtime.js';

// Wire the reflective builtins so a PANINI program can lex/parse/typecheck PANINI
// without src/interpreter.js importing the parser directly (which would cycle).
Interpreter.deps = { lexer, parser, types };

export const VERSION = '0.1.0';
export const IMPLEMENTS = 'PANINI_SELF_HOSTING_SPEC.pni v0.1.0';

export const lex = lexer.lex;
export const parse = parser.parse;
export const typecheckProgram = types.typecheckProgram;
export { Interpreter, Runtime, Host, Environment, values };

/** Parse and statically check, without executing anything. */
export function check(source, opts = {}) {
  const ast = parse(source, opts);
  const tc = typecheckProgram(ast);
  return {
    ast,
    diagnostics: [
      ...ast.diagnostics,
      ...tc.errors.map((e) => ({ severity: 'error', ...e })),
      ...tc.warnings.map((w) => ({ severity: 'warning', ...w })),
    ],
    types: tc.types,
    functions: tc.functions,
    ok: ast.diagnostics.filter((d) => d.severity === 'error').length === 0 && tc.errors.length === 0,
  };
}

/** Parse and execute. Returns the runtime, which carries everything that happened. */
export function run(source, opts = {}) {
  const ast = parse(source, opts);
  const runtime = new Runtime(opts);
  const interp = new Interpreter(runtime);
  interp.run(ast, interp.global);
  return { ast, runtime, interpreter: interp };
}

/** Run every TEST and PROPERTY the program declares. */
export function runTests(source, opts = {}) {
  const { runtime, interpreter } = run(source, opts);
  const results = [];
  for (const name of runtime.tests.keys()) results.push(interpreter.runTest(name));
  return { results, runtime };
}

/** The runtime's own report on the fifteen architectural invariants. */
export function invariants(opts = {}) {
  const rt = new Runtime(opts);
  return [...rt.invariants].map(([name, [holds, evidence]]) => ({ name, holds, evidence }));
}

/** What this implementation can and cannot do, with the evidence for each. */
export function capabilities(opts = {}) {
  const rt = new Runtime(opts);
  return [...rt.selfReport].map(([name, [value, evidence]]) => ({ name, value, evidence }));
}

export default {
  VERSION, IMPLEMENTS, lex, parse, check, run, runTests, invariants, capabilities,
  Interpreter, Runtime, Host,
};
