// PANINI type system — structural, and deliberately partial.
//
// The spec calls for generics, unions, records, structural interfaces, nominal
// types and refinement constraints (section V). What is implemented here is the
// structural core plus refinement predicates. Where a verdict cannot be reached,
// this returns `null` — no verdict — rather than a pass. A checker that green-lights
// what it did not check is worse than no checker.

import {
  PList, PMap, PRecord, PSymbol, PResult, POption, PFunction, PNative, PClass,
  PInstance, PType, PArtifact, PClaim, PMeasurement, typeName, isUnresolved,
} from './values.js';

const PRIMITIVES = new Set([
  'Any', 'Unit', 'Bool', 'Int', 'Float', 'Decimal', 'String', 'Symbol', 'Bytes',
  'Duration', 'Timestamp', 'URI', 'Regex', 'Error',
]);

const STRUCTURAL = {
  List: (v) => v instanceof PList,
  Set: (v) => v instanceof PList,
  Map: (v) => v instanceof PMap,
  Stream: (v) => v instanceof PList,
  Option: (v) => v instanceof POption,
  Result: (v) => v instanceof PResult,
  Tuple: (v) => v instanceof PList,
  Record: (v) => v instanceof PRecord || v instanceof PMap,
  Data: () => true,
  Function: (v) => v instanceof PFunction || v instanceof PNative,
  Procedure: (v) => v instanceof PFunction || v instanceof PNative,
  Method: (v) => v instanceof PFunction,
  Class: (v) => v instanceof PClass,
  Object: (v) => v instanceof PInstance || v instanceof PRecord,
  Type: (v) => v instanceof PType,
  Artifact: (v) => v instanceof PArtifact,
  Deliverable: (v) => v instanceof PArtifact,
  File: (v) => v instanceof PArtifact && v.kind === 'FILE',
  Claim: (v) => v instanceof PClaim,
  Measurement: (v) => v instanceof PMeasurement,
  Symbol: (v) => v instanceof PSymbol,
};

/**
 * @returns {true|false|null} true = holds, false = violated, null = no verdict
 */
export function checkTypeRef(value, typeRef, runtime) {
  if (!typeRef || !typeRef.name) return null;
  if (isUnresolved(value)) return null; // unresolved is not a type violation
  const name = typeRef.name;

  if (name === 'Any' || name === '_') return true;
  if (name === 'Unit') return value === null || value === undefined;
  if (name === 'Bool') return typeof value === 'boolean';
  if (name === 'Int') return typeof value === 'number' && Number.isInteger(value);
  if (name === 'Float' || name === 'Decimal') return typeof value === 'number';
  if (name === 'String' || name === 'URI' || name === 'Regex' || name === 'Timestamp') {
    return typeof value === 'string';
  }
  if (name === 'Bytes') return typeof value === 'string' || value instanceof Uint8Array;
  if (STRUCTURAL[name]) return STRUCTURAL[name](value);

  if (typeRef.kind === 'TypeUnion') {
    const l = checkTypeRef(value, typeRef.left, runtime);
    const r = checkTypeRef(value, typeRef.right, runtime);
    if (l === true || r === true) return true;
    if (l === false && r === false) return false;
    return null;
  }

  const declared = runtime && runtime.types.get(name);
  if (declared) {
    const t = declared.type;
    if (t.variants) {
      if (value instanceof PResult) return true;
      if (value instanceof PRecord && t.variants.has(value.name)) return true;
      return null;
    }
    if (t.fields && value instanceof PRecord) {
      for (const f of t.fields.keys()) if (!value.fields.has(f)) return false;
      return true;
    }
    if (t.alias) return checkTypeRef(value, t.alias, runtime);
    return null; // a declared but unstructured type gives no verdict
  }

  if (value instanceof PInstance && value.cls.name === name) return true;
  if (value instanceof PRecord && (value.kind === name || value.name === name)) return true;
  if (value instanceof PSymbol) return null;
  return null;
}

/**
 * Static pass over a parsed program. Reports what it can decide from the AST
 * alone; it does not attempt inference it cannot justify.
 */
export function typecheckProgram(ast) {
  const errors = [];
  const warnings = [];
  const types = new Map();
  const functions = new Map();
  const declared = new Set(PRIMITIVES);

  const walk = (nodes, path) => {
    for (const n of nodes || []) {
      if (n.kind === 'Declaration') {
        if (n.keyword === 'TYPE' || n.keyword === 'SCHEMA' || n.keyword === 'ENUM'
            || n.keyword === 'CLASS' || n.keyword === 'TRAIT' || n.keyword === 'INTERFACE') {
          if (n.name) {
            if (types.has(n.name) && !n.block) {
              warnings.push({
                code: 'duplicate-type', line: n.line,
                message: `${n.keyword} ${n.name} is declared again (first at line ${types.get(n.name)})`,
              });
            } else types.set(n.name, n.line);
            declared.add(n.name);
            (n.generics || []).forEach((g) => declared.add(g.name));
          }
        }
        if (n.keyword === 'FUNCTION' || n.keyword === 'METHOD' || n.keyword === 'PROCEDURE') {
          if (n.name) functions.set(n.name, n);
          for (const p of n.params || []) {
            if (p.type && !declared.has(p.type.name) && !types.has(p.type.name)) {
              warnings.push({
                code: 'unknown-type', line: n.line,
                message: `parameter ${p.name} of ${n.name} has undeclared type ${p.type.name}`,
              });
            }
          }
          const returns = hasReturn(n.body || []);
          const bodyless = !n.block || (n.body || []).length === 0;
          if (n.returnType && !returns && !bodyless && !hasEllipsis(n.body || [])) {
            errors.push({
              code: 'missing-return', line: n.line,
              message: `${n.name} declares -> ${n.returnType.name} but no path returns a value`,
            });
          }
        }
        walk(n.body, `${path}/${n.keyword}`);
      } else if (n.body) walk(n.body, path);
      else if (n.consequent) { walk(n.consequent, path); for (const a of n.alternates || []) walk(a.body, path); }
    }
  };

  walk(ast.body, '');
  return { errors, warnings, types: [...types.keys()], functions: [...functions.keys()] };
}

function hasReturn(body) {
  for (const s of body) {
    if (s.kind === 'Return') return true;
    if (s.kind === 'If') {
      if (hasReturn(s.consequent)) return true;
      for (const a of s.alternates || []) if (hasReturn(a.body)) return true;
    }
    if (s.body && s.kind !== 'Declaration' && hasReturn(s.body)) return true;
    if (s.kind === 'Try' && (hasReturn(s.block) || (s.handler && hasReturn(s.handler.body)))) return true;
    if (s.kind === 'Match') for (const c of s.cases) if (hasReturn(c.body)) return true;
  }
  return false;
}

function hasEllipsis(body) {
  return body.some((s) => s.kind === 'Unresolved'
    || (s.kind === 'ExpressionStatement' && s.expression && s.expression.kind === 'UnresolvedExpr'));
}

export { PRIMITIVES };
