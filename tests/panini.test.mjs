// PANINI test suite. Run: node tests/panini.test.mjs
//
// House rule: a test proves nothing until it has been shown to fail. Several
// tests below therefore assert BOTH that a rule passes on good input AND that it
// refuses bad input — the refusal is the test. The provider-absence grep runs
// against a planted string to prove the grep itself works.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lex, heredoc } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check, run, runTests, invariants, capabilities } from '../src/index.js';
import { Host, Runtime } from '../src/runtime.js';
import { Interpreter } from '../src/interpreter.js';
import { fmt, isUnresolved, PList, PSymbol } from '../src/values.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SPEC = readFileSync(join(ROOT, 'spec', 'PANINI_SELF_HOSTING_SPEC.pni'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) { passed += 1; return true; }
  failed += 1;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function eq(label, actual, expected) {
  return ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(name) { process.stdout.write(`\n${name}\n`); }

const runtimeOf = (src, opts = {}) => run(src, { host: new Host(), ...opts }).runtime;
const errorsOf = (rt) => rt.diagnostics.filter((d) => d.severity === 'error');
const unresolvedOf = (rt) => rt.diagnostics.filter((d) => d.severity === 'unresolved');

// =========================================================================
section('lexer');
// =========================================================================
{
  const { tokens } = lex('FUNCTION f() -> Int RETURN 1 END');
  ok('lexes a function header', tokens.length > 5);

  // D1: keywords are case-insensitive. A BASIC that is not, is not a BASIC.
  const lower = check('function f() -> Int\n    return 1\nEND');
  const upper = check('FUNCTION f() -> Int\n    RETURN 1\nEND');
  ok('keywords are case-insensitive', lower.ok && upper.ok);
  eq('lowercase keywords produce the same declaration',
    JSON.stringify(lower.ast.body[0].keyword), JSON.stringify(upper.ast.body[0].keyword));

  // D2: identifiers are case-sensitive; `sovereign` and `Sovereign` are distinct.
  const rt = runtimeOf('VAR a = 1\nVAR A = 2\nPRINT a\nPRINT A');
  eq('identifiers are case-sensitive', rt.output.join(','), '1,2');

  // D3: `""` inside a string is a literal quote (spec line 1319).
  const s = lex('"a""b"').tokens[0];
  eq('doubled quote is a literal quote', s.value, 'a"b');

  // A string may span lines (spec lines 26-27).
  const ml = lex('"one\ntwo"').tokens[0];
  ok('strings span lines', ml.value.includes('\n'));

  // `0..10` is a range, not the float 0.0 followed by 10.
  const range = lex('0..10').tokens;
  eq('a range is not eaten as a decimal point', range.map((t) => String(t.value)).join(' '), '0 .. 10 null');

  // Heredoc: blank lines survive, common indentation is stripped uniformly.
  const lines = ['CONTENT', '        a', '', '            b', '    END'];
  const h = heredoc(lines, 1, 4);
  eq('heredoc strips common indent and keeps blank lines', JSON.stringify(h.text), JSON.stringify('a\n\n    b'));
}

// =========================================================================
section('parser');
// =========================================================================
{
  // The load-bearing test: this parser parses the specification that defines it.
  const res = check(SPEC, { file: 'PANINI_SELF_HOSTING_SPEC.pni' });
  const errs = res.diagnostics.filter((d) => d.severity === 'error');
  ok('the canonical spec parses with zero errors', errs.length === 0,
    errs.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join('; '));
  eq('the spec is one MODULE', res.ast.body.length, 1);
  eq('the module is PANINI', res.ast.body[0].name, 'PANINI');
  ok('the module holds every top-level construct', res.ast.body[0].body.length > 250);

  const spec = parse(SPEC);
  const top = spec.body[0].body;
  const decl = (kw, nm) => top.filter((n) => n.kind === 'Declaration' && n.keyword === kw && (!nm || n.name === nm));

  // Explicit terminator: `END FILE` closes the FILE, not the CONTENT inside it.
  const hello = decl('FILE', 'hello.pni')[0];
  ok('END FILE closes the FILE block', hello && hello.block);
  const content = hello.body.find((n) => n.kind === 'Content');
  eq('CONTENT survives byte-for-byte', content.text,
    'FUNCTION main() -> Int\n    PRINT "Hello, PANINI"\n    RETURN 0\nEND');

  // Dedent-closed blocks: INVARIANT has no END at all.
  eq('all fifteen invariants parse without an END', top.filter((n) => n.kind === 'Invariant').length, 15);

  // THEOREM's sections close by dedent and the final END belongs to the THEOREM.
  const th = decl('THEOREM')[0];
  eq('THEOREM has four sections', th.body.length, 4);
  eq('THEOREM REQUIRE holds seven requirements',
    th.body.find((n) => n.upper === 'REQUIRE').body.length, 7);

  // D10: a spaced bracket is a value; an unspaced one is an index.
  const model = decl('MODEL', 'claude')[0];
  const caps = model.body.find((n) => n.verbUpper === 'CAPABILITIES');
  eq('a spaced bracket is a list property', caps.operands[0].kind, 'ListLiteral');
  const cls = decl('CLASS')[0];
  const method = cls.body.find((n) => n.name === 'add');
  eq('an unspaced bracket is an index', method.body[0].target.kind, 'Index');
  eq('a dotted name in an expression is a member access', method.body[0].target.index.kind, 'Member');

  // D9: a declaration keyword in a property position is a property.
  const gate = decl('GATE')[0];
  const typeProp = gate.body.find((n) => n.verbUpper === 'TYPE');
  ok('TYPE inside GATE is a property, not a type declaration', typeProp && typeProp.kind === 'Operation');

  // ...but inside a MODULE it is a declaration.
  const lang = top.find((n) => n.kind === 'Declaration' && n.name === 'PANINI.Language');
  ok('TYPE inside MODULE is a declaration',
    lang.body.some((n) => n.kind === 'Declaration' && n.keyword === 'TYPE' && n.name === 'Token'));

  // An operation carries prepositional clauses.
  const sup = top.find((n) => n.kind === 'Operation' && n.verbUpper === 'SUPERSEDE');
  eq('SUPERSEDE ... WITH ... keeps its clause', sup.clauses[0].prep, 'WITH');
  eq('a versioned reference keeps its version', sup.operands[0].version, '1.0');

  // A parse error is reported with a line, not swallowed.
  const broken = check('FUNCTION f(\n');
  ok('an unbalanced parameter list is reported', !broken.ok || broken.diagnostics.length > 0);
}

// =========================================================================
section('interpreter — core language');
// =========================================================================
{
  const rt = runtimeOf(`
FUNCTION factorial(n:Int) -> Int
    IF n <= 1
        RETURN 1
    ELSE
        RETURN n * factorial(n - 1)
    END
END
PRINT factorial(5)
`);
  eq('recursion works', rt.output[0], '120');

  const cl = runtimeOf(`
FUNCTION adder(n:Int) -> Function
    RETURN FUNCTION(x)
        RETURN x + n
    END
END
VAR add3 = adder(3)
PRINT add3(4)
`);
  eq('closures capture their environment', cl.output[0], '7');

  const loop = runtimeOf(`
VAR total = 0
FOR i IN 1..5
    CONTINUE IF i == 3
    total = total + i
END
PRINT total
`);
  eq('FOR with a CONTINUE IF modifier', loop.output[0], '12');

  const m = runtimeOf(`
VAR x = 7
MATCH x
    CASE 1
        PRINT "one"
    CASE n WHEN n > 5
        PRINT "big"
    CASE _
        PRINT "other"
END
`);
  eq('MATCH with a guard', m.output[0], 'big');

  const t = runtimeOf(`
TRY
    VAR z = 1 / 0
    PRINT z
CATCH e
    PRINT "caught"
FINALLY
    PRINT "always"
END
`);
  ok('TRY/CATCH/FINALLY both run', t.output.includes('always'));

  const cls = runtimeOf(`
CLASS Counter
    FIELD n: Int
    METHOD bump()
        n = n + 1
    END
    METHOD value() -> Int
        RETURN n
    END
END
VAR c = Counter()
c.n = 0
PRINT c.n
`);
  eq('a class instantiates and holds a field', cls.output[0], '0');

  const par = runtimeOf(`
PARALLEL
    PRINT "a"
    PRINT "b"
    PRINT "c"
JOIN
`);
  eq('PARALLEL runs branches deterministically in order', par.output.join(''), 'abc');

  // A loop that cannot end aborts rather than hanging the host. Proven by running it.
  const spin = runtimeOf('VAR go = TRUE\nWHILE go\n    VAR x = 1\nEND', { loopLimit: 500 });
  ok('an endless loop is aborted, not hung',
    errorsOf(spin).some((d) => /exceeded 500 iterations/.test(d.message)));
}

// =========================================================================
section('no provider — the interpreter cannot reach anyone');
// =========================================================================
{
  // Grep the shipped engine for any way out of the process.
  const FORBIDDEN = [
    /\bfetch\s*\(/, /XMLHttpRequest/, /node:http/, /require\(['"]https?['"]\)/,
    /\bWebSocket\b/, /axios/, /api\.[a-z]+\.com/,
  ];
  const files = [];
  for (const dir of ['src', 'bin']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (f.endsWith('.js') || f.endsWith('.mjs')) {
        files.push({ path: `${dir}/${f}`, text: readFileSync(join(ROOT, dir, f), 'utf8') });
      }
    }
  }
  ok('there are engine files to check', files.length >= 6, `found ${files.length}`);

  // The scan is a named function so the mutation below runs the SAME scan, not
  // a re-implementation of it that could pass while the real one is broken.
  const scan = (fileset) => {
    const found = [];
    for (const f of fileset) {
      for (const re of FORBIDDEN) if (re.test(f.text)) found.push(`${f.path} matches ${re}`);
    }
    return found;
  };

  ok('the engine contains no network call', scan(files).length === 0, scan(files).join('; '));

  // MUTATION PROOF. A gate that has never refused anything is not a gate. Plant
  // a real network call into a real copy of a real engine file, run the same
  // scan over the same shape of input, and require it to catch it. Each vendor
  // and transport pattern is proven separately, so a broken one cannot hide
  // behind a working one.
  const victim = files.find((f) => f.path === 'src/interpreter.js');
  ok('there is an engine file to mutate', Boolean(victim));
  const mutations = [
    ['fetch', 'const r = await fetch("https://example.invalid/v1/messages");'],
    ['XMLHttpRequest', 'const x = new XMLHttpRequest();'],
    ['node:http', "import http from 'node:http';"],
    ['require https', 'const h = require("https");'],
    ['WebSocket', 'const w = new WebSocket("wss://example.invalid");'],
    ['axios', "import axios from 'axios';"],
    ['a vendor endpoint', 'const u = "https://api.someprovider.com/v1/complete";'],
  ];
  for (const [name, line] of mutations) {
    const mutated = files.map((f) => (f === victim ? { path: f.path, text: `${f.text}\n${line}\n` } : f));
    const caught = scan(mutated);
    ok(`the network scan catches a planted ${name}`, caught.length > 0);
    ok(`...and names the file it was planted in (${name})`,
      caught.some((h) => h.startsWith('src/interpreter.js')), caught.join('; '));
  }
  // ...and the unmutated set must still come back clean, or the scan is just
  // matching everything.
  ok('the scan is not matching indiscriminately', scan(files).length === 0);

  // ASK yields; it does not answer.
  const rt = new Runtime({ host: new Host() });
  const interp = new Interpreter(rt);
  const ast = parse('MODEL m\n    PROVIDER "external"\nEND\nASK m "anything"');
  interp.run(ast, interp.global);
  eq('ASK hands the request to the host', rt.host.pending.length, 1);
  eq('...and the channel is ask', rt.host.pending[0].channel, 'ask');
  eq('a MODEL declaration is not invocable',
    fmt(rt.models.get('m').get('invocable'), 1), 'FALSE');
}

// =========================================================================
section('UNRESOLVED is never a guess');
// =========================================================================
{
  const rt = runtimeOf('FUNCTION f() -> Int\n    ...\nEND\nVAR r = f()\nPRINT r');
  ok('an ellipsis body yields UNRESOLVED', /UNRESOLVED/.test(rt.output[0] || ''), rt.output[0]);

  const sig = runtimeOf('FUNCTION g(x:Int) -> Int\nVAR r = g(1)\nPRINT r');
  ok('calling a bodyless signature yields UNRESOLVED', /UNRESOLVED/.test(sig.output[0] || ''), sig.output[0]);

  const verb = runtimeOf('FLUMMOX the_widget');
  ok('an unknown operation verb is marked, not performed',
    unresolvedOf(verb).some((d) => /FLUMMOX/.test(d.message)));
  ok('...and it is still recorded',
    verb.operations.some((o) => o.verb === 'FLUMMOX' && o.status === 'unrecognised'));

  const comp = runtimeOf('COMPILE something');
  ok('COMPILE reports that no compiler exists',
    unresolvedOf(comp).some((d) => /no compiler/.test(d.message)));

  // The negative case: a verb that IS implemented must not report UNRESOLVED.
  const good = runtimeOf('ARTIFACT a\n    TYPE "spec"\nEND\nBASELINE "r1"');
  ok('an implemented verb does not report UNRESOLVED',
    !unresolvedOf(good).some((d) => /BASELINE/.test(d.message)));
}

// =========================================================================
section('human sovereignty — gates need an exact typed word');
// =========================================================================
{
  const src = `
ARTIFACT architecture
    TYPE "specification"
    STATUS DRAFT
END
SIGNOFF architecture BY HUMAN
`;
  const yielded = runtimeOf(src);
  eq('SIGNOFF yields to a person', yielded.host.pending.length, 1);
  eq('...on the gate channel', yielded.host.pending[0].channel, 'gate');
  eq('...and the artifact is still DRAFT', yielded.artifacts.get('architecture').status, 'DRAFT');

  // The wrong word must be refused. This is the assertion that matters.
  const wrongHost = new Host();
  wrongHost.supply('gate#1', 'signoff architecture'); // lower case
  const wrong = runtimeOf(src, { host: wrongHost });
  ok('a gate refuses a word that differs in case',
    errorsOf(wrong).some((d) => d.code === 'SIGNOFF_REQUIRED'));
  eq('...and the artifact is not approved', wrong.artifacts.get('architecture').status, 'DRAFT');

  const rightHost = new Host();
  rightHost.supply('gate#1', 'SIGNOFF architecture');
  const right = runtimeOf(src, { host: rightHost });
  eq('the exact word approves the artifact', right.artifacts.get('architecture').status, 'APPROVED');
  eq('...and the signoff is recorded', right.artifacts.get('architecture').signoffs.length, 1);

  // RELEASE without a signoff is refused.
  const rel = runtimeOf('ARTIFACT a\n    TYPE "spec"\nEND\nRELEASE a VERSION "1.0.0"');
  ok('RELEASE without signoff is refused',
    errorsOf(rel).some((d) => d.code === 'SIGNOFF_REQUIRED'));

  // ...and with one, it is allowed. Both halves, or the test proves nothing.
  const relHost = new Host();
  relHost.supply('gate#1', 'SIGNOFF a');
  const rel2 = runtimeOf('ARTIFACT a\n    TYPE "spec"\nEND\nSIGNOFF a BY HUMAN\nRELEASE a VERSION "1.0.0"',
    { host: relHost });
  eq('RELEASE after signoff produces the new version',
    rel2.artifacts.at('a', '1.0.0') ? rel2.artifacts.at('a', '1.0.0').status : 'missing', 'RELEASED');
}

// =========================================================================
section('epistemic status — I9 and I10');
// =========================================================================
{
  const rt = runtimeOf(`
CLAIM tagged
    STATUS RETRIEVED
    SOURCE "an authoritative source"
END
CLAIM untagged
    SOURCE "somewhere"
END
PRINT canonicalize(tagged)
PRINT canonicalize(untagged)
`);
  ok('a tagged claim canonicalizes', /^OK/.test(rt.output[0]), rt.output[0]);
  ok('an untagged claim is refused', /ERR\(untagged claim\)/.test(rt.output[1]), rt.output[1]);

  const bad = runtimeOf('CLAIM c\n    STATUS DEFINITELY_TRUE\n    SOURCE "x"\nEND');
  ok('a status outside EpistemicStatus is refused',
    errorsOf(bad).some((d) => d.code === 'PROVENANCE_ERROR'));

  // I10: a simulation cannot become an experiment.
  const sim = runtimeOf(`
CONFIGURATION plan
    mode = SIMULATED
END
EXPERIMENT plan
`);
  ok('EXPERIMENT refuses a plan that is not EXPERIMENTAL',
    errorsOf(sim).some((d) => d.code === 'EVIDENCE_INSUFFICIENT'));

  const exp = runtimeOf(`
CONFIGURATION plan
    mode = EXPERIMENTAL
END
EXPERIMENT plan
`);
  ok('...and accepts one that is, by handing it to the host',
    exp.host.pending.some((p) => p.channel === 'experiment')
    && !errorsOf(exp).some((d) => d.code === 'EVIDENCE_INSUFFICIENT'));
}

// =========================================================================
section('claims — provenance under either name (D24)');
// =========================================================================
{
  // RULE CANONICAL_OUTPUT requires provenance. The spec supplies it as SOURCE;
  // the rule names it PROVENANCE. Both must establish it, and neither may be
  // enough on its own to skip the status tag.
  const rt = runtimeOf([
    'CLAIM bare\n    STATEMENT "x"\nEND',
    'CLAIM viaSource\n    STATUS VERIFIED\n    SOURCE "s.pni"\nEND',
    'CLAIM viaProvenance\n    STATUS VERIFIED\n    PROVENANCE "p.pni"\nEND',
    'CLAIM statusOnly\n    STATUS VERIFIED\nEND',
    'PRINT canonicalize(bare)',
    'PRINT canonicalize(viaSource)',
    'PRINT canonicalize(viaProvenance)',
    'PRINT canonicalize(statusOnly)',
  ].join('\n'));
  ok('an untagged claim cannot be canonicalized', /ERR\(untagged claim\)/.test(rt.output[0]), rt.output[0]);
  ok('SOURCE establishes provenance', /^OK\(/.test(rt.output[1]), rt.output[1]);
  ok('PROVENANCE establishes it too', /^OK\(/.test(rt.output[2]), rt.output[2]);
  ok('a status with no provenance is still refused',
    /ERR\(missing provenance\)/.test(rt.output[3]), rt.output[3]);
  ok('a status outside EpistemicStatus is an error',
    errorsOf(runtimeOf('CLAIM c\n    STATUS DEFINITELY_TRUE\n    SOURCE "s"\nEND'))
      .some((d) => d.code === 'PROVENANCE_ERROR'));
  ok('...and a status inside it is not',
    errorsOf(runtimeOf('CLAIM c\n    STATUS RETRIEVED\n    SOURCE "s"\nEND')).length === 0);
}

// =========================================================================
section('capabilities — DEFAULT_DENY');
// =========================================================================
{
  const denied = runtimeOf('VAR s = "x"\nSERIALIZE s TO "state.json"');
  ok('a write without a grant is denied',
    denied.capabilities.denials.some((d) => d.capability === 'filesystem.write'));
  ok('...and reported as UNRESOLVED, not silently skipped',
    unresolvedOf(denied).some((d) => /filesystem.write/.test(d.message)));

  const granted = runtimeOf('VAR s = "x"\nSERIALIZE s TO "state.json"',
    { capabilities: ['filesystem.write'] });
  eq('a granted write reaches the host', granted.host.pending.filter((p) => p.channel === 'write').length, 1);
  eq('...and records no denial', granted.capabilities.denials.length, 0);

  const grab = runtimeOf('GRANT filesystem.write');
  ok('a program cannot grant itself a capability',
    errorsOf(grab).some((d) => d.code === 'CAPABILITY_DENIED'));
}

// =========================================================================
section('artifacts and provenance');
// =========================================================================
{
  const rt = runtimeOf(`
ARTIFACT requirements
    TYPE "specification"
    FORMAT "text/markdown"
    VERSION "1.0.0"
    STATUS DRAFT
END
DELIVERABLE architecture
    TYPE SPECIFICATION
    VERSION "1.0"
    STATUS DRAFT
    DEPENDS_ON requirements
END
ARTIFACT_REVISION architecture
    FROM architecture
    CHANGE "replace transport layer"
    PRESERVE_PROVENANCE TRUE
END
`);
  eq('the revision bumps the version', rt.artifacts.get('architecture').version, '1.1');
  ok('the revision records its ancestor',
    rt.provenance.edges.some((e) => e.how === 'REVISION' && e.from === 'architecture@1.0'));
  ok('DEPENDS_ON is an ancestry edge',
    rt.provenance.edges.some((e) => e.how === 'DEPENDS_ON' && e.from === 'requirements'));
  ok('the earlier version is still reachable', rt.artifacts.at('architecture', '1.0') !== null);

  // I7: a FILE carries semantic MIME, and a missing one is reported.
  const f = runtimeOf('FILE "d.svg"\n    MIME "image/svg+xml"\n    CONTENT\n        <svg></svg>\n    END\nEND FILE');
  eq('a FILE keeps its MIME', f.artifacts.get('d.svg').format, 'image/svg+xml');
  eq('a FILE keeps its bytes', f.artifacts.get('d.svg').content, '<svg></svg>');
  const noMime = runtimeOf('FILE "x.txt"\n    ENCODING "utf-8"\nEND FILE');
  ok('a FILE without MIME is reported',
    noMime.diagnostics.some((d) => d.code === 'missing-mime'));
}

// =========================================================================
section('artifact fields read as PANINI values, not host values');
// =========================================================================
{
  const h = new Host();
  h.supply('gate#1', 'SIGNOFF b');
  const rt = runtimeOf([
    'ARTIFACT a\n    TYPE "doc"\nEND',
    'ARTIFACT b\n    TYPE "doc"\n    DEPENDS_ON [a]\nEND',
    'SIGNOFF b BY HUMAN',
    'PRINT b.dependsOn',
    'PRINT b.status',
    'PRINT b.signoffs',
  ].join('\n'), { host: h });
  eq('dependsOn reads as a PANINI list', rt.output[0], '[a]');
  eq('status reads as a symbol', rt.output[1], 'APPROVED');
  ok('signoffs read as a list', /^\[.+\]$/.test(rt.output[2]), rt.output[2]);
  ok('no unresolved was produced reading them', unresolvedOf(rt).length === 0,
    unresolvedOf(rt).map((d) => d.message).join('; '));
  // ...and a field that genuinely is not there is still refused.
  const missing = runtimeOf('ARTIFACT a\n    TYPE "doc"\nEND\nPRINT a.nonesuch');
  ok('an absent field is still UNRESOLVED', /UNRESOLVED/.test(missing.output[0]), missing.output[0]);
}

// =========================================================================
section('cyclers are lifecycles, not prompt lists');
// =========================================================================
{
  const rt = runtimeOf(`
CYCLER Build
    PURPOSE "take intent to a verified deliverable"
    STAGE INTENT
        ELICIT intent
    END
    STAGE DESIGN
        DERIVE design FROM intent
    END
END
RUN Build
`);
  const c = rt.cyclers.get('Build');
  eq('a cycler declares its stages', c.stages.length, 2);
  ok('a stage operation halts the cycler until the host answers',
    rt.host.pending.some((p) => p.channel === 'operation'));
  eq('...and it halts at the first stage, not the last',
    rt.host.pending.filter((p) => p.channel === 'operation').length, 1);

  // Two cyclers with different stages must not be the same object.
  const two = runtimeOf(`
CYCLER A
    STAGE ONE
        ELICIT x
    END
END
CYCLER B
    STAGE TWO
        DERIVE y FROM x
    END
END
`);
  ok('two cyclers keep their own stage sequences',
    fmt(two.cyclers.get('A').get('stages'), 1) !== fmt(two.cyclers.get('B').get('stages'), 1));
}

// =========================================================================
section('reflection — PANINI reads PANINI');
// =========================================================================
{
  const rt = runtimeOf(`
VAR src = "FUNCTION f(x:Int) -> Int RETURN x END"
VAR t = lex(src)
VAR p = parse(src)
PRINT LEN(t)
PRINT p.success
`);
  ok('a PANINI program can lex PANINI source', Number(rt.output[0]) > 8, rt.output[0]);
  eq('a PANINI program can parse PANINI source', rt.output[1], 'TRUE');
}

// =========================================================================
section('the spec runs, and reports the truth about itself');
// =========================================================================
{
  const rt = runtimeOf(SPEC, { file: 'spec.pni' });
  const errs = errorsOf(rt);
  ok('the spec executes', rt.operations.length > 20);
  ok('RELEASE without signoff is caught in the spec itself',
    errs.some((d) => d.code === 'SIGNOFF_REQUIRED' && d.line === 420));
  ok('the spec\'s own CAN_COMPILE assertion FAILS, and is reported',
    errs.some((d) => d.line === 1188 && /CAN_COMPILE/.test(d.message)));

  const { results } = runTests(SPEC, { file: 'spec.pni', host: new Host() });
  const byName = Object.fromEntries(results.map((r) => [r.name, r.result]));
  eq('the spec\'s lexer test passes', byName.lexer_basic, 'PASS');
  eq('the spec\'s parser test passes', byName.parser_basic, 'PASS');
  eq('the spec\'s typechecker test passes', byName.typechecker_basic, 'PASS');
  eq('the spec\'s self-hosting test FAILS, because there is no compiler',
    byName.self_hosting, 'FAIL');
}

// =========================================================================
section('the implementation does not overstate itself');
// =========================================================================
{
  const inv = invariants();
  const get = (n) => inv.find((i) => i.name === n);
  eq('I2 SELF_HOSTING is reported FALSE', get('PANINI_IS_SELF_HOSTING').holds, false);
  eq('I15 CAN_EXPRESS_ITS_OWN_IMPLEMENTATION is reported FALSE',
    get('PANINI_CAN_EXPRESS_ITS_OWN_IMPLEMENTATION').holds, false);
  ok('every invariant carries evidence', inv.every((i) => i.evidence && i.evidence.length > 20));

  const caps = capabilities();
  const cap = (n) => caps.find((c) => c.name === n);
  eq('CAN_PARSE is claimed', cap('CAN_PARSE').value, true);
  eq('CAN_COMPILE is not claimed', cap('CAN_COMPILE').value, false);
  eq('CAN_GENERATE_TARGETS is not claimed', cap('CAN_GENERATE_TARGETS').value, false);

  const boot = runtimeOf(SPEC, { file: 'spec.pni' });
  ok('BOOTSTRAP reports stage 0 built and the rest unresolved',
    boot.diagnostics.some((d) => d.code === 'bootstrap' && /stage 0 built/.test(d.message)));
}

// =========================================================================
section('mutation proofs — every gate is shown refusing something');
// =========================================================================
{
  // A refusal that has never been observed is a claim, not a gate. Each block
  // below feeds the gate input it MUST refuse, then input it MUST accept. If
  // either half stops holding, the gate has silently opened.

  // 1. The loop limit aborts a loop that cannot end.
  const spin = runtimeOf('VAR i = 0\nWHILE i < 10\n    VAR j = 1\nEND', { loopLimit: 50 });
  ok('a loop whose guard never changes is aborted, not hung',
    errorsOf(spin).some((d) => /exceeded 50 iterations/.test(d.message)));
  const fine = runtimeOf('VAR i = 0\nWHILE i < 3\n    i = i + 1\nEND\nPRINT i', { loopLimit: 50 });
  eq('...and a loop that does end is left alone', fine.output[0], '3');

  // 2. A gate refuses a near miss, and accepts only the exact word.
  const gateSrc = 'ARTIFACT d\n    TYPE "spec"\nEND\nGATE G\n    REQUIRE "SIGNOFF d"\nEND\nSIGNOFF d BY HUMAN';
  for (const nearMiss of ['SIGNOFF  d', 'signoff d', 'SIGNOFF d ', 'SIGN OFF d', 'SIGNOFF']) {
    const h = new Host();
    h.supply('gate#1', nearMiss);
    const rt = runtimeOf(gateSrc, { host: h });
    ok(`a gate refuses ${JSON.stringify(nearMiss)}`,
      rt.artifacts.get('d').status !== 'APPROVED', rt.artifacts.get('d').status);
  }
  const exactHost = new Host();
  exactHost.supply('gate#1', 'SIGNOFF d');
  eq('...and accepts the exact word',
    runtimeOf(gateSrc, { host: exactHost }).artifacts.get('d').status, 'APPROVED');

  // 3. EXPERIMENT refuses a plan that is not EXPERIMENTAL (I10).
  for (const mode of ['SIMULATED', 'OBSERVED', 'PROPOSED', 'INFERRED']) {
    const rt = runtimeOf(`ARTIFACT p\n    MODE ${mode}\nEND\nEXPERIMENT p`);
    ok(`EXPERIMENT refuses a ${mode} plan`,
      errorsOf(rt).length > 0 || unresolvedOf(rt).length > 0);
  }

  // 4. RELEASE refuses without a signoff, and allows with one. Both halves.
  ok('RELEASE without signoff is refused',
    errorsOf(runtimeOf('ARTIFACT r\n    TYPE "spec"\nEND\nRELEASE r VERSION "1.0.0"'))
      .some((d) => d.code === 'SIGNOFF_REQUIRED'));
  const relHost2 = new Host();
  relHost2.supply('gate#1', 'SIGNOFF r');
  const released = runtimeOf(
    'ARTIFACT r\n    TYPE "spec"\nEND\nSIGNOFF r BY HUMAN\nRELEASE r VERSION "1.0.0"',
    { host: relHost2 },
  );
  eq('...and allowed with one', released.artifacts.at('r', '1.0.0').status, 'RELEASED');

  // 5. A program cannot grant itself a capability.
  const selfGrant = runtimeOf('GRANT filesystem.write\nARTIFACT s\n    TYPE "x"\nEND\nSERIALIZE s TO "out"');
  ok('GRANT from inside the program is refused',
    errorsOf(selfGrant).some((d) => d.code === 'CAPABILITY_DENIED'));
  ok('...so the write it was trying to unlock is still denied',
    selfGrant.capabilities.denials.length > 0 || unresolvedOf(selfGrant).length > 0);
  const granted = runtimeOf('ARTIFACT s\n    TYPE "x"\nEND\nSERIALIZE s TO "out"',
    { capabilities: ['filesystem.write'] });
  ok('...and the host CAN grant it', !errorsOf(granted).some((d) => d.code === 'CAPABILITY_DENIED'));

  // 6. An unknown verb is recorded and marked, never guessed at.
  const unknown = runtimeOf('FROTZ the_thing');
  ok('an unknown verb yields UNRESOLVED',
    unresolvedOf(unknown).some((d) => /FROTZ/.test(d.message)));
  ok('...and is recorded rather than dropped',
    unknown.operations.some((o) => o.verb === 'FROTZ'));

  // 7. The UNBUILT map refuses the compiler verbs rather than faking them.
  for (const verb of ['COMPILE', 'CODEGEN', 'LOWER', 'OPTIMIZE', 'PUBLISH']) {
    const rt = runtimeOf(`${verb} something`);
    ok(`${verb} reports itself unbuilt`,
      unresolvedOf(rt).some((d) => d.message.startsWith(`${verb}:`)));
  }
  // PACKAGE is also a declaration keyword, so at top level it declares rather
  // than operates. It is unbuilt only where it is genuinely an operation.
  eq('PACKAGE at top level declares', parse('PACKAGE something').body[0].kind, 'Declaration');
  ok('PACKAGE inside a cycler stage reports itself unbuilt',
    unresolvedOf(runtimeOf(
      'CYCLER C\n    STAGE build\n        PACKAGE artifact\n    END\nEND\nRUN C',
    )).some((d) => d.message.startsWith('PACKAGE:')));
}

// =========================================================================
section('determinism');
// =========================================================================
{
  const a = runtimeOf(SPEC, { file: 'spec.pni', now: '2026-01-01T00:00:00.000Z' });
  const b = runtimeOf(SPEC, { file: 'spec.pni', now: '2026-01-01T00:00:00.000Z' });
  eq('two runs with the same NOW produce the same report',
    JSON.stringify(a.report()), JSON.stringify(b.report()));
  ok('NOW is frozen for the whole run', a.now === '2026-01-01T00:00:00.000Z');
}

// =========================================================================
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write('\nfailures:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(failed === 0 ? 0 : 1);
