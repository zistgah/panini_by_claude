// PANINI cycler runtime.
//
// A .pni cycler is a lifecycle machine written in PANINI. This module reads one
// and hands back the shape a workbench needs: contract, stages, prompts, gates,
// densities and the artifact each stage must leave behind.
//
// Three rules run through it, and each is enforced rather than asserted:
//
//   1. THE ENGINE IS COMMON, THE WORKFLOW IS NOT. Nothing in this file names a
//      cycler. Every noun — the unit, the step words, the refusals — comes from
//      the .pni file. Delete every cycler and this module still runs; add a
//      seventh and nothing here changes. `selfCheck()` proves it.
//   2. THE PROMPT IS THE AUTHOR'S BYTES. An ASK body is carried verbatim from
//      the source, never regenerated, never reflowed. What the model is asked is
//      what the author wrote.
//   3. THE WHEEL DOES NOT TURN THROUGH A BOUNDARY. A stage that publishes,
//      mints, seals, deploys, exports or takes consent stops and names whose
//      call it is. Advancing past it is refused, not warned about.
//
// It reaches nothing outside the process. Rendering a prompt returns text; who
// carries that text to a model is the host's business and nobody else's.

import { parse } from './parser.js';

// --------------------------------------------------------------------------
// Boundary stages. Each of these ends the machine's authority.
// --------------------------------------------------------------------------
const BOUNDARY_VERBS = new Set([
  'PUBLISH', 'MINT', 'SEAL', 'DEPLOY', 'CONSENT', 'EXPORT', 'RELEASE', 'SIGNOFF',
]);

// A stage's density. The corpus writes RESOLUTION EASY | MID | PRO.
const DENSITIES = ['EASY', 'MID', 'PRO'];

const text = (node) => {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  switch (node.kind) {
    case 'String': return node.value;
    case 'Number': return String(node.value);
    case 'Identifier': return node.name;
    case 'Member': return `${text(node.object)}.${node.property}`;
    case 'List': return node.items.map(text).join(', ');
    case 'Binary': return `${text(node.left)} ${node.operator} ${text(node.right)}`;
    case 'Postfix': return `${text(node.argument)} ${node.operator}`;
    case 'Call': return `${text(node.callee)}(${(node.args || []).map(text).join(', ')})`;
    default: return node.name || node.value || null;
  }
};

/** Every property line in a body, as verb -> value(s). Order preserved. */
function properties(body) {
  const out = new Map();
  for (const s of body || []) {
    if (s.kind !== 'Operation' || !s.verb) continue;
    const vals = (s.operands || []).map(text).filter((x) => x != null);
    const v = vals.length === 0 ? true : (vals.length === 1 ? vals[0] : vals);
    if (out.has(s.verb.toUpperCase())) {
      const prior = out.get(s.verb.toUpperCase());
      out.set(s.verb.toUpperCase(), [].concat(prior, v));
    } else {
      out.set(s.verb.toUpperCase(), v);
    }
  }
  return out;
}

/** The raw text of the first prompt block in a body, byte for byte. */
function promptOf(body) {
  for (const s of body || []) {
    if (s.kind === 'Content') return { keyword: s.keyword || 'ASK', text: s.text, line: s.line };
  }
  return null;
}

/**
 * The contract: what this cycler refuses, what it holds invariant, what it
 * requires as evidence. Read from a CONTRACT section or a CONTRACT block.
 */
function contractOf(body) {
  const refuses = [];
  const invariants = [];
  const evidence = [];
  const collect = (nodes) => {
    for (const s of nodes || []) {
      if (s.kind !== 'Operation' || !s.verb) continue;
      const v = s.verb.toUpperCase();
      const value = (s.operands || []).map(text).filter(Boolean).join(' ');
      if (!value) continue;
      if (v === 'REFUSE' || v === 'REFUSES') refuses.push(value);
      else if (v === 'INVARIANT') invariants.push(value);
      else if (v === 'EVIDENCE') evidence.push(value);
    }
  };
  for (const s of body || []) {
    if (s.kind === 'Section' && s.upper === 'CONTRACT') collect(s.body);
    if (s.kind === 'Declaration' && s.keyword === 'CONTRACT') collect(s.body);
  }
  return { refuses, invariants, evidence };
}

/** One stage, as the workbench needs it. */
function readStage(node, index) {
  const props = properties(node.body);
  const prompt = promptOf(node.body);
  const name = node.name || `stage_${index + 1}`;
  const verb = String(props.get('VERB') || name).toUpperCase();

  const declared = String(props.get('RESOLUTION') || '').toUpperCase();
  const density = DENSITIES.includes(declared) ? declared : 'MID';

  // A boundary is decided by what the stage DOES, not by where it sits.
  const boundary = BOUNDARY_VERBS.has(verb)
    || BOUNDARY_VERBS.has(name.toUpperCase())
    || props.has('GATE');

  const validate = (node.body || [])
    .filter((s) => s.kind === 'Operation' && /^(VALIDATE|REQUIRE|ENSURE|EXPECT)$/i.test(s.verb || ''))
    .map((s) => s.source || (s.operands || []).map(text).join(' '))
    .filter(Boolean);

  return {
    id: name,
    index,
    verb,
    density,
    boundary,
    optional: props.has('OPTIONAL'),
    repeat: props.get('REPEAT') || null,
    expect: props.get('EXPECT') || null,
    into: props.get('INTO') || null,
    // The artifact this stage must leave behind. A stage that leaves nothing
    // behind is reported, never silently accepted.
    produces: props.get('INTO') || props.get('PRODUCES') || null,
    prompt: prompt ? prompt.text : null,
    promptLine: prompt ? prompt.line : null,
    validate,
    properties: Object.fromEntries(props),
    line: node.line,
  };
}

/**
 * Read every cycler declared in a PANINI source.
 * Returns { cyclers, diagnostics } — never throws on a malformed file.
 */
export function readCyclers(source, opts = {}) {
  const ast = parse(source, opts);
  const found = [];
  // Collect every STAGE in the file, in document order, wherever it sits.
  const allStages = [];
  const walk = (node, holder) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x) => walk(x, holder)); return; }
    if (node.kind === 'Declaration' && node.keyword === 'STAGE') {
      allStages.push(node);
      return;   // a stage's own body is not searched for further stages
    }
    if (node.kind === 'Declaration'
        && ['CYCLER', 'META_CYCLER', 'PROGRAM', 'MODULE', 'WORKFLOW'].includes(node.keyword)
        && node.name && !holder) {
      // The OUTERMOST such container owns every stage beneath it. The corpus
      // nests stages under WORKFLOW and section blocks as often as not, so
      // requiring them to be direct children found only two files in nine — and
      // treating each inner container as its own cycler split one cycler into
      // twenty-two of one stage each.
      const before = allStages.length;
      for (const k of Object.keys(node)) {
        if (k !== 'kind' && node[k] && typeof node[k] === 'object') walk(node[k], node);
      }
      if (allStages.length > before) {
        node.__stages = allStages.slice(before);
        found.push(node);
      }
      return;
    }
    for (const k of Object.keys(node)) {
      if (k !== 'kind' && node[k] && typeof node[k] === 'object') walk(node[k], holder);
    }
  };
  walk(ast.body, null);

  // A file whose stages sit at top level, with no container holding them, still
  // describes a cycler. It is read from the file's own top-level properties
  // rather than reported as nothing — but it is marked so, because a container
  // that was lost to a parse error is a different thing from one never written.
  if (!found.length && allStages.length) {
    const claimed = new Set();
    found.push({
      kind: 'Declaration',
      keyword: 'FILE',
      name: (opts.file || 'cycler').replace(/^.*\//, '').replace(/\.pni$/i, ''),
      body: (ast.body || []).filter((n) => n.kind === 'Operation'),
      __stages: allStages.filter((s) => !claimed.has(s)),
      __synthesised: true,
      line: allStages[0].line,
    });
  }

  const cyclers = found.map((node) => {
    const props = properties(node.body);
    const stages = (node.__stages
      || (node.body || []).filter((s) => s.kind === 'Declaration' && s.keyword === 'STAGE'))
      .map(readStage);
    return {
      id: node.name,
      kind: node.keyword,
      title: props.get('TITLE') || node.name,
      script: props.get('SCRIPT') || null,
      output: props.get('OUTPUT') || null,
      // The UNIT is the noun this cycler works in. It is the single most
      // important thing to take from the file rather than from a template:
      // a diary entry has no timeline and a station has no shot list.
      unit: props.get('UNIT') || null,
      purpose: props.get('PURPOSE') || null,
      version: props.get('VERSION') || null,
      contract: contractOf(node.body),
      stages,
      // True when no container declaration held these stages — the file still
      // describes a cycler, but the reader assembled it rather than reading it.
      synthesised: Boolean(node.__synthesised),
      line: node.line,
    };
  });

  return { cyclers, diagnostics: ast.diagnostics, ast };
}

// --------------------------------------------------------------------------
// A run: one pass through a cycler, held by the host.
// --------------------------------------------------------------------------
export class CyclerRun {
  constructor(cycler, opts = {}) {
    this.cycler = cycler;
    this.index = 0;
    this.artifacts = new Map();   // stage id -> what the operator put there
    this.log = [];
    this.density = opts.density || null;   // overrides every stage when set
    this.now = opts.now || null;
  }

  stage() { return this.cycler.stages[this.index] || null; }

  densityOf(stage) { return this.density || (stage ? stage.density : 'MID'); }

  /**
   * The prompt for the current stage, exactly as its author wrote it, with the
   * operator's bindings substituted into {placeholders}. A placeholder with no
   * binding is LEFT AS IT IS and reported — filling it with something plausible
   * is the one thing a prompt must never do.
   */
  render(bindings = {}) {
    const s = this.stage();
    if (!s) return { text: null, missing: [], reason: 'the cycler has no stage here' };
    if (!s.prompt) {
      return { text: null, missing: [], reason: `stage ${s.id} declares no prompt` };
    }
    const missing = [];
    const out = s.prompt.replace(/\{([A-Za-z_][\w.]*)\}/g, (whole, key) => {
      if (Object.prototype.hasOwnProperty.call(bindings, key)) return String(bindings[key]);
      missing.push(key);
      return whole;
    });
    return { text: out, missing, stage: s.id, reason: null };
  }

  /** Record what the operator brought back. Origin is never asserted. */
  accept(value, note = null) {
    const s = this.stage();
    if (!s) return { ok: false, reason: 'no stage here' };
    this.artifacts.set(s.id, {
      value,
      note,
      // A file in a folder is not evidence. The desk records who chose it and
      // makes no claim about what produced it.
      origin: 'chosen by the operator; origin not asserted',
      at: this.now,
    });
    this.log.push({ stage: s.id, action: 'accept' });
    if (s.boundary) {
      return {
        ok: true,
        stopped: true,
        reason: `stage ${s.id} is a boundary (${s.verb}): whether this goes further is not the machine's call`,
      };
    }
    return { ok: true, stopped: false };
  }

  /**
   * Advance. Refuses to turn through a boundary, and refuses to leave a stage
   * that was supposed to produce something and did not.
   */
  advance() {
    const s = this.stage();
    if (!s) return { ok: false, reason: 'the cycler is finished' };
    if (s.boundary) {
      return {
        ok: false,
        reason: `the wheel does not turn through a boundary: ${s.id} (${s.verb}) is yours to decide`,
      };
    }
    if (s.produces && !this.artifacts.has(s.id) && !s.optional) {
      return {
        ok: false,
        reason: `stage ${s.id} must leave ${s.produces} behind, and nothing has been accepted into it`,
      };
    }
    this.index += 1;
    this.log.push({ stage: s.id, action: 'advance' });
    return { ok: true, next: this.stage() ? this.stage().id : null };
  }

  /** What has been done, what is left, and what is refused. Never "complete". */
  report() {
    const done = this.cycler.stages.filter((s) => this.artifacts.has(s.id)).length;
    return {
      cycler: this.cycler.id,
      unit: this.cycler.unit,
      at: this.stage() ? this.stage().id : null,
      stagesWithArtifact: done,
      stages: this.cycler.stages.length,
      boundaries: this.cycler.stages.filter((s) => s.boundary).map((s) => s.id),
      refuses: this.cycler.contract.refuses,
      // Deliberately absent: any statement that the work is complete. That is
      // not a thing this runtime is in a position to know.
    };
  }
}

/**
 * Prove rule 1: nothing in this module names a cycler. Reads its own source and
 * looks for any of the ids it was handed. If a name has leaked into the engine,
 * the engine is no longer common and this says so.
 */
export function selfCheck(sourceText, ids) {
  const body = String(sourceText);
  // Only the code matters, not the comments that explain the rule.
  const code = body.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
    .toUpperCase();
  const leaked = ids.filter((id) => new RegExp(`\\b${String(id).toUpperCase()}\\b`).test(code));
  return { ok: leaked.length === 0, leaked };
}

export { BOUNDARY_VERBS, DENSITIES, properties, promptOf, contractOf };
