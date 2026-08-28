// PANINI value model.
//
// The one value that carries the most weight here is UNRESOLVED. Spec clause 19:
// "Never silently invent missing canonical source material. Mark unresolved
// material UNRESOLVED and preserve provenance." So `...` in source, an unknown
// operation verb, and a call into a bodyless signature all produce this value —
// they never produce a plausible-looking answer.

export const UNRESOLVED = Symbol('UNRESOLVED');

export class PSymbol {
  constructor(name) { this.name = name; }
  toString() { return this.name; }
}
const symbols = new Map();
export function sym(name) {
  if (!symbols.has(name)) symbols.set(name, new PSymbol(name));
  return symbols.get(name);
}

export class PUnresolved {
  constructor(reason, provenance = {}) {
    this.reason = reason;
    this.provenance = provenance;
    this.unresolved = true;
  }
  toString() { return `UNRESOLVED(${this.reason})`; }
}
export const unresolved = (reason, provenance) => new PUnresolved(reason, provenance);
export const isUnresolved = (v) => v instanceof PUnresolved;

export class PRecord {
  constructor(kind, name, fields = new Map()) {
    this.kind = kind;       // the declaring keyword, e.g. 'CONFIGURATION'
    this.name = name;
    this.fields = fields;   // Map<string, value>
  }
  get(k) { return this.fields.get(k); }
  set(k, v) { this.fields.set(k, v); return this; }
  has(k) { return this.fields.has(k); }
  toString() { return `${this.kind}${this.name ? ` ${this.name}` : ''}`; }
}

export class PList {
  constructor(items = []) { this.items = items; }
  get length() { return this.items.length; }
  toString() { return `[${this.items.map(fmt).join(', ')}]`; }
}

export class PMap {
  constructor(entries = new Map()) { this.entries = entries; }
  toString() { return `{${[...this.entries].map(([k, v]) => `${k}: ${fmt(v)}`).join(', ')}}`; }
}

export class PRange {
  constructor(start, end) { this.start = start; this.end = end; }
  *[Symbol.iterator]() { for (let i = this.start; i <= this.end; i++) yield i; }
  toString() { return `${this.start}..${this.end}`; }
}

export class PResult {
  constructor(ok, value, error) { this.ok = ok; this.value = value; this.error = error; }
  static OK(v) { return new PResult(true, v, null); }
  static ERR(e) { return new PResult(false, null, e); }
  toString() { return this.ok ? `OK(${fmt(this.value)})` : `ERR(${fmt(this.error)})`; }
}

export class POption {
  constructor(present, value) { this.present = present; this.value = value; }
  static SOME(v) { return new POption(true, v); }
  static NONE() { return new POption(false, null); }
  toString() { return this.present ? `SOME(${fmt(this.value)})` : 'NONE'; }
}

export class PFunction {
  constructor(name, params, body, closure, opts = {}) {
    this.name = name;
    this.params = params || [];
    this.body = body;
    this.closure = closure;
    this.returnType = opts.returnType || null;
    this.abstract = !!opts.abstract; // a signature with no body
    this.declaredIn = opts.declaredIn || null;
  }
  toString() { return `FUNCTION ${this.name || '<anonymous>'}/${this.params.length}`; }
}

export class PNative {
  constructor(name, arity, fn, opts = {}) {
    this.name = name;
    this.arity = arity;
    this.fn = fn;
    this.capability = opts.capability || null;
  }
  toString() { return `NATIVE ${this.name}`; }
}

export class PClass {
  constructor(name, fields, methods, opts = {}) {
    this.name = name;
    this.fields = fields;   // Map<string, TypeRef|null>
    this.methods = methods; // Map<string, PFunction>
    this.traits = opts.traits || [];
  }
  toString() { return `CLASS ${this.name}`; }
}

export class PInstance {
  constructor(cls) { this.cls = cls; this.fields = new Map(); }
  toString() { return `<${this.cls.name}>`; }
}

export class PType {
  constructor(name, opts = {}) {
    this.name = name;
    this.generics = opts.generics || [];
    this.variants = opts.variants || null;
    this.fields = opts.fields || null;
    this.alias = opts.alias || null;
    this.where = opts.where || null;   // AST of a refinement predicate
    this.declared = opts.declared || null;
  }
  toString() { return `TYPE ${this.name}`; }
}

// Epistemic status is explicit and non-substitutable (spec section VIII, I9, I10).
export const EPISTEMIC = [
  'RETRIEVED', 'INFERRED', 'PROPOSED', 'UNRESOLVED', 'VERIFIED',
  'OBSERVED', 'SIMULATED', 'EXPERIMENTAL', 'FALSIFIED',
];

export class PClaim {
  constructor(id, opts = {}) {
    this.id = id;
    this.status = opts.status || null;      // one of EPISTEMIC, or null when untagged
    this.source = opts.source || null;
    this.evidence = opts.evidence || null;
    this.provenance = opts.provenance || null;
  }
  toString() { return `CLAIM ${this.id}[${this.status || 'UNTAGGED'}]`; }
}

// Artifact lifecycle. The sequence is quoted from the spec's own comment at
// PANINI_SELF_HOSTING_SPEC.pni lines 431-437 — it is not invented here.
export const ARTIFACT_STATES = ['DRAFT', 'REVIEW', 'APPROVED', 'RELEASED', 'SUPERSEDED', 'ARCHIVED'];

export class PArtifact {
  constructor(id, opts = {}) {
    this.id = id;
    this.kind = opts.kind || 'ARTIFACT';    // ARTIFACT | DELIVERABLE | FILE
    this.type = opts.type || null;
    this.format = opts.format || null;      // MIME
    this.version = opts.version || '0.0.0';
    this.status = opts.status || 'DRAFT';
    this.content = opts.content ?? null;
    this.encoding = opts.encoding || null;
    this.dependsOn = opts.dependsOn || [];
    this.derivedFrom = opts.derivedFrom || null;
    this.provenance = opts.provenance || new Map();
    this.signoffs = [];
    this.history = [];
    this.fields = opts.fields || new Map();
  }
  toString() { return `${this.kind} ${this.id}@${this.version}[${this.status}]`; }
}

export class PMeasurement {
  constructor(id, value, unit, uncertainty, source) {
    this.id = id; this.value = value; this.unit = unit;
    this.uncertainty = uncertainty; this.source = source;
  }
  toString() { return `${this.value}${this.unit ? ` ${this.unit}` : ''}${this.uncertainty ? ` ±${this.uncertainty}` : ''}`; }
}

/** A request the interpreter cannot answer by itself: it belongs to the host. */
export class PYield {
  constructor(channel, payload) {
    this.channel = channel; // 'ask' | 'gate' | 'retrieve' | 'read' | 'human'
    this.payload = payload;
    this.yielded = true;
  }
  toString() { return `YIELD:${this.channel}`; }
}

export function truthy(v) {
  if (v === null || v === undefined) return false;
  if (v === true) return true;
  if (v === false) return false;
  if (isUnresolved(v)) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof PList) return v.items.length > 0;
  if (v instanceof PResult) return v.ok;
  if (v instanceof POption) return v.present;
  return true;
}

export function typeName(v) {
  if (v === null || v === undefined) return 'Unit';
  if (isUnresolved(v)) return 'Unresolved';
  if (typeof v === 'boolean') return 'Bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Float';
  if (typeof v === 'string') return 'String';
  if (v instanceof PSymbol) return 'Symbol';
  if (v instanceof PList) return 'List';
  if (v instanceof PMap) return 'Map';
  if (v instanceof PRange) return 'Range';
  if (v instanceof PResult) return 'Result';
  if (v instanceof POption) return 'Option';
  if (v instanceof PFunction || v instanceof PNative) return 'Function';
  if (v instanceof PClass) return 'Class';
  if (v instanceof PInstance) return v.cls.name;
  if (v instanceof PType) return 'Type';
  if (v instanceof PArtifact) return v.kind === 'FILE' ? 'File' : 'Artifact';
  if (v instanceof PClaim) return 'Claim';
  if (v instanceof PMeasurement) return 'Measurement';
  if (v instanceof PYield) return 'Yield';
  if (v instanceof PRecord) return v.kind;
  return 'Any';
}

// A namespace record can hold itself (spec: MODULE PANINI declares PACKAGE PANINI),
// so formatting is cycle-aware and depth-capped. It abbreviates rather than hangs.
export function fmt(v, depth = 0, seen = null) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return depth === 0 ? v : JSON.stringify(v);
  if (isUnresolved(v)) return `UNRESOLVED(${v.reason})`;
  if (depth > FMT_MAX_DEPTH) return '…';
  const s = seen || new Set();
  if (typeof v === 'object') {
    if (s.has(v)) return v instanceof PRecord ? `${v.kind} ${v.name || ''} {…}`.replace('  ', ' ') : '…';
    s.add(v);
  }
  if (v instanceof PList) return `[${v.items.map((x) => fmt(x, depth + 1, s)).join(', ')}]`;
  if (v instanceof PMap) return `{${[...v.entries].map(([k, x]) => `${k}: ${fmt(x, depth + 1, s)}`).join(', ')}}`;
  if (v instanceof PRecord) {
    const inner = [...v.fields].map(([k, x]) => `${k}: ${fmt(x, depth + 1, s)}`).join(', ');
    return `${v.kind} ${v.name || ''} {${inner}}`.replace('  ', ' ');
  }
  return String(v);
}
export const FMT_MAX_DEPTH = 6;

export function equals(a, b) {
  if (a === b) return true;
  if (a instanceof PSymbol && b instanceof PSymbol) return a.name === b.name;
  if (a instanceof PSymbol && typeof b === 'string') return a.name === b;
  if (typeof a === 'string' && b instanceof PSymbol) return a === b.name;
  if (a instanceof PList && b instanceof PList) {
    return a.items.length === b.items.length && a.items.every((x, i) => equals(x, b.items[i]));
  }
  if (isUnresolved(a) || isUnresolved(b)) return false;
  return false;
}
