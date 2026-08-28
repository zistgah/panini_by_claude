#!/usr/bin/env node
// panini — command line driver for the PANINI language.
//
//   panini check <file>          parse and statically check; exit 1 on error
//   panini tokens <file>         the token stream
//   panini ast <file> [--json]   the parse tree
//   panini run <file>            execute, then report what happened
//   panini test <file>           run every TEST and PROPERTY the program declares
//   panini yields <file>         what the run handed to the host and is waiting on
//   panini invariants            this runtime's report on the fifteen invariants
//   panini capabilities          what this implementation can and cannot do
//   panini selfcheck             parse the canonical spec with this parser
//
// Options: --grant <capability> (repeatable), --now <iso8601>, --json, --quiet

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readCyclers, CyclerRun } from '../src/cycler.js';
import {
  lex, parse, check, run, runTests, invariants, capabilities, VERSION, IMPLEMENTS,
} from '../src/index.js';
import { Host } from '../src/runtime.js';
import { fmt } from '../src/values.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SPEC = join(ROOT, 'spec', 'PANINI_SELF_HOSTING_SPEC.pni');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = { grant: [], json: false, quiet: false, now: null };
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--grant') { flags.grant.push(argv[++i]); continue; }
  if (a === '--now') { flags.now = argv[++i]; continue; }
  if (a === '--json') { flags.json = true; continue; }
  if (a === '--quiet' || a === '-q') { flags.quiet = true; continue; }
  positional.push(a);
}

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`, blue: (s) => `\x1b[36m${s}\x1b[0m` }
  : { dim: (s) => s, red: (s) => s, yellow: (s) => s, green: (s) => s, bold: (s) => s, blue: (s) => s };

// With no file, every command reads the specification that ships beside this
// tool. A command that can do the thing does the thing; it does not stop to ask
// for an argument it can resolve itself.
function sourceFor(arg) {
  const path = arg ? resolve(arg) : SPEC;
  if (!existsSync(path)) {
    die(arg ? `no such file: ${arg}`
      : `no file given, and the canonical spec is not beside this tool (${SPEC})`);
  }
  return { path, text: readFileSync(path, 'utf8') };
}

function die(msg) {
  process.stderr.write(`${C.red('panini:')} ${msg}\n`);
  process.exit(2);
}

function severityColour(s) {
  if (s === 'error') return C.red(s.padEnd(10));
  if (s === 'warning') return C.yellow(s.padEnd(10));
  if (s === 'unresolved') return C.blue(s.padEnd(10));
  return C.dim(s.padEnd(10));
}

function printDiagnostics(list, opts = {}) {
  const show = opts.all ? list : list.filter((d) => d.severity !== 'info');
  for (const d of show) {
    const n = d.count && d.count > 1 ? C.dim(` ×${d.count}`) : '';
    process.stdout.write(`  ${severityColour(d.severity)} ${String(d.line).padStart(5)}  ${d.message}${n}\n`);
  }
  const counts = {};
  for (const d of list) counts[d.severity] = (counts[d.severity] || 0) + 1;
  return counts;
}

const runOpts = () => ({
  capabilities: flags.grant,
  now: flags.now || undefined,
  host: new Host(),
});

switch (cmd) {
  case 'check': {
    const { path, text } = sourceFor(positional[0]);
    const res = check(text, { file: path });
    if (flags.json) { console.log(JSON.stringify(res.diagnostics, null, 2)); break; }
    console.log(`${C.bold('panini check')} ${path}`);
    const counts = printDiagnostics(res.diagnostics);
    console.log(`  ${res.ok ? C.green('ok') : C.red('failed')} — ${res.types.length} types, ${res.functions.length} functions, `
      + `${counts.error || 0} error(s), ${counts.warning || 0} warning(s)`);
    process.exit(res.ok ? 0 : 1);
    break;
  }

  case 'tokens': {
    const { path, text } = sourceFor(positional[0]);
    const { tokens } = lex(text, { file: path });
    if (flags.json) { console.log(JSON.stringify(tokens, null, 2)); break; }
    for (const t of tokens) {
      console.log(`${String(t.line).padStart(5)}:${String(t.col).padStart(3)}  ${t.type.padEnd(5)} ${JSON.stringify(t.value)}`);
    }
    console.log(C.dim(`${tokens.length} tokens`));
    break;
  }

  case 'ast': {
    const { path, text } = sourceFor(positional[0]);
    const ast = parse(text, { file: path });
    if (flags.json) { console.log(JSON.stringify(ast, null, 2)); break; }
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const label = n.kind === 'Declaration'
          ? `${n.keyword}${n.name ? ` ${n.name}` : ''}`
          : `${n.kind}${n.name ? ` ${n.name}` : ''}${n.verb ? ` ${n.verb}` : ''}`;
        console.log(`${'  '.repeat(depth)}${label} ${C.dim(`:${n.line}`)}`);
        if (depth < 2 && n.body) walk(n.body, depth + 1);
      }
    };
    walk(ast.body, 0);
    break;
  }

  case 'run': {
    const { path, text } = sourceFor(positional[0]);
    const { runtime } = run(text, { file: path, ...runOpts() });
    for (const line of runtime.output) console.log(line);
    if (flags.json) { console.log(JSON.stringify(runtime.report(), null, 2)); break; }
    if (!flags.quiet) {
      console.log(`\n${C.bold('diagnostics')}`);
      printDiagnostics(runtime.diagnostics);
      const errs = runtime.diagnostics.filter((d) => d.severity === 'error');
      const unres = runtime.diagnostics.filter((d) => d.severity === 'unresolved');
      console.log(`\n${C.bold('summary')}`);
      console.log(`  artifacts   ${runtime.artifacts.items.size}`);
      console.log(`  operations  ${runtime.operations.length}`);
      console.log(`  unresolved  ${unres.length}`);
      console.log(`  errors      ${errs.length}`);
      console.log(`  awaiting    ${runtime.host.pending.length} host request(s)`);
      if (runtime.capabilities.denials.length) {
        console.log(`  denied      ${runtime.capabilities.denials.length} capability request(s)`);
      }
    }
    process.exit(runtime.diagnostics.some((d) => d.severity === 'error') ? 1 : 0);
    break;
  }

  case 'test': {
    const { path, text } = sourceFor(positional[0]);
    const { results } = runTests(text, { file: path, ...runOpts() });
    let pass = 0;
    for (const r of results) {
      const mark = r.result === 'PASS' ? C.green('PASS') : (r.result === 'FAIL' ? C.red('FAIL') : C.yellow(r.result));
      console.log(`${mark}  ${r.name}`);
      for (const a of r.assertions || []) {
        if (!a.pass) console.log(`        ${C.dim(a.expect)} ${C.red(`→ ${a.value ?? a.error ?? 'false'}`)}`);
      }
      if (r.result === 'PASS') pass += 1;
    }
    console.log(`\n${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
    break;
  }

  case 'yields': {
    const { path, text } = sourceFor(positional[0]);
    const { runtime } = run(text, { file: path, ...runOpts() });
    if (!runtime.host.pending.length) { console.log('nothing is awaiting the host'); break; }
    console.log(C.bold('awaiting the host — the interpreter cannot answer these itself'));
    for (const p of runtime.host.pending) {
      const detail = Object.entries(p.payload)
        .filter(([k]) => k !== 'id')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : fmt(v, 1)}`)
        .join('  ');
      console.log(`  ${C.blue(p.channel.padEnd(10))} ${p.id.padEnd(14)} ${detail}`);
    }
    break;
  }

  case 'invariants': {
    const list = invariants(runOpts());
    if (flags.json) { console.log(JSON.stringify(list, null, 2)); break; }
    console.log(C.bold('architectural invariants — spec section XXXVII, as this implementation stands'));
    for (const i of list) {
      const mark = i.holds ? C.green('HOLDS   ') : C.red('DOES NOT');
      console.log(`  ${mark} ${i.name}`);
      console.log(`           ${C.dim(i.evidence)}`);
    }
    const held = list.filter((i) => i.holds).length;
    console.log(`\n  ${held}/${list.length} hold in this implementation`);
    break;
  }

  case 'capabilities': {
    const list = capabilities(runOpts());
    if (flags.json) { console.log(JSON.stringify(list, null, 2)); break; }
    console.log(C.bold('what this implementation can do'));
    for (const c of list) {
      console.log(`  ${c.value ? C.green('YES') : C.red('NO ')} ${c.name.padEnd(24)} ${C.dim(c.evidence)}`);
    }
    break;
  }

  case 'selfcheck': {
    if (!existsSync(SPEC)) die(`the canonical spec is not beside this tool (${SPEC})`);
    const text = readFileSync(SPEC, 'utf8');
    const res = check(text, { file: SPEC });
    const errors = res.diagnostics.filter((d) => d.severity === 'error');
    console.log(`${C.bold('selfcheck')} — parsing the canonical spec with this parser`);
    console.log(`  ${SPEC}`);
    console.log(`  ${errors.length === 0 ? C.green('parsed with 0 errors') : C.red(`${errors.length} error(s)`)}`);
    console.log(`  ${res.types.length} types, ${res.functions.length} functions declared`);
    printDiagnostics(res.diagnostics.filter((d) => d.severity === 'error'));
    process.exit(errors.length === 0 ? 0 : 1);
    break;
  }

  case 'cycler': {
    // The cycler seat: read a .pni cycler and report what a workbench needs —
    // unit, contract, stages, boundaries, and the prompt each stage carries.
    const { path, text } = sourceFor(positional[0]);
    const { cyclers, diagnostics } = readCyclers(text, { file: path });
    if (!cyclers.length) {
      console.log(`${C.yellow('no cycler declared in')} ${path}`);
      console.log(`  ${C.dim('a cycler is a CYCLER, META_CYCLER or PROGRAM whose body declares STAGEs')}`);
      const errs = diagnostics.filter((d) => d.severity === 'error');
      if (errs.length) console.log(`  ${C.dim(`${errs.length} parse error(s); run: panini check ${positional[0] || ''}`)}`);
      process.exit(3);
    }
    for (const c of cyclers) {
      console.log(`${C.bold(c.id)} ${C.dim(`(${c.kind})`)}${c.script ? '  ' + c.script : ''}`);
      if (c.title && c.title !== c.id) console.log(`  ${c.title}`);
      if (c.purpose) console.log(`  ${C.dim(c.purpose)}`);
      const facts = [];
      if (c.unit) facts.push(`unit: ${C.bold(c.unit)}`);
      if (c.output) facts.push(`output: ${c.output}`);
      if (c.version) facts.push(`version: ${c.version}`);
      if (facts.length) console.log(`  ${facts.join(C.dim('  ·  '))}`);
      const k = c.contract;
      if (k.refuses.length || k.invariants.length || k.evidence.length) {
        console.log(`\n  ${C.bold('contract')}`);
        for (const r of k.refuses) console.log(`    ${C.red('refuses')}    ${r}`);
        for (const r of k.invariants) console.log(`    ${C.blue('invariant')}  ${r}`);
        for (const r of k.evidence) console.log(`    ${C.green('evidence')}   ${r}`);
      }
      console.log(`\n  ${C.bold('stages')} ${C.dim(`(${c.stages.length})`)}`);
      for (const s2 of c.stages) {
        const marks = [s2.density.toLowerCase()];
        if (s2.optional) marks.push('optional');
        if (s2.repeat) marks.push(`repeat ${s2.repeat}`);
        if (s2.boundary) marks.push(C.red('BOUNDARY'));
        console.log(`    ${String(s2.index + 1).padStart(2)}. ${s2.id.padEnd(18)} ${C.dim(marks.join(' · '))}`);
        if (s2.produces) console.log(`        ${C.dim('leaves behind: ' + s2.produces)}`);
        if (!s2.prompt) console.log(`        ${C.yellow('no prompt declared')}`);
      }
      const b = c.stages.filter((s2) => s2.boundary);
      if (b.length) {
        console.log(`\n  ${C.dim('the wheel does not turn through: ' + b.map((x) => x.id).join(', ') + ' — those are yours to decide')}`);
      }
      if (flags.json) console.log(JSON.stringify(c, null, 2));
    }
    break;
  }

  case 'prompt': {
    // Print one stage's prompt exactly as its author wrote it.
    const { path, text } = sourceFor(positional[0]);
    const { cyclers } = readCyclers(text, { file: path });
    if (!cyclers.length) die(`no cycler declared in ${path}`);
    const c = cyclers[0];
    const want = positional[1];
    const stage = want
      ? c.stages.find((s2) => s2.id.toUpperCase() === String(want).toUpperCase())
      : c.stages[0];
    if (!stage) {
      die(`no stage ${want} in ${c.id}; it has: ${c.stages.map((s2) => s2.id).join(', ')}`);
    }
    const run = new CyclerRun(c);
    run.index = stage.index;
    const bindings = {};
    for (const a of positional.slice(2)) {
      const eq = a.indexOf('=');
      if (eq > 0) bindings[a.slice(0, eq)] = a.slice(eq + 1);
    }
    const r = run.render(bindings);
    if (!r.text) die(r.reason);
    process.stdout.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
    if (r.missing.length) {
      process.stderr.write(`${C.yellow('unbound')}: ${[...new Set(r.missing)].join(', ')}`
        + ` ${C.dim('— left as written; supply with name=value')}\n`);
    }
    break;
  }

  case 'deltas': {
    // Every interpretation this implementation had to make, and the spec line
    // that forced it. Clause 19's discharge.
    const f = join(ROOT, 'spec', 'DELTAS.md');
    if (!existsSync(f)) die(`the delta record is not beside this tool (${f})`);
    process.stdout.write(readFileSync(f, 'utf8'));
    break;
  }

  case 'conformance': {
    const { path, text } = sourceFor(positional[0]);
    const parsed = parse(text, { file: path });
    const checked = check(text, { file: path });
    const { runtime } = run(text, { file: path, now: flags.now || '1970-01-01T00:00:00Z', host: new Host() });
    const { results } = runTests(text, { file: path, now: '1970-01-01T00:00:00Z', host: new Host() });
    const inv = invariants();
    const caps = capabilities();
    const count = (sev) => runtime.diagnostics
      .filter((d) => d.severity === sev)
      .reduce((n, d) => n + (d.count || 1), 0);
    const row = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);

    console.log(`${C.bold('PANINI conformance report')}`);
    console.log(`${C.dim(`  panini ${VERSION} · ${IMPLEMENTS}`)}\n`);
    row('source', path);
    row('parse errors', parsed.diagnostics.filter((d) => d.severity === 'error').length);
    row('static check errors', checked.diagnostics.filter((d) => d.severity === 'error').length);
    row('operations executed', runtime.operations.length);
    row('unresolved', `${count('unresolved')} ${C.dim('(marked, never invented)')}`);
    row('runtime errors', count('error'));
    row('types declared', runtime.types.size);
    row('cyclers declared', runtime.cyclers.size);
    row('spec tests', `${results.filter((r) => r.result === 'PASS').length} pass · `
      + `${results.filter((r) => r.result === 'FAIL').length} fail · `
      + `${results.filter((r) => r.result === 'EMPTY').length} empty`);
    row('invariants holding', `${inv.filter((i) => i.holds).length} of ${inv.length}`);
    console.log(`\n${C.bold('  what does not hold')}`);
    for (const i of inv.filter((x) => !x.holds)) console.log(`    ${C.red('x')} ${i.name} ${C.dim('— ' + i.evidence)}`);
    for (const c of caps.filter((x) => !x.value)) console.log(`    ${C.red('x')} ${c.name} ${C.dim('— ' + c.evidence)}`);
    for (const r of results.filter((x) => x.result === 'FAIL')) console.log(`    ${C.red('x')} TEST ${r.name}`);
    console.log(`\n  ${C.dim('This report is the deliverable. A stage-0 bootstrap claiming otherwise would be lying.')}`);
    break;
  }

  case 'version': case '--version': case '-v':
    console.log(`panini ${VERSION} — implements ${IMPLEMENTS}`);
    break;

  default:
    console.log(`panini ${VERSION} — ${IMPLEMENTS}

  panini check <file>          parse and statically check
  panini tokens <file>         the token stream
  panini ast <file>            the parse tree
  panini run <file>            execute and report
  panini test <file>           run TEST and PROPERTY blocks
  panini yields <file>         what is waiting on the host
  panini invariants            the fifteen invariants, as this build stands
  panini capabilities          what this build can and cannot do
  panini selfcheck             parse the canonical spec with this parser
  panini conformance <file>    the whole picture in one page
  panini cycler <file>         read a .pni cycler: unit, contract, stages, boundaries
  panini prompt <file> [stage] [k=v ...]
                               one stage's prompt, exactly as its author wrote it
  panini deltas                every interpretation this build had to make

  With no file, every command reads the specification shipped beside this tool.

  --grant <capability>  grant a capability (default is deny)
  --now <iso8601>       fix NOW for a reproducible run
  --json                machine-readable output
`);
    process.exit(cmd ? 2 : 0);
}
