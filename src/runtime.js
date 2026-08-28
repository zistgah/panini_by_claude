// PANINI runtime: world state, capabilities, artifacts, provenance, events, host.
//
// THE HOST BOUNDARY IS THE POINT OF THIS FILE.
// The interpreter has no model provider and cannot acquire one. `ASK` does not
// call anybody; it returns a PYield and the host decides what happens — clipboard,
// a tab, a local runtime, a person typing. Same for RETRIEVE, READ and every
// human gate. Spec: PROVIDER_NEUTRALITY, I12 PROVIDERS_ARE_REPLACEABLE, and
// section XXIX's DEFAULT_DENY.
//
// tests/panini.test.mjs asserts by grep that src/ contains no network call and
// no vendor name, and that assertion is proven to bite.

import {
  PRecord, PArtifact, PClaim, PYield, ARTIFACT_STATES, fmt, unresolved,
} from './values.js';

export class PaniniError extends Error {
  constructor(mode, message, node) {
    super(message);
    this.name = 'PaniniError';
    this.mode = mode; // a FailureMode from spec section XXXIII
    this.line = node ? node.line : 0;
  }
}

// ---------------------------------------------------------------------------
// Environment. Identifiers are case-sensitive (D2); keywords were folded in the
// lexer, so nothing here needs to fold again.
// ---------------------------------------------------------------------------
export class Environment {
  constructor(parent = null, label = '') {
    this.vars = new Map();
    this.parent = parent;
    this.label = label;
  }
  has(name) { return this.vars.has(name) || (this.parent ? this.parent.has(name) : false); }
  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined;
  }
  define(name, value) { this.vars.set(name, value); return value; }
  set(name, value) {
    let e = this;
    while (e) {
      if (e.vars.has(name)) { e.vars.set(name, value); return value; }
      e = e.parent;
    }
    this.vars.set(name, value);
    return value;
  }
  child(label = '') { return new Environment(this, label); }
}

// ---------------------------------------------------------------------------
// Capabilities: DEFAULT_DENY, least_privilege, explicit_grant (spec section XXIX).
// ---------------------------------------------------------------------------
export class Capabilities {
  constructor(granted = []) {
    this.declared = new Set();
    this.granted = new Set(granted);
    this.denials = [];
    this.policies = new Set(['DEFAULT_DENY', 'least_privilege', 'explicit_grant']);
  }
  declare(name) { this.declared.add(name); }
  grant(name) { this.granted.add(name); }
  revoke(name) { this.granted.delete(name); }
  allows(name) { return this.granted.has(name); }
  require(name, what, node) {
    if (this.granted.has(name)) return true;
    this.denials.push({ capability: name, what, line: node ? node.line : 0 });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provenance graph: every derivation keeps its ancestry (I8).
// ---------------------------------------------------------------------------
export class Provenance {
  constructor() { this.nodes = new Map(); this.edges = []; }
  record(id, attrs) {
    const prev = this.nodes.get(id) || {};
    this.nodes.set(id, { ...prev, ...attrs });
  }
  derive(child, parent, how) {
    this.edges.push({ from: parent, to: child, how });
  }
  ancestry(id) {
    const out = [];
    const seen = new Set();
    let frontier = [id];
    while (frontier.length) {
      const next = [];
      for (const n of frontier) {
        for (const e of this.edges) {
          if (e.to === n && !seen.has(e.from)) {
            seen.add(e.from);
            out.push(e);
            next.push(e.from);
          }
        }
      }
      frontier = next;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Artifacts. State moves DRAFT -> REVIEW -> APPROVED -> RELEASED ->
// SUPERSEDED/ARCHIVED. That ordering is the spec's own (lines 431-437), quoted
// rather than designed here; nothing enforces a transition the spec did not state.
// ---------------------------------------------------------------------------
export class ArtifactStore {
  constructor(provenance) {
    this.items = new Map();       // id -> PArtifact (current)
    this.versions = new Map();    // "id@version" -> PArtifact
    this.checkpoints = new Map();
    this.baselines = new Map();
    this.branches = new Map();
    this.provenance = provenance;
  }
  put(a) {
    this.items.set(a.id, a);
    this.versions.set(`${a.id}@${a.version}`, a);
    this.provenance.record(a.id, {
      kind: a.kind, version: a.version, status: a.status, format: a.format,
    });
    return a;
  }
  get(id) { return this.items.get(id); }
  at(id, version) { return this.versions.get(`${id}@${version}`) || null; }
  transition(a, to, why) {
    if (!ARTIFACT_STATES.includes(to)) {
      throw new PaniniError('VALIDATION_ERROR', `unknown artifact state ${to}`);
    }
    a.history.push({ from: a.status, to, why, at: this.now });
    a.status = to;
    this.provenance.record(a.id, { status: to });
    return a;
  }
  snapshot() {
    return [...this.items.values()].map((a) => ({
      id: a.id, kind: a.kind, version: a.version, status: a.status,
      format: a.format, signoffs: a.signoffs.length,
      derivedFrom: a.derivedFrom, dependsOn: a.dependsOn,
    }));
  }
}

// ---------------------------------------------------------------------------
// Events, signals, watches, actors (spec section XI).
// PARALLEL runs its branches on a deterministic scheduler: declaration order,
// run to completion. DETERMINISTIC_ORCHESTRATION is a stated principle, so
// genuine nondeterminism would be a defect, not a feature.
// ---------------------------------------------------------------------------
export class EventBus {
  constructor() {
    this.types = new Map();     // event name -> params
    this.signals = new Set();
    this.watches = [];          // { event, param, run }
    this.handlers = [];         // { signal, run }
    this.actors = new Map();
    this.log = [];
  }
  declareEvent(name, params) { this.types.set(name, params || []); }
  declareSignal(name) { this.signals.add(name); }
  watch(event, param, run) { this.watches.push({ event, param, run }); }
  on(signal, run) { this.handlers.push({ signal, run }); }
  emit(event, payload) {
    this.log.push({ kind: 'event', event, at: this.log.length });
    let fired = 0;
    for (const w of this.watches) {
      if (w.event === event) { w.run(payload); fired += 1; }
    }
    for (const [, actor] of this.actors) {
      const h = actor.handlers.get(event);
      if (h) { actor.mailbox.push({ event, payload }); h(payload); fired += 1; }
    }
    return fired;
  }
  signal(name, payload) {
    this.log.push({ kind: 'signal', signal: name, at: this.log.length });
    let fired = 0;
    for (const h of this.handlers) {
      if (h.signal === name) { h.run(payload); fired += 1; }
    }
    return fired;
  }
}

// ---------------------------------------------------------------------------
// The host. This default host answers nothing and records every request.
// A real host (CLI, browser, an operator at a keyboard) subclasses it.
// Nothing below this line reaches a network, a provider, or a filesystem.
// ---------------------------------------------------------------------------
export class Host {
  constructor(opts = {}) {
    this.pending = [];
    this.answers = new Map(); // pre-supplied answers, keyed by request id
    this.transcript = [];
    this.strict = opts.strict !== false;
  }
  /** Every outward request funnels through here and comes back as a yield. */
  request(channel, payload) {
    const id = `${channel}#${this.pending.length + 1}`;
    const record = { id, channel, payload, at: this.transcript.length };
    this.transcript.push(record);
    if (this.answers.has(id)) return this.answers.get(id);
    this.pending.push(record);
    return new PYield(channel, { ...payload, id });
  }
  ask(model, prompt) { return this.request('ask', { model, prompt }); }
  retrieve(query) { return this.request('retrieve', { query }); }
  read(source) { return this.request('read', { source }); }
  /** A gate is crossed by a person typing an exact word. No default, no trim, no fold. */
  gate(name, word, subject) { return this.request('gate', { name, word, subject }); }
  human(what, subject) { return this.request('human', { what, subject }); }
  print(text) { this.transcript.push({ channel: 'print', text }); }
  supply(id, value) { this.answers.set(id, value); }
}

/**
 * The runtime's self-report. Every entry is what THIS implementation can do,
 * with the evidence that shows it. `CAN_COMPILE` is FALSE and says so; nothing
 * here is set to TRUE because the spec asserts it.
 */
export function selfReport() {
  return new Map(Object.entries({
    // capability -> [value, evidence]
    CAN_PARSE: [true, 'src/parser.js parses spec/PANINI_SELF_HOSTING_SPEC.pni with 0 diagnostics'],
    CAN_TYPECHECK: [true, 'src/types.js checks declared parameter and return types; structural only'],
    CAN_EXECUTE: [true, 'src/interpreter.js is a tree-walking evaluator'],
    CAN_VERIFY: [true, 'TEST/PROPERTY/ASSERT/REQUIRE/ENSURE execute and report'],
    CAN_LOWER: [false, 'no IR: spec section XXIII stages 3-4 are not implemented'],
    CAN_GENERATE_TARGETS: [false, 'no codegen: native/WASM/container backends are not implemented'],
    CAN_COMPILE: [false, 'no compiler: bootstrap stages 1-6 are not implemented'],
    CAN_BUILD: [false, 'PROGRAM panini_build depends on COMPILE, which is UNRESOLVED'],
    CAN_RUN: [true, 'PROGRAM bodies execute'],
  }));
}

/**
 * The fifteen architectural invariants of spec section XXXVII, each bound to
 * what this implementation actually does. UNRESOLVED where the machinery to
 * decide it does not exist. Read tests/panini.test.mjs before changing any TRUE.
 */
export function invariantReport() {
  return new Map(Object.entries({
    PANINI_IS_GENERAL_PURPOSE: [true,
      'functions, closures, classes, traits, rules, events, actors, streams and workflow all execute'],
    PANINI_IS_SELF_HOSTING: [false,
      'this is a JS bootstrap (stage 0). No PANINI-in-PANINI compiler exists; stages 1-6 are not built'],
    CYCLER_IS_PROGRAMMABLE_LIFECYCLE: [true,
      'CYCLER/STAGE/GATE build a lifecycle machine with operations, not a prompt list'],
    GENIE_IS_META_CYCLER: [true,
      'META_CYCLER is a distinct construct with COMPOSE/ELEVATE/DESCEND/SPLIT/MERGE'],
    FAKIR_RETRIEVES_DONT_RECONSTRUCT: [true,
      'RETRIEVE/READ yield to the host; an unanswered retrieval returns UNRESOLVED, never content'],
    ARTIFACTS_ARE_FIRST_CLASS: [true, 'ArtifactStore with versions, revisions, states and signoffs'],
    FILE_BLOCKS_HAVE_SEMANTIC_MIME: [true, 'FILE carries MIME and content survives byte-for-byte'],
    PROVENANCE_IS_PRESERVED: [true, 'every derivation writes an edge into the provenance graph'],
    EPISTEMIC_STATUS_IS_EXPLICIT: [true, 'an untagged CLAIM cannot be canonicalized'],
    SIMULATION_CANNOT_BECOME_EXPERIMENT: [true,
      'EXPERIMENT refuses a plan whose mode is not EXPERIMENTAL; SIMULATE stamps SIMULATED'],
    HUMAN_SIGNOFF_IS_EXPLICIT: [true, 'SIGNOFF/RELEASE yield to the host and require an exact typed word'],
    PROVIDERS_ARE_REPLACEABLE: [true,
      'the interpreter contains no provider: ASK yields, and a test greps for it'],
    SUBSTRATE_IS_ABSTRACTED: [true, 'CEM is an interface; no backend is named in the semantics'],
    PARADIGMS_ARE_COMPOSABLE: [true,
      'functional, imperative, OO, declarative, reactive and workflow constructs coexist in one program'],
    PANINI_CAN_EXPRESS_ITS_OWN_IMPLEMENTATION: [false,
      'PANINI can express and inspect PANINI (lex/parse/typecheck are callable from PANINI source), '
      + 'but the implementation is written in JavaScript. Expressing it is not yet building it'],
  }));
}

export class Runtime {
  constructor(opts = {}) {
    this.host = opts.host || new Host();
    this.capabilities = new Capabilities(opts.capabilities || []);
    this.provenance = new Provenance();
    this.artifacts = new ArtifactStore(this.provenance);
    this.events = new EventBus();
    this.diagnostics = [];
    this.output = [];
    this.claims = new Map();
    this.models = new Map();
    this.agents = new Map();
    this.cyclers = new Map();
    this.gates = new Map();
    this.tests = new Map();
    this.programs = new Map();
    this.rules = new Map();
    this.types = new Map();
    this.schemas = new Map();
    this.constitution = null;
    this.principles = new Set();
    this.operations = [];       // every operation statement, resolved or not
    this.unresolvedCount = 0;
    this.selfReport = selfReport();
    this.invariants = invariantReport();
    this.loopLimit = opts.loopLimit || 100000; // a loop that cannot end must abort, not hang
    // NOW is frozen for the whole run: REPRODUCIBILITY is a stated principle,
    // and a clock read per call would make two runs differ for no reason.
    this.now = opts.now || new Date().toISOString();
  }

  diagnose(severity, code, message, node) {
    // The same finding at the same line is one finding with a count, not
    // a hundred thousand entries. Repetition is recorded, never discarded.
    const line = node ? node.line : 0;
    const key = `${severity}|${code}|${line}|${message}`;
    const seen = this._seen || (this._seen = new Map());
    if (seen.has(key)) { seen.get(key).count += 1; return seen.get(key); }
    const d = {
      severity, code, message, line, count: 1,
      source: node && node.source ? node.source : undefined,
    };
    seen.set(key, d);
    this.diagnostics.push(d);
    return d;
  }

  /** Record an operation, collapsing repeats of the same verb at the same line. */
  recordOperation(entry) {
    const key = `${entry.verb}|${entry.line}|${entry.status || ''}`;
    const seen = this._ops || (this._ops = new Map());
    if (seen.has(key)) { seen.get(key).count += 1; return seen.get(key); }
    const e = { count: 1, ...entry };
    seen.set(key, e);
    this.operations.push(e);
    return e;
  }

  markUnresolved(reason, node) {
    this.unresolvedCount += 1;
    this.diagnose('unresolved', 'UNRESOLVED', reason, node);
    return unresolved(reason, { line: node ? node.line : 0 });
  }

  print(text) {
    this.output.push(text);
    this.host.print(text);
  }

  report() {
    return {
      now: this.now,
      output: this.output,
      diagnostics: this.diagnostics,
      unresolved: this.unresolvedCount,
      artifacts: this.artifacts.snapshot(),
      capabilities: {
        declared: [...this.capabilities.declared],
        granted: [...this.capabilities.granted],
        denials: this.capabilities.denials,
      },
      pending: this.host.pending.map((p) => ({ id: p.id, channel: p.channel })),
      operations: this.operations.length,
      events: this.events.log.length,
    };
  }
}

export { PRecord, PArtifact, PClaim, fmt };
