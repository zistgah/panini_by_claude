// PANINI interpreter — a tree-walking evaluator over the parser's AST.
//
// Three rules run through everything below:
//   1. `...`, an unbuilt operation, and a bodyless signature all produce
//      UNRESOLVED. They never produce a plausible value. (Spec clause 19.)
//   2. Anything outside the process — a model, a retrieval, a person's signoff —
//      is a PYield handed to the host. The interpreter has no provider. (I12.)
//   3. A failure is data: it is recorded with a FailureMode and the run continues
//      where continuing is meaningful. (Spec section XXXIII.)

import {
  PSymbol, sym, PRecord, PList, PMap, PRange, PResult, POption, PFunction, PNative,
  PClass, PInstance, PType, PClaim, PArtifact, PMeasurement, PYield, PUnresolved,
  EPISTEMIC, truthy, typeName, fmt, equals, isUnresolved, unresolved,
} from './values.js';
import { Environment, Runtime, PaniniError } from './runtime.js';
import { checkTypeRef } from './types.js';

class ReturnSignal { constructor(value) { this.value = value; } }
class BreakSignal {}
class ContinueSignal {}

// Operations the spec names for the compiler pipeline. This implementation is
// the stage-0 bootstrap; it does not have them, and says so rather than pretending.
const UNBUILT = new Map(Object.entries({
  COMPILE: 'no compiler: spec section XXIII is not implemented in this bootstrap',
  SELF_COMPILE: 'no compiler: bootstrap stage 5 is not implemented',
  CODEGEN: 'no code generator: native/WASM/container backends are not implemented',
  LOWER: 'no IR lowering: bootstrap stage 3 is not implemented',
  OPTIMIZE: 'no optimizer: bootstrap stage 4 is not implemented',
  PACKAGE: 'no package builder: PANINI.Tools is not implemented',
  PUBLISH: 'publishing is an irreversible external action and has no implemented adapter',
}));

// Verbs that are lifecycle operations on artifacts inside a stage. Each one needs
// an answer from outside the interpreter, so each one yields.
// Every verb the operation switch below decides. Kept beside it so hasVerb()
// cannot drift from the switch.
const KNOWN_VERBS = new Set(["ARCHIVE", "ASK", "BASELINE", "BRANCH", "CHECKPOINT", "COMPARE", "DIFF", "EMIT", "EXPERIMENT", "FALSIFY", "GRANT", "INVALIDATE", "MERGE", "READ", "RELEASE", "REQUEST", "RESTORE", "RESUME", "RETRIEVE", "RUN", "SERIALIZE", "SIGNAL", "SIGNOFF", "SIMULATE", "SUPERSEDE", "VERIFY", "WRITE"]);

const STAGE_VERBS = new Set([
  'ELICIT', 'CAPTURE', 'STRUCTURE', 'REVIEW', 'REVISE', 'DERIVE', 'REALIZE',
  'GENERATE', 'MEASURE', 'INTEGRATE', 'CONCEIVE', 'IMAGINE', 'NARRATE', 'CRITIQUE',
  'DISCOVER', 'SPECIFY', 'FORMALIZE', 'IMPLEMENT', 'DOCUMENT', 'AUDIT', 'REFINE',
  'INTERPRET', 'CORRELATE', 'GUIDE', 'MAP', 'NAVIGATE', 'ENTER', 'REMEMBER',
]);

export class Interpreter {
  constructor(runtime = new Runtime()) {
    this.rt = runtime;
    this.global = new Environment(null, 'global');
    this.callDepth = 0;
    this.installBuiltins();
  }

  // =========================================================================
  // Entry points
  // =========================================================================
  run(ast, env = this.global) {
    for (const node of ast.body) {
      try {
        this.execute(node, env);
      } catch (err) {
        if (err instanceof ReturnSignal) break;
        if (err instanceof PaniniError) {
          this.rt.diagnose('error', err.mode, err.message, { line: err.line });
          continue;
        }
        throw err;
      }
    }
    return this.rt;
  }

  installBuiltins() {
    const g = this.global;
    const def = (name, arity, fn, opts) => g.define(name, new PNative(name, arity, fn, opts));

    // --- Reflection over PANINI itself. This is what makes PANINI able to read
    // --- PANINI: a .pni program can lex, parse and typecheck .pni source.
    def('lex', 1, (args) => {
      const { lex } = this.deps.lexer;
      const { tokens } = lex(String(args[0] ?? ''));
      return new PList(tokens.filter((t) => t.type !== 'EOF').map((t) => {
        const m = new Map([['type', t.type], ['value', t.value === null ? null : String(t.value)], ['line', t.line]]);
        return new PMap(m);
      }));
    });
    def('parse', 1, (args) => {
      const { parse } = this.deps.parser;
      try {
        const ast = parse(String(args[0] ?? ''));
        const errs = ast.diagnostics.filter((d) => d.severity === 'error');
        const r = new PRecord('ParseResult', null, new Map([
          ['success', errs.length === 0],
          ['nodes', ast.body.length],
          ['diagnostics', new PList(ast.diagnostics.map((d) => `${d.code}: ${d.message}`))],
        ]));
        r.ast = ast;
        return r;
      } catch (err) {
        return new PRecord('ParseResult', null, new Map([
          ['success', false], ['nodes', 0],
          ['diagnostics', new PList([String(err.message)])],
        ]));
      }
    });
    def('typecheck', 1, (args) => {
      const { parse } = this.deps.parser;
      const { typecheckProgram } = this.deps.types;
      try {
        const ast = parse(String(args[0] ?? ''));
        const res = typecheckProgram(ast);
        return new PRecord('TypecheckResult', null, new Map([
          ['success', res.errors.length === 0],
          ['errors', new PList(res.errors.map((e) => e.message))],
          ['types', res.types.length],
        ]));
      } catch (err) {
        return new PRecord('TypecheckResult', null, new Map([
          ['success', false], ['errors', new PList([String(err.message)])], ['types', 0],
        ]));
      }
    });

    def('LEN', 1, (args) => {
      const v = args[0];
      if (v instanceof PList) return v.items.length;
      if (typeof v === 'string') return v.length;
      if (v instanceof PMap) return v.entries.size;
      return 0;
    });
    def('TYPEOF', 1, (args) => sym(typeName(args[0])));
    def('OK', 1, (args) => PResult.OK(args[0]));
    def('ERR', 1, (args) => PResult.ERR(args[0]));
    def('SOME', 1, (args) => POption.SOME(args[0]));
    def('NONE', 0, () => POption.NONE());
    def('MAP', 2, (args) => {
      const [list, f] = args;
      if (!(list instanceof PList)) return unresolved('MAP expects a List');
      return new PList(list.items.map((x) => this.callValue(f, [x])));
    });
    def('FILTER', 2, (args) => {
      const [list, f] = args;
      if (!(list instanceof PList)) return unresolved('FILTER expects a List');
      return new PList(list.items.filter((x) => truthy(this.callValue(f, [x]))));
    });
    def('REDUCE', 3, (args) => {
      const [list, f, init] = args;
      if (!(list instanceof PList)) return unresolved('REDUCE expects a List');
      return list.items.reduce((acc, x) => this.callValue(f, [acc, x]), init);
    });
    def('ENV', 1, (args) => {
      // Reading process environment is a capability, and it is denied by default.
      const key = String(args[0]);
      if (!this.rt.capabilities.require('process.env', `ENV(${key})`, null)) {
        return unresolved(`ENV(${key}) requires capability process.env`);
      }
      return this.rt.host.request('env', { key });
    });
    def('reproducibly_equal', 2, (args) => fmt(args[0], 1) === fmt(args[1], 1));
    def('downstream', 1, (args) => {
      const id = args[0] instanceof PArtifact ? args[0].id : String(args[0]);
      const out = this.rt.provenance.edges.filter((e) => e.from === id).map((e) => e.to);
      return new PList(out);
    });
    def('affected_tests', 1, () => new PList([...this.rt.tests.keys()]));
    def('canonicalize', 1, (args) => this.canonicalize(args[0]));
  }

  /** Module wiring, filled in by index.js to avoid an import cycle. */
  get deps() { return Interpreter.deps; }

  // =========================================================================
  // Statements
  // =========================================================================
  execute(node, env) {
    switch (node.kind) {
      case 'Declaration': return this.declare(node, env);
      case 'Invariant': return this.evalInvariant(node, env);
      case 'Section': return this.evalSection(node, env);
      case 'Assign': return this.assign(node, env);
      case 'Declare': {
        const v = node.value ? this.evaluate(node.value, env) : null;
        if (node.type) this.assertType(v, node.type, node, env);
        return env.define(node.name, v);
      }
      case 'Return': throw new ReturnSignal(node.value ? this.evaluate(node.value, env) : null);
      case 'Break':
        if (!node.when || truthy(this.evaluate(node.when, env))) throw new BreakSignal();
        return null;
      case 'Continue':
        if (!node.when || truthy(this.evaluate(node.when, env))) throw new ContinueSignal();
        return null;
      case 'Print': {
        const parts = node.args.map((a) => fmt(this.evaluate(a, env)));
        this.rt.print(parts.join(' '));
        return null;
      }
      case 'If': {
        if (truthy(this.evaluate(node.test, env))) return this.block(node.consequent, env.child('if'));
        for (const alt of node.alternates) {
          if (alt.test === null || truthy(this.evaluate(alt.test, env))) {
            return this.block(alt.body, env.child('else'));
          }
        }
        return null;
      }
      case 'Loop': return this.loop(node, env);
      case 'Repeat': return this.repeat(node, env);
      case 'ForEach': return this.forEach(node, env);
      case 'Try': return this.tryStatement(node, env);
      case 'Match': return this.match(node, env);
      case 'Parallel': return this.parallel(node, env);
      case 'Obligation': return this.obligation(node, env);
      case 'Operation': return this.operation(node, env);
      case 'Signature': {
        // A signature declares an operation; it does not perform one.
        this.rt.recordOperation({ verb: 'SIGNATURE', source: node.source, line: node.line, status: 'declared' });
        return null;
      }
      case 'Reactive': return this.reactive(node, env);
      case 'Import': {
        for (const n of node.names) {
          if (!env.has(n) && !env.has(n.split('.')[0])) {
            this.rt.diagnose('warning', 'unresolved-import', `IMPORT ${n}: no such module in this program`, node);
          }
        }
        return null;
      }
      case 'Export': {
        const mod = env.get('__module__');
        if (mod instanceof PRecord) mod.set('exports', new PList(node.names.map((n) => sym(n))));
        return null;
      }
      case 'Field': {
        const holder = env.get('__fields__');
        if (holder instanceof Map) holder.set(node.name, node.type);
        return null;
      }
      case 'Variant': {
        const holder = env.get('__variants__');
        if (holder instanceof Map) holder.set(node.name, node.params);
        const self = this;
        env.define(node.name, new PNative(node.name, node.params.length, (args) => {
          if (node.name === 'OK') return PResult.OK(args[0]);
          if (node.name === 'ERR') return PResult.ERR(args[0]);
          const r = new PRecord('Variant', node.name, new Map());
          node.params.forEach((p, i) => r.set(p.name, args[i] ?? null));
          return r;
        }));
        return null;
      }
      case 'Production': {
        const g = env.get('__grammar__');
        if (g instanceof Map) g.set(node.name, node.rhs);
        return null;
      }
      case 'Content': {
        const holder = env.get('__content__');
        if (holder && holder.set) holder.set('text', node.text);
        return node.text;
      }
      case 'Unresolved': {
        // An ellipsis is the point at which the spec stops saying what happens.
        // Inside a call, execution stops there and the call returns UNRESOLVED;
        // falling through would return NULL, a value the spec never promised.
        // Outside a call there is nothing to return from, so it is marked and
        // the next declaration is read.
        const u = this.rt.markUnresolved('an ellipsis body: this behaviour is not specified', node);
        if (this.callDepth > 0) throw new ReturnSignal(u);
        return u;
      }
      case 'ExpressionStatement': return this.evaluate(node.expression, env);
      default:
        this.rt.diagnose('warning', 'unhandled', `no execution rule for ${node.kind}`, node);
        return null;
    }
  }

  block(stmts, env) {
    let last = null;
    for (const s of stmts) last = this.execute(s, env);
    return last;
  }

  assign(node, env) {
    const value = this.evaluate(node.value, env);
    const t = node.target;
    if (t.kind === 'Identifier') return env.set(t.name, value);
    if (t.kind === 'Index') {
      const obj = this.evaluate(t.object, env);
      const idx = this.evaluate(t.index, env);
      if (obj instanceof PMap) { obj.entries.set(String(fmt(idx, 1)), value); return value; }
      if (obj instanceof PList) { obj.items[Number(idx)] = value; return value; }
      if (obj instanceof PInstance) { obj.fields.set(String(fmt(idx, 1)), value); return value; }
      if (obj instanceof PRecord) { obj.set(String(fmt(idx, 1)), value); return value; }
      throw new PaniniError('RUNTIME_ERROR', `cannot index-assign into ${typeName(obj)}`, node);
    }
    if (t.kind === 'Member') {
      const obj = this.evaluate(t.object, env);
      if (obj instanceof PInstance) { obj.fields.set(t.property, value); return value; }
      if (obj instanceof PRecord) { obj.set(t.property, value); return value; }
      if (obj instanceof PArtifact) { obj.fields.set(t.property, value); return value; }
      throw new PaniniError('RUNTIME_ERROR', `cannot assign to ${t.property} on ${typeName(obj)}`, node);
    }
    throw new PaniniError('RUNTIME_ERROR', 'invalid assignment target', node);
  }

  loop(node, env) {
    let n = 0;
    for (;;) {
      const raw = this.evaluate(node.test, env);
      // An unbound name is not a decided truth. A loop does not run on a guess.
      if (raw instanceof PSymbol && !env.has(raw.name)) {
        this.rt.diagnose('unresolved', 'UNRESOLVED',
          `${node.mode} guard "${raw.name}" is not established; the loop was not entered`, node);
        break;
      }
      const t = truthy(raw);
      const go = node.mode === 'WHILE' ? t : !t;
      if (!go) break;
      // A loop that cannot end aborts; it does not hang the host.
      if ((n += 1) > this.rt.loopLimit) {
        this.rt.diagnose('error', 'RUNTIME_ERROR',
          `${node.mode} exceeded ${this.rt.loopLimit} iterations and was aborted`, node);
        break;
      }
      const pendingBefore = this.rt.host.pending.length;
      try { this.block(node.body, env.child('loop')); }
      catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
      // The body handed something to the host. Spinning without the answer
      // would be pretending the answer arrived, so the loop suspends here.
      if (this.rt.host.pending.length > pendingBefore) {
        this.rt.diagnose('unresolved', 'UNRESOLVED',
          `${node.mode} suspended after ${n} iteration(s): its body is awaiting the host`, node);
        break;
      }
    }
    return null;
  }

  repeat(node, env) {
    const rawCount = node.count ? this.evaluate(node.count, env) : 0;
    if (rawCount instanceof PSymbol || isUnresolved(rawCount)) {
      this.rt.diagnose('unresolved', 'UNRESOLVED',
        'REPEAT count is not established; the block was not entered', node);
      return null;
    }
    const count = Number(rawCount);
    for (let i = 0; i < count; i++) {
      try { this.block(node.body, env.child('repeat')); }
      catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
    return null;
  }

  forEach(node, env) {
    const it = this.evaluate(node.iterable, env);
    let items;
    if (it instanceof PRange) items = [...it];
    else if (it instanceof PList) items = it.items;
    else if (typeof it === 'string') items = [...it];
    else if (it instanceof PMap) items = [...it.entries.keys()];
    else if (isUnresolved(it)) {
      this.rt.diagnose('unresolved', 'UNRESOLVED',
        `${node.mode} over an unresolved collection: ${it.reason}`, node);
      return null;
    } else if (it instanceof PSymbol && !env.has(it.name)) {
      this.rt.diagnose('unresolved', 'UNRESOLVED',
        `${node.mode} over "${it.name}", which is not established`, node);
      return null;
    } else {
      this.rt.diagnose('error', 'TYPE_ERROR', `${node.mode} needs a collection, got ${typeName(it)}`, node);
      return null;
    }
    let n = 0;
    for (const item of items) {
      if ((n += 1) > this.rt.loopLimit) {
        this.rt.diagnose('error', 'RUNTIME_ERROR', `${node.mode} exceeded the iteration limit`, node);
        break;
      }
      const scope = env.child('foreach');
      scope.define(node.name, item);
      try { this.block(node.body, scope); }
      catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
    return null;
  }

  tryStatement(node, env) {
    try {
      this.block(node.block, env.child('try'));
    } catch (e) {
      if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) {
        if (node.finalizer) this.block(node.finalizer, env.child('finally'));
        throw e;
      }
      if (node.handler) {
        const scope = env.child('catch');
        const err = e instanceof PaniniError
          ? new PRecord('Error', null, new Map([['mode', sym(e.mode)], ['message', e.message]]))
          : new PRecord('Error', null, new Map([['mode', sym('RUNTIME_ERROR')], ['message', String(e.message)]]));
        scope.define(node.handler.param, err);
        this.block(node.handler.body, scope);
      } else {
        this.rt.diagnose('error', 'RUNTIME_ERROR', String(e.message), node);
      }
    } finally {
      if (node.finalizer) this.block(node.finalizer, env.child('finally'));
    }
    return null;
  }

  match(node, env) {
    const subject = this.evaluate(node.subject, env);
    for (const c of node.cases) {
      const scope = env.child('case');
      let matched = false;
      if (c.pattern.kind === 'Wildcard') matched = true;
      else if (c.pattern.kind === 'Identifier' && !env.has(c.pattern.name)) {
        // A bare unbound name binds the subject, as a pattern variable.
        scope.define(c.pattern.name, subject);
        matched = true;
      } else {
        matched = equals(this.evaluate(c.pattern, scope), subject)
          || this.evaluate(c.pattern, scope) === subject;
      }
      if (matched && c.guard) matched = truthy(this.evaluate(c.guard, scope));
      if (matched) return this.block(c.body, scope);
    }
    return null;
  }

  parallel(node, env) {
    // Deterministic scheduling: declaration order, each branch to completion.
    const results = [];
    for (const s of node.body) {
      try { results.push(this.execute(s, env.child('parallel'))); }
      catch (e) {
        if (e instanceof PaniniError) {
          this.rt.diagnose('error', e.mode, `parallel branch failed: ${e.message}`, node);
          results.push(unresolved(`branch failed: ${e.message}`));
        } else throw e;
      }
    }
    return new PList(results);
  }

  obligation(node, env) {
    const value = this.evaluate(node.test, env);
    const ok = truthy(value);
    const record = {
      mode: node.mode, source: node.source, line: node.line,
      result: isUnresolved(value) ? 'UNRESOLVED' : (ok ? 'PASS' : 'FAIL'),
    };
    this.rt.recordOperation({ verb: node.mode, ...record });
    if (isUnresolved(value)) {
      this.rt.diagnose('unresolved', 'UNRESOLVED', `${node.mode} could not be decided: ${value.reason}`, node);
    } else if (!ok) {
      this.rt.diagnose('error', 'VALIDATION_ERROR', `${node.mode} failed: ${node.source}`, node);
    }
    return ok;
  }

  reactive(node, env) {
    const run = (payload) => {
      const scope = env.child(node.mode.toLowerCase());
      if (payload && payload.bind) for (const [k, v] of payload.bind) scope.define(k, v);
      this.block(node.body, scope);
    };
    switch (node.mode) {
      case 'WATCH': {
        const s = node.subject;
        const event = s && s.kind === 'Call' ? this.nameOf(s.callee) : this.nameOf(s);
        const param = s && s.kind === 'Call' && s.args[0] ? this.nameOf(s.args[0]) : null;
        this.rt.events.watch(event, param, (payload) => run({ bind: param ? [[param, payload]] : [] }));
        return null;
      }
      case 'ON': {
        const s = this.evaluate(node.subject, env);
        const name = s instanceof PSymbol ? s.name : String(fmt(s, 1)).replace(/^"|"$/g, '');
        if (this.rt.events.types.has(name)) {
          this.rt.events.watch(name, null, (payload) => run({ bind: [] }));
        } else {
          this.rt.events.on(name, () => run({ bind: [] }));
        }
        return null;
      }
      case 'WHEN':
      case 'AFTER': {
        // A condition, evaluated now and re-checkable later. Recorded either way.
        const cond = () => truthy(this.evaluate(node.subject, env));
        this.rt.recordOperation({
          verb: node.mode, line: node.line,
          status: 'registered', condition: node.subject,
        });
        let ok = false;
        try { ok = cond(); } catch { ok = false; }
        if (ok) run({ bind: [] });
        return null;
      }
      default: return null;
    }
  }

  nameOf(node) {
    if (!node) return '';
    if (node.kind === 'Identifier') return node.name;
    if (node.kind === 'Member') return `${this.nameOf(node.object)}.${node.property}`;
    if (node.kind === 'String') return node.value;
    return '';
  }

  // =========================================================================
  // Operations
  // =========================================================================
  // True when this runtime has an execution rule for a verb. Used so that a
  // property line in a MODULE body (D13) is never mistaken for an unbuilt verb,
  // and never the other way round.
  hasVerb(verb) {
    const v = String(verb).toUpperCase();
    return UNBUILT.has(v) || STAGE_VERBS.has(v) || KNOWN_VERBS.has(v);
  }

  operation(node, env) {
    const verb = node.verbUpper;
    const operands = node.operands.map((o) => this.evaluate(o, env));
    const raw = node.operands;
    const clause = (p) => {
      const c = node.clauses.find((x) => x.prep === p);
      return c ? this.evaluate(c.value, env) : undefined;
    };
    const record = (status, detail) => {
      this.rt.recordOperation({ verb, status, detail, line: node.line, source: node.source });
    };

    if (UNBUILT.has(verb)) {
      record('unbuilt', UNBUILT.get(verb));
      return this.rt.markUnresolved(`${verb}: ${UNBUILT.get(verb)}`, node);
    }

    switch (verb) {
      case 'RUN': return this.doRun(operands[0], raw[0], node, env, record);
      case 'SIGNOFF': case 'REQUEST': return this.doSignoff(verb, operands, raw, node, env, record);
      case 'RELEASE': return this.doRelease(operands[0], raw[0], clause('VERSION'), node, env, record);
      case 'CHECKPOINT': {
        const subject = operands[0];
        const name = clause('AS') ?? (typeof subject === 'string' ? subject : this.nameOf(raw[0]));
        this.rt.artifacts.checkpoints.set(String(name), this.snapshotOf(subject));
        record('ok', `checkpoint ${name}`);
        return sym(String(name));
      }
      case 'BASELINE':
        this.rt.artifacts.baselines.set(String(operands[0]), this.rt.artifacts.snapshot());
        record('ok', `baseline ${operands[0]}`);
        return null;
      case 'BRANCH':
        this.rt.artifacts.branches.set(String(operands[0]), this.rt.artifacts.snapshot());
        record('ok', `branch ${operands[0]}`);
        return null;
      case 'MERGE': {
        const from = String(operands[0]);
        const into = String(clause('INTO') ?? '');
        if (!this.rt.artifacts.branches.has(from)) {
          record('fail', `no branch ${from}`);
          this.rt.diagnose('error', 'VALIDATION_ERROR', `MERGE: no branch named ${from}`, node);
          return false;
        }
        record('ok', `merge ${from} into ${into}`);
        this.rt.provenance.derive(into, from, 'MERGE');
        return true;
      }
      case 'DIFF': {
        const a = this.resolveArtifact(raw[0], env);
        const b = this.resolveArtifact(raw[1], env);
        if (!a || !b) {
          record('unresolved', 'one or both artifact versions do not exist');
          return this.rt.markUnresolved('DIFF: an artifact version named here does not exist', node);
        }
        const changed = [];
        for (const k of new Set([...a.fields.keys(), ...b.fields.keys()])) {
          if (fmt(a.fields.get(k), 1) !== fmt(b.fields.get(k), 1)) changed.push(k);
        }
        if (a.status !== b.status) changed.push('status');
        if (a.content !== b.content) changed.push('content');
        record('ok', `${changed.length} field(s) differ`);
        return new PList(changed.map((c) => sym(c)));
      }
      case 'SUPERSEDE': {
        const older = this.resolveArtifact(raw[0], env);
        const newer = this.resolveArtifact(node.clauses.find((c) => c.prep === 'WITH')?.value, env);
        if (!older || !newer) {
          record('unresolved', 'artifact version not found');
          return this.rt.markUnresolved('SUPERSEDE: an artifact version named here does not exist', node);
        }
        this.rt.artifacts.transition(older, 'SUPERSEDED', `superseded by ${newer.id}@${newer.version}`);
        this.rt.provenance.derive(`${newer.id}@${newer.version}`, `${older.id}@${older.version}`, 'SUPERSEDE');
        record('ok', `${older.id}@${older.version} superseded`);
        return true;
      }
      case 'ARCHIVE': {
        const a = this.resolveArtifact(raw[0], env);
        if (!a) return this.rt.markUnresolved('ARCHIVE: no such artifact version', node);
        this.rt.artifacts.transition(a, 'ARCHIVED', 'archived');
        record('ok', `${a.id}@${a.version} archived`);
        return true;
      }
      case 'RESTORE': {
        const fromCheckpoint = clause('FROM');
        if (fromCheckpoint !== undefined) {
          const cp = this.rt.artifacts.checkpoints.get(String(fromCheckpoint));
          if (!cp) return this.rt.markUnresolved(`RESTORE: no checkpoint ${fromCheckpoint}`, node);
          record('ok', `restored from ${fromCheckpoint}`);
          return cp;
        }
        const a = this.resolveArtifact(raw[0], env);
        if (!a) return this.rt.markUnresolved('RESTORE: no such artifact version', node);
        this.rt.artifacts.transition(a, 'APPROVED', 'restored from archive');
        record('ok', `${a.id}@${a.version} restored`);
        return true;
      }
      case 'SERIALIZE': {
        const path = clause('TO');
        if (!this.rt.capabilities.require('filesystem.write', `SERIALIZE TO ${path}`, node)) {
          record('denied', 'capability filesystem.write is not granted');
          return this.rt.markUnresolved('SERIALIZE denied: filesystem.write not granted', node);
        }
        const y = this.rt.host.request('write', { path: String(path), value: fmt(operands[0], 1) });
        record('yield', `write ${path}`);
        return y;
      }
      case 'WRITE': {
        const path = clause('TO');
        if (!this.rt.capabilities.require('filesystem.write', `WRITE TO ${path}`, node)) {
          record('denied', 'capability filesystem.write is not granted');
          return this.rt.markUnresolved('WRITE denied: filesystem.write not granted', node);
        }
        record('yield', `write ${path}`);
        return this.rt.host.request('write', { path: String(path), value: fmt(operands[0], 1) });
      }
      case 'RESUME': {
        const cp = clause('FROM');
        record('ok', `resume from ${fmt(cp, 1)}`);
        return this.rt.artifacts.checkpoints.get(String(cp)) ?? this.rt.markUnresolved('RESUME: no such checkpoint', node);
      }
      case 'RETRIEVE': {
        if (!this.rt.capabilities.require('network.connect', 'RETRIEVE', node)
            && !this.rt.capabilities.allows('retrieval')) {
          record('yield', 'retrieval handed to the host');
        }
        record('yield', 'retrieval handed to the host');
        return this.rt.host.retrieve(fmt(operands[0] ?? null, 1));
      }
      case 'READ': {
        record('yield', 'read handed to the host');
        return this.rt.host.read(fmt(operands[0] ?? null, 1));
      }
      case 'VERIFY': return this.doVerify(operands, raw, node, env, record);
      case 'SIMULATE': {
        const s = new PRecord('Simulation', this.nameOf(raw[0]), new Map([
          ['status', sym('SIMULATED')], ['of', operands[0] ?? null],
        ]));
        record('ok', 'marked SIMULATED');
        return s;
      }
      case 'EXPERIMENT': {
        const plan = operands[0];
        const mode = plan instanceof PRecord ? plan.get('mode') : null;
        const isExperimental = mode instanceof PSymbol && mode.name === 'EXPERIMENTAL';
        if (!isExperimental) {
          record('fail', 'plan.mode is not EXPERIMENTAL');
          this.rt.diagnose('error', 'EVIDENCE_INSUFFICIENT',
            'EXPERIMENT refused: a simulation cannot become an experiment (I10)', node);
          return PResult.ERR('plan.mode != EXPERIMENTAL');
        }
        record('yield', 'experiment handed to the host: evidence is captured, never generated');
        return this.rt.host.request('experiment', { plan: fmt(plan, 1) });
      }
      case 'FALSIFY': {
        record('yield', 'falsification handed to the host');
        return this.rt.host.request('falsify', { claim: fmt(operands[0], 1) });
      }
      case 'EMIT': {
        const n = this.nameOf(raw[0]);
        const fired = this.rt.events.emit(n, operands[1] ?? null);
        record('ok', `emitted ${n} to ${fired} handler(s)`);
        return fired;
      }
      case 'SIGNAL': {
        const n = typeof operands[0] === 'string' ? operands[0] : this.nameOf(raw[0]);
        const fired = this.rt.events.signal(n, null);
        record('ok', `signalled ${n} to ${fired} handler(s)`);
        return fired;
      }
      case 'INVALIDATE': {
        const ids = operands[0] instanceof PList ? operands[0].items : [operands[0]];
        for (const id of ids) {
          const a = this.rt.artifacts.get(id instanceof PArtifact ? id.id : String(fmt(id, 1)));
          if (a && a.status === 'APPROVED') this.rt.artifacts.transition(a, 'REVIEW', 'invalidated upstream');
        }
        record('ok', `invalidated ${ids.length}`);
        return null;
      }
      case 'COMPARE': {
        const other = clause('WITH');
        const same = fmt(operands[0], 1) === fmt(other, 1);
        record(same ? 'ok' : 'fail', same ? 'equal' : 'not equal');
        return same;
      }
      case 'ASK': {
        record('yield', 'ASK yields: this interpreter has no provider');
        return this.rt.host.ask(operands[0] ?? null, operands[1] ?? null);
      }
      case 'GRANT': {
        // Capabilities are granted by the host, never by a program about itself.
        record('denied', 'a program cannot grant itself a capability');
        this.rt.diagnose('error', 'CAPABILITY_DENIED',
          'GRANT refused: capabilities come from the host, not from the program', node);
        return false;
      }
      default: break;
    }

    if (STAGE_VERBS.has(verb)) {
      // An operation inside a lifecycle stage. It must leave an artifact behind,
      // and the answer comes from outside, so it yields.
      const target = this.nameOf(raw[0]) || 'unnamed';
      const from = clause('FROM');
      record('yield', `${verb} ${target}`);
      return this.rt.host.request('operation', {
        verb, target, from: from === undefined ? null : fmt(from, 1), line: node.line,
      });
    }

    // Not a verb this runtime knows. It is recorded and marked, never guessed at.
    record('unrecognised', 'no execution rule for this verb');
    this.rt.diagnose('unresolved', 'UNRESOLVED',
      `operation ${verb} has no implementation; recorded, not performed`, node);
    this.rt.unresolvedCount += 1;
    return unresolved(`operation ${verb} is not implemented`, { line: node.line });
  }

  snapshotOf(v) {
    if (v instanceof PArtifact) return { ...v, fields: new Map(v.fields) };
    return v;
  }

  resolveArtifact(node, env) {
    if (!node) return null;
    if (node.kind === 'Versioned') {
      const id = this.nameOf(node.object);
      return this.rt.artifacts.at(id, node.version);
    }
    const v = this.evaluate(node, env);
    if (v instanceof PArtifact) return v;
    const id = this.nameOf(node);
    return this.rt.artifacts.get(id) || null;
  }

  doRun(value, rawNode, node, env, record) {
    const name = this.nameOf(rawNode);
    if (this.rt.programs.has(name)) { record('ok', `program ${name}`); return this.runProgram(name, env); }
    if (this.rt.tests.has(name)) { record('ok', `test ${name}`); return this.runTest(name); }
    if (this.rt.cyclers.has(name)) { record('ok', `cycler ${name}`); return this.runCycler(name, env); }
    if (value instanceof PFunction || value instanceof PNative) {
      record('ok', `function ${name}`);
      return this.callValue(value, []);
    }
    record('unresolved', `nothing named ${name} to run`);
    return this.rt.markUnresolved(`RUN ${name}: no program, test, cycler or function of that name`, node);
  }

  doSignoff(verb, operands, raw, node, env, record) {
    // REQUEST HUMAN_SIGNOFF x / REQUEST HUMAN SIGNOFF / SIGNOFF x BY HUMAN
    let subjectNode = raw[0];
    if (verb === 'REQUEST') subjectNode = raw[raw.length - 1];
    const id = this.nameOf(subjectNode);
    const artifact = this.rt.artifacts.get(id);
    const gateWord = `SIGNOFF ${id}`.trim();
    const answer = this.rt.host.gate('HumanSignoff', gateWord, id);
    if (answer instanceof PYield) {
      record('yield', `awaiting a person to type: ${gateWord}`);
      return answer;
    }
    if (String(answer) !== gateWord) {
      record('fail', 'the typed word did not match exactly');
      this.rt.diagnose('error', 'SIGNOFF_REQUIRED',
        `signoff refused: the gate needs the exact words "${gateWord}"`, node);
      return false;
    }
    if (artifact) {
      artifact.signoffs.push({ by: 'HUMAN', at: this.rt.now, word: gateWord });
      this.rt.artifacts.transition(artifact, 'APPROVED', 'human signoff');
    }
    record('ok', `${id} signed off`);
    return true;
  }

  doRelease(value, rawNode, version, node, env, record) {
    const id = this.nameOf(rawNode);
    const artifact = this.rt.artifacts.get(id);
    if (!artifact) {
      record('unresolved', `no artifact ${id}`);
      return this.rt.markUnresolved(`RELEASE ${id}: no such artifact`, node);
    }
    if (!artifact.signoffs.length) {
      record('fail', 'release without signoff');
      this.rt.diagnose('error', 'SIGNOFF_REQUIRED',
        `RELEASE ${id} refused: release requires human signoff (spec section XXX)`, node);
      return false;
    }
    if (version !== undefined) {
      const prev = artifact.version;
      const next = new PArtifact(id, {
        kind: artifact.kind, type: artifact.type, format: artifact.format,
        version: String(version), status: 'RELEASED', content: artifact.content,
        dependsOn: artifact.dependsOn, derivedFrom: `${id}@${prev}`,
        provenance: new Map(artifact.provenance), fields: new Map(artifact.fields),
      });
      next.signoffs = [...artifact.signoffs];
      this.rt.artifacts.put(next);
      this.rt.provenance.derive(`${id}@${version}`, `${id}@${prev}`, 'RELEASE');
      record('ok', `${id}@${version} released`);
      return next;
    }
    this.rt.artifacts.transition(artifact, 'RELEASED', 'released');
    record('ok', `${id} released`);
    return artifact;
  }

  doVerify(operands, raw, node, env, record) {
    const subject = operands[0];
    const against = node.clauses.find((c) => c.prep === 'AGAINST');
    const criterion = against ? this.evaluate(against.value, env) : null;
    if (criterion instanceof PFunction || criterion instanceof PNative) {
      const r = this.callValue(criterion, [subject]);
      record(truthy(r) ? 'ok' : 'fail', 'checked against a constraint');
      return PResult.OK(truthy(r));
    }
    const subjName = this.nameOf(raw[0]);
    const artifact = this.rt.artifacts.get(subjName);
    if (!artifact) {
      record('unresolved', `nothing named ${subjName} to verify`);
      return this.rt.markUnresolved(`VERIFY ${subjName}: no artifact of that name`, node);
    }
    if (!against) {
      record('unresolved', 'no criterion given');
      return this.rt.markUnresolved(`VERIFY ${subjName}: no criterion — a bare VERIFY decides nothing`, node);
    }
    const criterionName = this.nameOf(against.value);
    const criterionArtifact = this.rt.artifacts.get(criterionName);
    if (!criterionArtifact) {
      record('unresolved', `no artifact ${criterionName}`);
      return this.rt.markUnresolved(`VERIFY ... AGAINST ${criterionName}: no such artifact`, node);
    }
    // Verification against another artifact is evidence, and evidence is captured,
    // not generated. The host answers; the interpreter does not invent a verdict.
    record('yield', `verification of ${subjName} against ${criterionName}`);
    return this.rt.host.request('verify', { subject: subjName, criterion: criterionName });
  }

  // =========================================================================
  // Declarations
  // =========================================================================
  declare(node, env) {
    const kw = node.keyword;
    const handler = this[`decl_${kw}`];
    if (typeof handler === 'function') return handler.call(this, node, env);
    return this.declGeneric(node, env);
  }

  /** Evaluate a declaration body into properties, sections, members and children. */
  declBody(node, env, opts = {}) {
    const scope = env.child(`${node.keyword}:${node.name || ''}`);
    const props = new Map();
    const members = [];
    const sections = new Map();
    const children = [];
    const ops = [];
    let content = null;

    const addProp = (key, value) => {
      if (props.has(key)) {
        const prev = props.get(key);
        if (prev instanceof PList && prev.accumulated) prev.items.push(value);
        else {
          const l = new PList([prev, value]);
          l.accumulated = true;
          props.set(key, l);
        }
      } else props.set(key, value);
    };

    for (const s of node.body || []) {
      switch (s.kind) {
        case 'Operation': {
          if (s.marker) { members.push(s.verb); addProp(s.verb, true); ops.push(s); break; }
          const values = s.operands.map((o) => this.evaluate(o, scope));
          const value = values.length === 1 ? values[0] : new PList(values);
          addProp(s.verb, value);
          ops.push(s);
          break;
        }
        case 'Assign': {
          if (s.target.kind === 'Identifier') addProp(s.target.name, this.evaluate(s.value, scope));
          else this.execute(s, scope);
          break;
        }
        case 'Field': {
          members.push(s.name);
          props.set(s.name, null);
          (opts.fields || new Map()).set(s.name, s.type);
          if (opts.fieldTypes) opts.fieldTypes.set(s.name, s.type);
          break;
        }
        case 'Variant': {
          if (opts.variants) opts.variants.set(s.name, s.params);
          scope.define('__variants__', opts.variants || new Map());
          this.execute(s, scope);
          break;
        }
        case 'Section': {
          const sub = this.declBody({ keyword: s.upper, name: s.name, body: s.body }, scope, opts);
          sections.set(s.upper, sub);
          break;
        }
        case 'Declaration': children.push(s); break;
        case 'Content': content = s.text; break;
        case 'Production': {
          if (opts.grammar) opts.grammar.set(s.name, s.rhs);
          break;
        }
        case 'Signature': ops.push(s); break;
        case 'ExpressionStatement': ops.push(s); break;
        default: ops.push(s); break;
      }
    }
    return { props, members, sections, children, ops, content, scope };
  }

  // D11. The spec declares MODULE PANINI (line 20) and PACKAGE PANINI (line 1284)
  // under one name, then reads PANINI.CONSTITUTION (a module member) and
  // PANINI.VERSION (a package field) as if one namespace held both. Shadowing the
  // first with the second loses half the members, so a second declaration of a
  // name already bound to a record MERGES into it rather than replacing it. The
  // collision is reported, not hidden.
  bindDeclaration(env, name, rec, node) {
    if (!name) return rec;
    const prior = env.has(name) ? env.get(name) : undefined;
    if (prior instanceof PRecord && rec instanceof PRecord && prior !== rec) {
      for (const [k, v] of rec.fields) if (!prior.fields.has(k)) prior.fields.set(k, v);
      prior.kinds = [...new Set([...(prior.kinds || [prior.kind]), rec.kind])];
      if (rec.members) prior.members = [...new Set([...(prior.members || []), ...rec.members])];
      this.rt.diagnose('info', 'name-collision',
        `${rec.kind} ${name} merged into the existing ${prior.kind} ${name}`, node);
      return prior;
    }
    env.define(name, rec);
    return rec;
  }

  declGeneric(node, env) {
    const b = this.declBody(node, env);
    const rec = new PRecord(node.keyword, node.name, b.props);
    rec.members = b.members;
    rec.sections = b.sections;
    rec.ops = b.ops;
    rec.content = b.content;
    rec.node = node;
    for (const c of b.children) this.declare(c, b.scope);
    return this.bindDeclaration(env, node.name, rec, node);
  }

  decl_MODULE(node, env) {
    const scope = env.child(`module:${node.name}`);
    const rec = new PRecord('MODULE', node.name, new Map());
    scope.define('__module__', rec);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    // A dotted module name is also reachable through its head: PANINI.Language.
    if (node.name && node.name.includes('.')) {
      const [head, ...rest] = node.name.split('.');
      let holder = env.get(head);
      if (!(holder instanceof PRecord)) {
        holder = new PRecord('MODULE', head, new Map());
        env.define(head, holder);
      }
      let cur = holder;
      rest.forEach((part, i) => {
        if (i === rest.length - 1) cur.set(part, rec);
        else {
          let nxt = cur.get(part);
          if (!(nxt instanceof PRecord)) { nxt = new PRecord('MODULE', part, new Map()); cur.set(part, nxt); }
          cur = nxt;
        }
      });
    }
    for (const s of node.body || []) {
      // D13. A MODULE body parses as statements (D9), so a documentation property
      // such as `PURPOSE "..."` (spec line 984) arrives as an Operation with a
      // single literal operand. Every other declaration form reads that line as a
      // property, so a MODULE reads it as one too rather than hunting for a verb
      // named PURPOSE that the spec never defines.
      if (s.kind === 'Operation' && s.verb && /^[A-Z][A-Z0-9_]*$/.test(s.verb)
          && (s.operands || []).length === 1 && ['String', 'Number', 'List'].includes(s.operands[0].kind)
          && !this.hasVerb(s.verb)) {
        rec.set(s.verb, this.evaluate(s.operands[0], scope));
        this.rt.recordOperation({ verb: s.verb, line: s.line, status: 'property' });
        continue;
      }
      const v = this.execute(s, scope);
      if (s.kind === 'Declaration' && s.name) rec.set(s.name, scope.get(s.name) ?? v);
      // D12. An unnamed declaration is reachable by its keyword: the spec reads
      // PANINI.CONSTITUTION, and CONSTITUTION (line 22) has a body but no name.
      if (s.kind === 'Declaration' && !s.name && s.keyword) rec.set(s.keyword, v);
      if (s.kind === 'Invariant' && s.name) rec.set(s.name, v);
    }
    for (const [k, v] of scope.vars) if (!k.startsWith('__')) rec.set(k, v);
    return rec;
  }

  decl_PACKAGE(node, env) { return this.declGeneric(node, env); }

  decl_FUNCTION(node, env) {
    const fn = new PFunction(node.name, node.params || [], node.body, env, {
      returnType: node.returnType,
      abstract: !node.block || (node.body || []).length === 0,
      declaredIn: env.label,
    });
    if (node.name) env.define(node.name, fn);
    return fn;
  }

  decl_PROCEDURE(node, env) { return this.decl_FUNCTION(node, env); }
  decl_METHOD(node, env) { return this.decl_FUNCTION(node, env); }

  decl_CLASS(node, env) {
    const fields = new Map();
    const methods = new Map();
    const scope = env.child(`class:${node.name}`);
    for (const s of node.body || []) {
      if (s.kind === 'Declaration' && s.keyword === 'FIELD') fields.set(s.name, s.declaredType || null);
      else if (s.kind === 'Declaration' && s.keyword === 'METHOD') methods.set(s.name, this.decl_FUNCTION(s, scope));
      else if (s.kind === 'Field') fields.set(s.name, s.type);
    }
    const cls = new PClass(node.name, fields, methods);
    if (node.name) env.define(node.name, cls);
    // A class is also its own constructor.
    env.define(`new_${node.name}`, new PNative(`new_${node.name}`, 0, () => this.instantiate(cls)));
    return cls;
  }

  instantiate(cls) {
    const inst = new PInstance(cls);
    for (const [name, type] of cls.fields) {
      const t = type && type.name;
      if (t === 'Map') inst.fields.set(name, new PMap());
      else if (t === 'List' || t === 'Set') inst.fields.set(name, new PList());
      else inst.fields.set(name, null);
    }
    return inst;
  }

  decl_TRAIT(node, env) { return this.declContract(node, env, 'TRAIT'); }
  decl_INTERFACE(node, env) { return this.declContract(node, env, 'INTERFACE'); }

  declContract(node, env, kind) {
    const rec = new PRecord(kind, node.name, new Map());
    const sigs = new Map();
    for (const s of node.body || []) {
      if (s.kind === 'Declaration' && s.keyword === 'FUNCTION') {
        sigs.set(s.name, { params: s.params || [], returnType: s.returnType });
      }
    }
    rec.set('signatures', new PList([...sigs.keys()].map((k) => sym(k))));
    rec.signatures = sigs;
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_TYPE(node, env) {
    const variants = new Map();
    const fields = new Map();
    const b = node.block ? this.declBody(node, env, { variants, fields, fieldTypes: fields }) : null;
    // A TYPE body may also be bare member names, as in TYPE Varzish.
    if (b) for (const m of b.members) if (!fields.has(m)) fields.set(m, null);
    const existing = this.rt.types.get(node.name);
    if (existing && !node.block && !node.alias) {
      // The spec declares Sovereign and Estate twice. That is reported, not fatal.
      this.rt.diagnose('info', 'duplicate-type',
        `TYPE ${node.name} is declared more than once (first at line ${existing.line})`, node);
      return existing.type;
    }
    const t = new PType(node.name, {
      generics: (node.generics || []).map((g) => g.name),
      variants: variants.size ? variants : null,
      fields: fields.size ? fields : null,
      alias: node.alias,
      where: node.where,
      declared: node.params ? { params: node.params, returnType: node.returnType } : null,
    });
    this.rt.types.set(node.name, { type: t, line: node.line });
    if (node.name) env.define(node.name, t);
    return t;
  }

  decl_SCHEMA(node, env) {
    const fields = new Map();
    this.declBody(node, env, { fields, fieldTypes: fields });
    const rec = new PRecord('SCHEMA', node.name, new Map());
    rec.set('fields', new PList([...fields.keys()].map((k) => sym(k))));
    rec.fieldTypes = fields;
    this.rt.schemas.set(node.name, rec);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_CONSTRAINT(node, env) {
    const fn = new PFunction(node.name, node.params || [], node.body, env, { returnType: null });
    fn.isConstraint = true;
    if (node.name) env.define(node.name, fn);
    return fn;
  }

  decl_ENUM(node, env) {
    const members = [];
    for (const s of node.body || []) {
      if (s.kind === 'Operation' && s.marker) members.push(s.verb);
      else if (s.kind === 'Operation') members.push(s.verb);
    }
    const rec = new PRecord('ENUM', node.name, new Map());
    for (const m of members) {
      rec.set(m, sym(m));
      if (!env.has(m)) env.define(m, sym(m));
    }
    rec.set('__members__', new PList(members.map((m) => sym(m))));
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_CONFIGURATION(node, env) {
    const b = this.declBody(node, env);
    const rec = new PRecord('CONFIGURATION', node.name, b.props);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_FILE(node, env) {
    const b = this.declBody(node, env);
    const mime = b.props.get('MIME');
    const a = new PArtifact(node.name, {
      kind: 'FILE',
      format: mime === undefined ? null : String(mime),
      encoding: b.props.has('ENCODING') ? String(b.props.get('ENCODING')) : null,
      content: b.content,
      fields: b.props,
      version: b.props.has('VERSION') ? String(b.props.get('VERSION')) : '0.0.0',
    });
    if (mime === undefined) {
      // I7: a FILE block has semantic MIME. Missing MIME is a defect, reported.
      this.rt.diagnose('warning', 'missing-mime', `FILE "${node.name}" declares no MIME`, node);
    }
    if (b.props.has('GENERATE_FROM') && b.content === null) {
      a.content = this.rt.markUnresolved(
        `FILE "${node.name}" is GENERATE_FROM ${fmt(b.props.get('GENERATE_FROM'), 1)}, which is not built`, node,
      );
    }
    this.rt.artifacts.put(a);
    env.define(node.name, a);
    return a;
  }

  decl_ARTIFACT(node, env) { return this.artifactDecl(node, env, 'ARTIFACT'); }
  decl_DELIVERABLE(node, env) { return this.artifactDecl(node, env, 'DELIVERABLE'); }

  artifactDecl(node, env, kind) {
    const b = this.declBody(node, env);
    const prov = new Map();
    const provSection = b.sections.get('PROVENANCE');
    if (provSection) for (const [k, v] of provSection.props) prov.set(k, v);
    const statusRaw = b.props.get('STATUS');
    const status = statusRaw instanceof PSymbol ? statusRaw.name : (statusRaw ? String(statusRaw) : 'DRAFT');
    const dep = b.props.get('DEPENDS_ON');
    const dependsOn = dep === undefined ? []
      : (dep instanceof PList ? dep.items : [dep]).map((d) => (d instanceof PArtifact ? d.id : String(fmt(d, 1))));
    const a = new PArtifact(node.name, {
      kind,
      type: b.props.has('TYPE') ? String(fmt(b.props.get('TYPE'), 1)).replace(/^"|"$/g, '') : null,
      format: b.props.has('FORMAT') ? String(b.props.get('FORMAT')) : null,
      version: b.props.has('VERSION') ? String(b.props.get('VERSION')) : '0.0.0',
      status,
      dependsOn,
      provenance: prov,
      fields: b.props,
    });
    this.rt.artifacts.put(a);
    for (const d of dependsOn) this.rt.provenance.derive(a.id, d, 'DEPENDS_ON');
    if (!prov.size && kind === 'DELIVERABLE') {
      this.rt.diagnose('info', 'no-provenance', `${kind} ${node.name} records no provenance block`, node);
    }
    env.define(node.name, a);
    return a;
  }

  decl_ARTIFACT_REVISION(node, env) {
    const b = this.declBody(node, env);
    const fromNode = (node.body || []).find((s) => s.kind === 'Operation' && s.verbUpper === 'FROM');
    const baseName = fromNode ? this.nameOf(fromNode.operands[0]) : node.name;
    const base = this.rt.artifacts.get(baseName);
    if (!base) {
      return this.rt.markUnresolved(`ARTIFACT_REVISION ${node.name}: no artifact ${baseName} to revise`, node);
    }
    const preserve = b.props.get('PRESERVE_PROVENANCE');
    const bump = (v) => {
      const parts = String(v).split('.').map(Number);
      if (parts.some(Number.isNaN)) return `${v}+1`;
      parts[parts.length - 1] += 1;
      return parts.join('.');
    };
    const next = new PArtifact(base.id, {
      kind: base.kind, type: base.type, format: base.format,
      version: bump(base.version), status: 'DRAFT', content: base.content,
      dependsOn: base.dependsOn, derivedFrom: `${base.id}@${base.version}`,
      provenance: truthy(preserve) ? new Map(base.provenance) : new Map(),
      fields: new Map(base.fields),
    });
    next.fields.set('CHANGE', b.props.get('CHANGE') ?? null);
    this.rt.artifacts.put(next);
    this.rt.provenance.derive(`${next.id}@${next.version}`, `${base.id}@${base.version}`, 'REVISION');
    if (!truthy(preserve)) {
      this.rt.diagnose('warning', 'provenance-dropped',
        `ARTIFACT_REVISION ${node.name} sets PRESERVE_PROVENANCE false; ancestry is still recorded (I8)`, node);
    }
    env.define(node.name, next);
    return next;
  }

  decl_CLAIM(node, env) {
    const b = this.declBody(node, env);
    const st = b.props.get('STATUS');
    const status = st instanceof PSymbol ? st.name : (st ? String(st) : null);
    if (status && !EPISTEMIC.includes(status)) {
      this.rt.diagnose('error', 'PROVENANCE_ERROR',
        `CLAIM ${node.name}: ${status} is not an EpistemicStatus`, node);
    }
    // D24. RULE CANONICAL_OUTPUT (spec line 674) requires every statement to
    // carry provenance. The spec's own CLAIM form (line 668) supplies it as
    // SOURCE, but PROVENANCE is what the rule names, so both are read and both
    // establish it. Reading only SOURCE makes a claim tagged PROVENANCE fail
    // canonicalization for a reason the author never wrote.
    const prov = {};
    if (b.props.has('SOURCE')) prov.source = String(fmt(b.props.get('SOURCE'), 1)).replace(/^"|"$/g, '');
    if (b.props.has('PROVENANCE')) prov.provenance = String(fmt(b.props.get('PROVENANCE'), 1)).replace(/^"|"$/g, '');
    if (b.props.has('DERIVED_FROM')) prov.derivedFrom = String(fmt(b.props.get('DERIVED_FROM'), 1)).replace(/^"|"$/g, '');
    const c = new PClaim(node.name, {
      status,
      source: prov.source ?? null,
      evidence: b.props.get('EVIDENCE') ?? null,
      provenance: Object.keys(prov).length ? prov : null,
    });
    this.rt.claims.set(node.name, c);
    env.define(node.name, c);
    return c;
  }

  canonicalize(claim) {
    if (!(claim instanceof PClaim)) return PResult.ERR('not a claim');
    if (!claim.status) return PResult.ERR('untagged claim');
    if (!claim.provenance) return PResult.ERR('missing provenance');
    return PResult.OK(claim);
  }

  decl_RULE(node, env) {
    // A RULE is an obligation on other things. It is recorded with its clauses
    // and checked when applied — not evaluated at declaration, where its subjects
    // do not yet exist.
    const rec = new PRecord('RULE', node.name, new Map());
    const clauses = (node.body || []).filter((s) => s.kind === 'Obligation');
    rec.set('clauses', new PList(clauses.map((c) => c.source)));
    rec.obligations = clauses;
    this.rt.rules.set(node.name, rec);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_MEASUREMENT(node, env) {
    const b = this.declBody(node, env);
    const m = new PMeasurement(
      node.name, b.props.get('VALUE') ?? null, b.props.has('UNIT') ? String(b.props.get('UNIT')) : null,
      b.props.get('UNCERTAINTY') ?? null, b.props.has('SOURCE') ? String(b.props.get('SOURCE')) : null,
    );
    if (m.source === null) {
      this.rt.diagnose('warning', 'no-source', `MEASUREMENT ${node.name} names no source`, node);
    }
    env.define(node.name, m);
    return m;
  }

  decl_EVENT(node, env) {
    this.rt.events.declareEvent(node.name, node.params || []);
    const rec = new PRecord('EVENT', node.name, new Map([['params', new PList((node.params || []).map((p) => sym(p.name)))]]));
    this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_SIGNAL(node, env) {
    this.rt.events.declareSignal(node.name);
    const s = sym(node.name);
    env.define(node.name, s);
    return s;
  }

  decl_ACTOR(node, env) {
    const handlers = new Map();
    const mailbox = [];
    const scope = env.child(`actor:${node.name}`);
    for (const s of node.body || []) {
      if (s.kind === 'Reactive' && s.mode === 'ON') {
        const event = s.subject && s.subject.kind === 'Call'
          ? this.nameOf(s.subject.callee) : this.nameOf(s.subject);
        const param = s.subject && s.subject.kind === 'Call' && s.subject.args[0]
          ? this.nameOf(s.subject.args[0]) : null;
        handlers.set(event, (payload) => {
          const inner = scope.child('handler');
          if (param) inner.define(param, payload);
          this.block(s.body, inner);
        });
      }
    }
    const actor = { name: node.name, handlers, mailbox };
    this.rt.events.actors.set(node.name, actor);
    const rec = new PRecord('ACTOR', node.name, new Map([['handles', new PList([...handlers.keys()].map((k) => sym(k)))]]));
    this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_CYCLER(node, env) { return this.cyclerDecl(node, env, 'CYCLER'); }
  decl_META_CYCLER(node, env) { return this.cyclerDecl(node, env, 'META_CYCLER'); }
  decl_CYCLE(node, env) { return this.cyclerDecl(node, env, 'CYCLE'); }

  cyclerDecl(node, env, kind) {
    const b = this.declBody(node, env);
    const stages = [];
    for (const c of b.children) {
      if (c.keyword === 'STAGE') {
        stages.push({ name: String(c.name), ops: (c.body || []).filter((s) => s.kind === 'Operation' || s.kind === 'Obligation'), node: c });
      } else this.declare(c, b.scope);
    }
    // A CYCLE lists its phases as bare markers rather than STAGE blocks.
    if (!stages.length && b.members.length) {
      for (const m of b.members) stages.push({ name: m, ops: [], node: null });
    }
    const rec = new PRecord(kind, node.name, b.props);
    rec.set('stages', new PList(stages.map((s) => sym(s.name))));
    rec.stages = stages;
    rec.sections = b.sections;
    rec.members = b.members;
    rec.node = node;
    this.rt.cyclers.set(node.name, rec);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  runCycler(name, env) {
    const cycler = this.rt.cyclers.get(name);
    if (!cycler) return this.rt.markUnresolved(`no cycler ${name}`, null);
    const trace = [];
    for (const stage of cycler.stages) {
      const stageRecord = { stage: stage.name, operations: [], halted: false };
      for (const op of stage.ops) {
        const before = this.rt.host.pending.length;
        const result = this.execute(op, env.child(`stage:${stage.name}`));
        stageRecord.operations.push({
          source: op.source, result: result instanceof PYield ? 'YIELD'
            : (isUnresolved(result) ? 'UNRESOLVED' : 'OK'),
        });
        if (this.rt.host.pending.length > before) {
          // The stage waits for the host. It does not proceed on a guess.
          stageRecord.halted = true;
          trace.push(stageRecord);
          return new PRecord('CyclerRun', name, new Map([
            ['completed', new PList(trace.map((t) => sym(t.stage)))],
            ['halted_at', sym(stage.name)],
            ['awaiting', this.rt.host.pending.length],
          ]));
        }
      }
      trace.push(stageRecord);
    }
    return new PRecord('CyclerRun', name, new Map([
      ['completed', new PList(trace.map((t) => sym(t.stage)))],
      ['halted_at', null],
    ]));
  }

  decl_STAGE(node, env) { return this.declGeneric(node, env); }

  decl_GATE(node, env) {
    const b = this.declBody(node, env);
    const rec = new PRecord('GATE', node.name, b.props);
    const type = b.props.get('TYPE');
    rec.set('crossed_by', type instanceof PSymbol ? type : sym('HUMAN'));
    this.rt.gates.set(node.name, rec);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_AGENT(node, env) {
    const b = this.declBody(node, env);
    const rec = new PRecord('AGENT', node.name, b.props);
    const caps = b.props.get('CAPABILITIES');
    const list = caps instanceof PList ? caps.items.map((c) => String(fmt(c, 1))) : [];
    rec.set('granted', new PList(list.filter((c) => this.rt.capabilities.allows(c)).map((c) => sym(c))));
    rec.set('requested', new PList(list.map((c) => sym(c))));
    // An agent asks for capabilities; it does not receive them by asking.
    for (const c of list) {
      if (!this.rt.capabilities.allows(c)) {
        this.rt.diagnose('info', 'capability-not-granted',
          `AGENT ${node.name} requests ${c}, which is not granted (DEFAULT_DENY)`, node);
      }
    }
    this.rt.agents.set(node.name, rec);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_MODEL(node, env) {
    const b = this.declBody(node, env);
    // A MODEL is a descriptor. It holds no client, no endpoint and no key.
    const rec = new PRecord('MODEL', node.name, b.props);
    rec.set('invocable', false);
    rec.set('reached_by', sym('HOST'));
    this.rt.models.set(node.name, rec);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_PROMPT(node, env) {
    const b = this.declBody(node, env);
    const rec = new PRecord('PROMPT', node.name, b.props);
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_STATE(node, env) { return this.declGeneric(node, env); }
  decl_RUNTIME(node, env) { return this.declGeneric(node, env); }
  decl_ESTATE(node, env) { return this.declGeneric(node, env); }
  decl_DOCUMENT(node, env) { return this.declGeneric(node, env); }
  decl_TASK(node, env) { return this.declGeneric(node, env); }
  decl_SCHEDULE(node, env) { return this.declGeneric(node, env); }
  decl_RESOURCE(node, env) {
    const rec = new PRecord('RESOURCE', node.name, new Map());
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_CAPABILITY(node, env) {
    this.rt.capabilities.declare(node.name);
    const rec = new PRecord('CAPABILITY', node.name, new Map([
      ['granted', this.rt.capabilities.allows(node.name)],
    ]));
    return rec;
  }

  decl_POLICY(node, env) {
    this.rt.capabilities.policies.add(node.name);
    const rec = new PRecord('POLICY', node.name, new Map());
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_CONSTITUTION(node, env) {
    const b = this.declBody(node, env);
    const rec = new PRecord('CONSTITUTION', node.name, b.props);
    const principles = b.sections.get('PRINCIPLES');
    if (principles) for (const p of principles.members) this.rt.principles.add(p);
    rec.set('principles', new PList([...this.rt.principles].map((p) => sym(p))));
    this.rt.constitution = rec;
    env.define('CONSTITUTION', rec);
    return rec;
  }

  decl_SYNTAX(node, env) {
    const grammar = new Map();
    this.declBody(node, env, { grammar });
    for (const s of node.body || []) if (s.kind === 'Production') grammar.set(s.name, s.rhs);
    const rec = new PRecord('SYNTAX', node.name, new Map());
    for (const [k, v] of grammar) rec.set(k, v);
    env.define('SYNTAX', rec);
    return rec;
  }

  decl_BOOTSTRAP(node, env) {
    const b = this.declBody(node, env);
    const rec = new PRecord('BOOTSTRAP', node.name, new Map());
    const stages = [];
    for (const c of b.children) {
      if (c.keyword !== 'STAGE') continue;
      const ops = (c.body || []).filter((s) => s.kind === 'Operation');
      const built = ops.length > 0 && ops.every((o) => !UNBUILT.has(o.verbUpper));
      stages.push({ stage: String(c.name), operations: ops.map((o) => o.source), built });
    }
    // Stage 0 is this JavaScript bootstrap. It exists. Nothing above it does yet.
    rec.set('stages', new PList(stages.map((s) => new PMap(new Map([
      ['stage', s.stage],
      ['status', s.stage === '0' ? 'BUILT' : 'UNRESOLVED'],
      ['reason', s.stage === '0'
        ? 'the JavaScript bootstrap in src/ is stage 0'
        : 'requires a PANINI compiler, which is not implemented'],
    ])))));
    rec.set('self_hosting', false);
    this.bindDeclaration(env, node.name || 'BOOTSTRAP', rec, node);
    this.rt.diagnose('info', 'bootstrap',
      `BOOTSTRAP ${node.name}: stage 0 built, stages 1-${stages.length - 1} UNRESOLVED`, node);
    return rec;
  }

  decl_PROGRAM(node, env) {
    this.rt.programs.set(node.name, { node, env });
    const rec = new PRecord('PROGRAM', node.name, new Map([
      ['statements', (node.body || []).length],
    ]));
    this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  runProgram(name, env) {
    const p = this.rt.programs.get(name);
    if (!p) return this.rt.markUnresolved(`no program ${name}`, null);
    const scope = (p.env || env).child(`program:${name}`);
    this.block(p.node.body || [], scope);
    return new PRecord('ProgramRun', name, new Map([['unresolved', this.rt.unresolvedCount]]));
  }

  decl_TEST(node, env) {
    this.rt.tests.set(node.name, { node, env });
    const rec = new PRecord('TEST', node.name, new Map());
    this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_PROPERTY(node, env) {
    this.rt.tests.set(node.name, { node, env, property: true });
    const rec = new PRecord('PROPERTY', node.name, new Map());
    this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  /**
   * Run a TEST. When the test supplies INPUT, the input is put through this
   * implementation's own pipeline and the results are bound as token_count,
   * parse.success and typecheck.success, which is what the spec's own tests read.
   */
  runTest(name) {
    const entry = this.rt.tests.get(name);
    if (!entry) return { name, result: 'MISSING' };
    const { node, env } = entry;
    const scope = env.child(`test:${name}`);
    const body = node.body || [];
    const inputOp = body.find((s) => s.kind === 'Operation' && s.verbUpper === 'INPUT');
    if (inputOp) {
      const source = String(this.evaluate(inputOp.operands[0], scope));
      const lexRes = this.callValue(this.global.get('lex'), [source]);
      const parseRes = this.callValue(this.global.get('parse'), [source]);
      const typeRes = this.callValue(this.global.get('typecheck'), [source]);
      scope.define('token_count', lexRes.items.length);
      scope.define('tokens', lexRes);
      scope.define('parse', parseRes);
      scope.define('typecheck', typeRes);
      scope.define('source', source);
    }
    const results = [];
    const firstDiag = this.rt.diagnostics.length;
    for (const s of body) {
      if (s.kind === 'Operation' && s.verbUpper === 'INPUT') continue;
      if (s.kind === 'Operation' && s.verbUpper === 'EXPECT') {
        const v = this.evaluate(s.operands[0], scope);
        results.push({ expect: s.source, pass: truthy(v), value: fmt(v, 1) });
        continue;
      }
      try {
        const before = this.rt.diagnostics.length;
        this.execute(s, scope);
        const added = this.rt.diagnostics.slice(before).filter((d) => d.severity === 'error');
        if (s.kind === 'Obligation') {
          results.push({ expect: s.source, pass: added.length === 0 });
        }
      } catch (err) {
        results.push({ expect: s.source || s.kind, pass: false, error: String(err.message) });
      }
    }
    const pass = results.length > 0 && results.every((r) => r.pass);
    // A test that asserted nothing is not a passing test. It reports EMPTY and
    // carries the reason it asserted nothing, so the gap is visible.
    const why = this.rt.diagnostics.slice(firstDiag)
      .filter((d) => d.severity === 'unresolved').map((d) => d.message);
    return {
      name,
      result: pass ? 'PASS' : (results.length ? 'FAIL' : 'EMPTY'),
      assertions: results,
      ...(results.length ? {} : { reason: why[0] || 'the body produced no assertion' }),
    };
  }

  evalInvariant(node, env) {
    const name = node.name;
    // The subject of an invariant is bound to what this runtime actually reports.
    const scope = env.child('invariant');
    for (const [k, [v]] of this.rt.invariants) scope.define(k, v);
    const value = node.test ? this.evaluate(node.test, scope) : null;
    const entry = this.rt.invariants.get(this.subjectOf(node));
    const holds = truthy(value);
    this.rt.recordOperation({
      verb: 'INVARIANT', name, status: holds ? 'HOLDS' : 'DOES_NOT_HOLD',
      evidence: entry ? entry[1] : null, line: node.line, source: node.source,
    });
    if (!holds) {
      this.rt.diagnose('warning', 'invariant',
        `${name} does not hold: ${node.source}${entry ? ` — ${entry[1]}` : ''}`, node);
    }
    env.define(name, holds);
    return holds;
  }

  subjectOf(node) {
    let t = node.test;
    while (t && t.kind === 'Binary') t = t.left;
    return t && t.kind === 'Identifier' ? t.name : '';
  }

  evalSection(node, env) {
    // A bare section at statement level (RECOVERY, GIVEN, ...) records its members.
    const b = this.declBody({ keyword: node.upper, name: node.name, body: node.body }, env);
    const rec = new PRecord('SECTION', node.name, b.props);
    rec.members = b.members;
    this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  decl_THEOREM(node, env) {
    const scope = env.child(`theorem:${node.name}`);
    for (const [k, [v]] of this.rt.selfReport) scope.define(k, v);
    const sections = new Map();
    for (const s of node.body || []) {
      if (s.kind === 'Section') sections.set(s.upper, s.body);
    }
    const results = [];
    for (const s of sections.get('REQUIRE') || []) {
      const src = s.source || '';
      const value = s.kind === 'Operation' || s.kind === 'ExpressionStatement'
        ? this.evaluateStatementAsExpression(s, scope)
        : this.execute(s, scope);
      results.push({ requirement: src || this.describe(s), holds: truthy(value) });
    }
    const allHold = results.length > 0 && results.every((r) => r.holds);
    const rec = new PRecord('THEOREM', node.name, new Map([
      ['requirements', new PList(results.map((r) => `${r.holds ? 'HOLDS' : 'DOES NOT HOLD'}: ${r.requirement}`))],
      ['conclusion', allHold],
    ]));
    rec.results = results;
    if (!allHold) {
      this.rt.diagnose('warning', 'theorem',
        `THEOREM ${node.name}: ${results.filter((r) => !r.holds).length} of ${results.length} requirements do not hold in this implementation`, node);
    }
    if (node.name) this.bindDeclaration(env, node.name, rec, node);
    return rec;
  }

  describe(s) {
    if (s.source) return s.source;
    if (s.kind === 'Operation') return `${s.verb} ...`;
    return s.kind;
  }

  evaluateStatementAsExpression(s, env) {
    if (s.kind === 'ExpressionStatement') return this.evaluate(s.expression, env);
    if (s.kind === 'Operation' && s.operands.length === 1) {
      // `PANINI_COMPILER CAN_PARSE PANINI` arrives as a binary expression already.
      return this.evaluate(s.operands[0], env);
    }
    if (s.kind === 'Operation') return this.evaluate({ kind: 'Identifier', name: s.verb, line: s.line }, env);
    return this.execute(s, env);
  }

  // =========================================================================
  // Expressions
  // =========================================================================
  evaluate(node, env) {
    switch (node.kind) {
      case 'Number': return node.value;
      case 'String': return node.value;
      case 'Boolean': return node.value;
      case 'Null': return null;
      case 'Now': return this.rt.now;
      case 'Wildcard': return sym('_');
      case 'UnresolvedExpr':
        return this.rt.markUnresolved('an ellipsis in expression position', node);
      case 'FileRef': {
        const a = this.rt.artifacts.get(node.path);
        return a || this.rt.markUnresolved(`FILE "${node.path}" is not declared in this program`, node);
      }
      case 'Identifier': {
        if (env.has(node.name)) return env.get(node.name);
        const upper = node.upper;
        if (upper === 'TRUE') return true;
        if (upper === 'FALSE') return false;
        if (upper === 'NULL') return null;
        // An unbound name is a self-denoting symbol, and that is reported so a
        // typo is visible rather than silently becoming a value.
        this.rt.diagnose('info', 'unbound', `${node.name} is not bound; read as a symbol`, node);
        return sym(node.name);
      }
      case 'Member': {
        const obj = this.evaluate(node.object, env);
        return this.member(obj, node.property, node);
      }
      case 'Index': {
        const obj = this.evaluate(node.object, env);
        const idx = this.evaluate(node.index, env);
        if (obj instanceof PList) return obj.items[Number(idx)] ?? null;
        if (obj instanceof PMap) {
          const key = String(fmt(idx, 1)).replace(/^"|"$/g, '');
          return obj.entries.has(key) ? obj.entries.get(key) : POption.NONE();
        }
        if (obj instanceof PInstance) {
          const key = String(fmt(idx, 1)).replace(/^"|"$/g, '');
          const v = obj.fields.get(key);
          return v === undefined ? POption.NONE() : v;
        }
        if (typeof obj === 'string') return obj[Number(idx)] ?? null;
        if (isUnresolved(obj)) return obj;
        return this.rt.markUnresolved(`cannot index ${typeName(obj)}`, node);
      }
      case 'Versioned': {
        const id = this.nameOf(node.object);
        const a = this.rt.artifacts.at(id, node.version);
        return a || this.rt.markUnresolved(`${id}@${node.version} does not exist`, node);
      }
      case 'ListLiteral': return new PList(node.elements.map((e) => this.evaluate(e, env)));
      case 'MapLiteral': {
        const m = new Map();
        for (const e of node.entries) m.set(String(this.evaluate(e.key, env)), this.evaluate(e.value, env));
        return new PMap(m);
      }
      case 'Range': {
        const a = Number(this.evaluate(node.start, env));
        const b = Number(this.evaluate(node.end, env));
        return new PRange(a, b);
      }
      case 'Lambda':
        return new PFunction(node.name, node.params, node.body, env, { returnType: node.returnType });
      case 'Annotation':
        return new PRecord('ANNOTATION', node.name, new Map([
          ['args', new PList(node.args.map((a) => this.evaluate(a, env)))],
        ]));
      case 'Call': return this.call(node, env);
      case 'Unary': {
        const v = this.evaluate(node.argument, env);
        if (node.operator === 'NOT') return !truthy(v);
        if (isUnresolved(v)) return v;
        return -Number(v);
      }
      case 'Postfix': {
        const v = this.evaluate(node.argument, env);
        if (node.operator === 'EXISTS') {
          return v !== null && v !== undefined && !isUnresolved(v) && !(v instanceof PSymbol && !env.has(v.name));
        }
        return v;
      }
      case 'Quantifier': {
        const v = this.evaluate(node.argument, env);
        const items = v instanceof PList ? v.items : [v];
        switch (node.quantifier) {
          case 'ALL': case 'EVERY': return items.every(truthy);
          case 'ANY': return items.some(truthy);
          case 'NONE': return !items.some(truthy);
          default: return truthy(v);
        }
      }
      case 'Binary': return this.binary(node, env);
      case 'OperationExpr': {
        // An operation used as a value: `source = READ FILE "x.pni"`.
        return this.operation({
          kind: 'Operation', verb: node.verb, verbUpper: node.verbUpper,
          operands: node.operands, clauses: node.clauses, line: node.line,
          source: node.source || `${node.verb} ...`,
        }, env);
      }
      case 'Spread': return node.argument ? this.evaluate(node.argument, env) : sym('...');
      default:
        this.rt.diagnose('warning', 'unhandled-expr', `no evaluation rule for ${node.kind}`, node);
        return null;
    }
  }

  member(obj, property, node) {
    if (obj === null || obj === undefined) {
      return this.rt.markUnresolved(`cannot read ${property} of NULL`, node);
    }
    if (isUnresolved(obj)) return obj;
    if (obj instanceof PRecord) {
      if (obj.fields.has(property)) return obj.fields.get(property);
      const upper = property.toUpperCase();
      if (obj.fields.has(upper)) return obj.fields.get(upper);
      if (obj.members && obj.members.includes(property)) return true;
      return this.rt.markUnresolved(`${obj.kind} ${obj.name || ''} has no ${property}`, node);
    }
    if (obj instanceof PInstance) {
      if (obj.fields.has(property)) return obj.fields.get(property);
      const m = obj.cls.methods.get(property);
      if (m) { const bound = Object.create(m); bound.self = obj; return bound; }
      return this.rt.markUnresolved(`${obj.cls.name} has no ${property}`, node);
    }
    if (obj instanceof PArtifact) {
      const map = {
        id: obj.id, status: sym(obj.status), version: obj.version, format: obj.format,
        type: obj.type, content: obj.content, kind: sym(obj.kind),
        derivedFrom: obj.derivedFrom,
        // Dependencies are stored as a JS array; reading them from PANINI must
        // give a PANINI list, not a bare host array.
        dependsOn: new PList((obj.dependsOn || []).map((d) => sym(String(d)))),
        signoffs: new PList((obj.signoffs || []).map((x) => sym(String(x.by || x)))),
      };
      if (property in map) return map[property];
      if (obj.fields.has(property)) return obj.fields.get(property);
      const upper = property.toUpperCase();
      if (obj.fields.has(upper)) return obj.fields.get(upper);
      if (property === 'ITERATIONS') return obj.history.length;
      if (property === 'changed') return obj.history.length > 0;
      return this.rt.markUnresolved(`artifact ${obj.id} has no ${property}`, node);
    }
    if (obj instanceof PClaim) {
      if (property === 'status') return obj.status ? sym(obj.status) : null;
      if (property === 'provenance') return obj.provenance ? new PMap(new Map(Object.entries(obj.provenance))) : null;
      if (property === 'source') return obj.source;
      if (property === 'evidence') return obj.evidence;
    }
    if (obj instanceof PMap) {
      return obj.entries.has(property) ? obj.entries.get(property) : this.rt.markUnresolved(`no key ${property}`, node);
    }
    if (obj instanceof PList) {
      if (property === 'length') return obj.items.length;
      // A field read on a list plucks that field from each member.
      return new PList(obj.items.map((x) => this.member(x, property, node)));
    }
    if (obj instanceof PClass) {
      const m = obj.methods.get(property);
      if (m) return m;
    }
    if (obj instanceof PSymbol) {
      // A symbol has no structure; asking for a field of one is unresolved,
      // never a fabricated value.
      return this.rt.markUnresolved(`${obj.name}.${property} is not established`, node);
    }
    if (typeof obj === 'string' && property === 'length') return obj.length;
    return this.rt.markUnresolved(`cannot read ${property} of ${typeName(obj)}`, node);
  }

  call(node, env) {
    const callee = this.evaluate(node.callee, env);
    const args = [];
    for (const a of node.args) {
      if (a.kind === 'Spread' && a.argument) {
        const v = this.evaluate(a.argument, env);
        if (v instanceof PList) args.push(...v.items);
        else args.push(v);
      } else if (a.kind === 'Spread') continue;
      else args.push(this.evaluate(a, env));
    }
    if (isUnresolved(callee)) return callee;
    return this.callValue(callee, args, node, env);
  }

  callValue(callee, args, node, env) {
    if (callee instanceof PNative) {
      if (callee.capability && !this.rt.capabilities.require(callee.capability, callee.name, node)) {
        return this.rt.markUnresolved(`${callee.name} requires capability ${callee.capability}`, node);
      }
      return callee.fn(args, this);
    }
    if (callee instanceof PFunction) {
      if (callee.abstract) {
        // A signature with no body. Calling it does not invent a result.
        return this.rt.markUnresolved(
          `${callee.name || 'anonymous'} is declared but has no body`, node || { line: 0 },
        );
      }
      const scope = callee.closure.child(`call:${callee.name || 'anonymous'}`);
      if (callee.self) scope.define('self', callee.self);
      if (callee.self) for (const [k, v] of callee.self.fields) scope.define(k, v);
      callee.params.forEach((p, i) => {
        const v = args[i] === undefined
          ? (p.default ? this.evaluate(p.default, scope) : null)
          : args[i];
        if (p.type && v !== null) this.assertType(v, p.type, node, scope, `parameter ${p.name}`);
        scope.define(p.name, v);
      });
      this.callDepth += 1;
      try {
        this.block(callee.body || [], scope);
      } catch (e) {
        if (e instanceof ReturnSignal) {
          if (callee.self) for (const k of callee.self.fields.keys()) callee.self.fields.set(k, scope.get(k));
          if (callee.returnType && e.value !== null) {
            this.assertType(e.value, callee.returnType, node, scope, `return of ${callee.name}`);
          }
          return e.value;
        }
        throw e;
      } finally {
        this.callDepth -= 1;
      }
      if (callee.self) for (const k of callee.self.fields.keys()) callee.self.fields.set(k, scope.get(k));
      return null;
    }
    if (callee instanceof PClass) return this.instantiate(callee);
    if (callee instanceof PType) {
      // A type used as a constructor makes a tagged record.
      const r = new PRecord(callee.name, null, new Map());
      args.forEach((a, i) => r.set(`_${i}`, a));
      return r;
    }
    return this.rt.markUnresolved(`${fmt(callee, 1)} is not callable`, node || { line: 0 });
  }

  assertType(value, typeRef, node, env, what = 'value') {
    const verdict = checkTypeRef(value, typeRef, this.rt);
    if (verdict === true || verdict === null) return true;
    this.rt.diagnose('warning', 'TYPE_ERROR',
      `${what}: expected ${typeRef.name}, got ${typeName(value)}`, node || { line: 0 });
    return false;
  }

  binary(node, env) {
    const op = node.operator;
    if (op === 'AND' || op === '&&') {
      const l = this.evaluate(node.left, env);
      if (!truthy(l)) return false;
      return truthy(this.evaluate(node.right, env));
    }
    if (op === 'OR' || op === '||') {
      const l = this.evaluate(node.left, env);
      if (truthy(l)) return true;
      return truthy(this.evaluate(node.right, env));
    }
    const l = this.evaluate(node.left, env);
    const r = this.evaluate(node.right, env);

    // A CAN_* relation is answered from the runtime's own self-report, never assumed.
    if (op.startsWith('CAN_')) {
      const entry = this.rt.selfReport.get(op);
      if (!entry) return this.rt.markUnresolved(`${op} is not a capability this runtime reports on`, node);
      const [value, evidence] = entry;
      this.rt.recordOperation({
        verb: op, status: value ? 'TRUE' : 'FALSE', evidence,
        subject: fmt(l, 1), object: fmt(r, 1), line: node.line,
      });
      return value;
    }

    if (isUnresolved(l) || isUnresolved(r)) {
      if (op === '==' || op === 'IS') return false;
      if (op === '!=' || op === 'IS_NOT') return true;
      return isUnresolved(l) ? l : r;
    }

    switch (op) {
      case '+':
        if (typeof l === 'string' || typeof r === 'string') return `${fmt(l, 1)}${fmt(r, 1)}`.replace(/"/g, '');
        if (l instanceof PList && r instanceof PList) return new PList([...l.items, ...r.items]);
        return Number(l) + Number(r);
      case '-': return Number(l) - Number(r);
      case '*': return Number(l) * Number(r);
      case '/':
        if (Number(r) === 0) {
          this.rt.diagnose('error', 'RUNTIME_ERROR', 'division by zero', node);
          return this.rt.markUnresolved('division by zero', node);
        }
        return Number(l) / Number(r);
      case '%': return Number(l) % Number(r);
      case '<': return Number(l) < Number(r);
      case '>': return Number(l) > Number(r);
      case '<=': return Number(l) <= Number(r);
      case '>=': return Number(l) >= Number(r);
      case '==': case 'IS': return this.eq(l, r);
      case '!=': case 'IS_NOT': return !this.eq(l, r);
      case 'IN': {
        if (r instanceof PList) return r.items.some((x) => this.eq(x, l));
        if (r instanceof PMap) return r.entries.has(String(fmt(l, 1)));
        if (r instanceof PRange) return Number(l) >= r.start && Number(l) <= r.end;
        if (r instanceof PRecord) return r.fields.has(String(fmt(l, 1))) || (r.members || []).includes(String(fmt(l, 1)));
        if (typeof r === 'string') return r.includes(String(l));
        return this.rt.markUnresolved(`IN over ${typeName(r)} is not defined`, node);
      }
      case 'HAS': {
        if (l instanceof PRecord) return l.fields.has(String(fmt(r, 1))) || (l.members || []).includes(String(fmt(r, 1)));
        if (l instanceof PMap) return l.entries.has(String(fmt(r, 1)));
        if (l instanceof PArtifact) return l.fields.has(String(fmt(r, 1)));
        if (l instanceof PList) return l.items.some((x) => this.eq(x, r));
        return this.rt.markUnresolved(`HAS over ${typeName(l)} is not defined`, node);
      }
      case 'MATCHES': return new RegExp(String(r)).test(String(l));
      case 'CONTRIBUTES_TO': {
        const from = fmt(l, 1);
        const to = fmt(r, 1);
        return this.rt.provenance.edges.some((e) => e.from === from && e.to === to)
          || this.rt.provenance.edges.some((e) => e.to === from && e.from === to);
      }
      default:
        return this.rt.markUnresolved(`operator ${op} is not implemented`, node);
    }
  }

  eq(a, b) {
    if (a === b) return true;
    if (equals(a, b)) return true;
    if (a instanceof PSymbol && b instanceof PSymbol) return a.name === b.name;
    if (a instanceof PSymbol && typeof b === 'string') return a.name === b;
    if (typeof a === 'string' && b instanceof PSymbol) return a === b.name;
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (a === null && b === null) return true;
    return false;
  }
}

Interpreter.deps = {};
export { ReturnSignal, BreakSignal, ContinueSignal };
