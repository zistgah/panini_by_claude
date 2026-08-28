# DELTAS

Every point at which `PANINI_SELF_HOSTING_SPEC.pni` did not decide something this
implementation had to decide.

Spec clause 19 forbids silently inventing missing canonical material. This file is
the discharge of that clause: each entry names the spec line that forced the
decision, states what was decided, tags it, and says what would break if it were
decided otherwise. Nothing here is a preference. Every entry is load-bearing —
remove it and either the spec stops parsing or it parses into something it does
not say.

Tags:

- **INFERRED** — the spec's own text determines the answer, but does not state it
  as a rule. Reversing it contradicts the spec.
- **PROPOSED** — the spec is silent and something had to be chosen. Reversing it
  is a legitimate design choice the author may take.
- **UNRESOLVED** — the spec is silent, and this implementation refuses rather
  than choosing. These are not decisions; they are recorded absences.

---

## Lexical

### D1 — keywords are case-insensitive, `INFERRED`

Spec line 1: the language descends from BASIC. Line 173 writes `keyword` in the
grammar with no case rule. A BASIC that is not case-insensitive in its keywords
is not a BASIC, and the spec mixes `END`/`End` nowhere but never forbids it.

Decision: keyword matching is on the upper-cased form.

Reversed: nothing in the current spec breaks, because the spec is uniformly upper
case. This is the entry most likely to be a matter of taste.

### D2 — identifiers are case-sensitive, `INFERRED`

Spec line 929 declares `sovereign:Sovereign` — a parameter and a type
distinguished only by case. Case-insensitive identifiers make that line
self-referential and the type system unusable.

Decision: identifiers compare byte-for-byte. Only keywords fold case.

### D3 — `""` is the escape for a quote inside a string, `INFERRED`

Spec line 1319, inside the Dockerfile `CONTENT` block, contains doubled quotes
where a single quote is meant. No backslash escape appears anywhere in the file.

Decision: `""` inside a string yields one `"`. There is no backslash escape.

Reversed: the Dockerfile content in section XXXII is corrupted.

### D4 — every token carries its column indent, `PROPOSED`

Required by D6 and D7 below. The spec's grammar (line 173) says
`block := KEYWORD [name] [parameters] BODY END` and shows no indent rule, but the
file is written entirely in indented blocks and several of them have no `END`.

### D10 — whitespace separates a call from a list-valued property, `INFERRED`

Spec line 683 writes `CAPABILITIES ["language", "reasoning"]` — a property whose
value is a list. Spec line 986 writes `realize(state:SemanticState, ...)` — a call. Both
are `WORD` followed by a bracket.

Decision: no space before the bracket makes it a call or an index; a space makes
it a property with a list value.

Reversed: every `CAPABILITIES [...]` line in the file becomes an index expression
into an unbound name.

---

## Block structure

### D5 — explicit `END` terminators are claimed positionally, `INFERRED`

Spec grammar line 173 gives `END` as the block terminator, and the file uses both
`END` and `END <KEYWORD>` and `END <KEYWORD> <name>`.

Decision: `END` tokens are pre-scanned and matched to headers by position. A
header claims the first unclaimed `END` at or below its own indent.

### D6 — an indented statement after a header opens a block, `INFERRED`

Spec lines 1657–1687 (`THEOREM`) contain `GIVEN`, `DEFINE`, `REQUIRE` and
`CONCLUDE` sections with no `END` of their own; only the theorem has one.

Decision: a header whose following statement is more indented opens a block even
with no `END`.

### D7 — a dedent closes an unterminated block, `INFERRED`

The consequence of D6. `INVARIANT` blocks (lines 1600–1655) and the theorem's
four sections close by dedent.

### D8 — an `END` below the header's indent belongs outward, `INFERRED`

Without this, the first `END` after a `THEOREM` section is taken by the section
and the theorem is left unterminated for the rest of the file.

### D9 — `MODULE` and `PACKAGE` bodies parse as statements, `PROPOSED`

Every other declaration form parses its body as properties, fields and nested
declarations. `MODULE PANINI` (line 20) is the whole file; its body contains
executable statements (`FOR`, `WHILE`, `MATCH`, `ASSERT`) as well as declarations.

Decision: namespace-bearing declarations parse their bodies as statements;
everything else parses as a declaration body.

Consequence: a property line inside a `MODULE` arrives as an operation. See D13.

---

## Names and namespaces

### D11 — a second declaration of an existing name merges into it, `INFERRED`

The spec declares `MODULE PANINI` (line 20), `BOOTSTRAP PANINI` (line 1201) and
`PACKAGE PANINI` (line 1284) — one name, three declarations. It then reads
`PANINI.CONSTITUTION` (line 1533, a module member) and `PANINI.VERSION`
(line 1285, a package field) as though a single namespace held both.

Decision: a declaration whose name is already bound to a record merges its fields
into that record rather than shadowing it. The collision is reported as an
`info/name-collision` diagnostic, never hidden.

Reversed: `PANINI.CONSTITUTION` at line 1533 resolves against the package and
fails. Observed before this rule was added; three collisions occur in the spec.

### D12 — an unnamed declaration is reachable by its keyword, `INFERRED`

`CONSTITUTION` (line 22) has a body and no name. `PANINI.CONSTITUTION`
(line 1533) reads it as a member of the enclosing module.

Decision: a declaration with a body and no name registers under its keyword.

### D13 — a property line in a `MODULE` body is a property, `INFERRED`

Consequence of D9. `MODULE ILM` (line 983) contains `PURPOSE "Integrative
Linguistic Multiscript representation."` — plainly a documentation property, but
D9 delivers it as an operation with the verb `PURPOSE`.

Decision: inside a `MODULE`, an all-caps verb with a single literal operand that
is not a verb this runtime executes is read as a property, exactly as every other
declaration form already reads it.

Guard: the set of verbs the runtime executes is derived from the operation
dispatch itself (`KNOWN_VERBS`), so this rule cannot silently start swallowing a
real operation if one is added later.

---

## Expressions

### D14 — a word relation with no operand on its line is one-place, `INFERRED`

Spec line 1680 is `PANINI_COMPILER CAN_GENERATE_TARGETS` — a relation with one
argument. Line 1681 immediately below is `PANINI_RUNTIME CAN_EXECUTE PANINI`.

Decision: when a word operator is not followed by an operand on its own line, it
is a one-place relation, not a binary reaching into the line below.

Reversed: `CAN_GENERATE_TARGETS` swallows line 1681, the `REQUIRE` section of
`THEOREM PANINI_SELF_HOSTING` reports six requirements instead of seven, and the
theorem is evaluated against a requirement the spec did not write. Observed.

### D15 — `VERSION` introduces a clause, `INFERRED`

Spec line 420 is `RELEASE architecture VERSION "1.1.0"`.

Decision: `VERSION` joins the prepositional clause introducers.

Reversed: `VERSION` is read as a bare operand, the version string is dropped, and
`RELEASE` mutates the artifact in place instead of producing a new released
version at that version number. Observed.

---

## Execution

### D16 — `CONTENT` is preserved byte-for-byte, `INFERRED`

Spec lines 1306–1340 embed a Dockerfile and a CI workflow. I7 requires that file
blocks keep semantic MIME and content.

Decision: `CONTENT` is dedented uniformly by the block's own minimum indent and
otherwise untouched. No unquoting, no interpolation, no trailing-whitespace
trimming.

### D17 — an unbound name is a self-denoting symbol, and says so, `PROPOSED`

The spec uses many names it never binds (`collection` line 220, `condition`
lines 224 and 228, `predicate` line 252) as illustrations of syntax.

Decision: an unbound name evaluates to a symbol of itself and emits an
`info/unbound` diagnostic. It does not throw, and it does not become `NULL`.

Reversed: the spec cannot be executed at all, because its syntax illustrations
are not programs.

### D18 — a loop whose guard is unbound is not entered, `INFERRED`

`WHILE condition` (line 224) with `condition` unbound would otherwise spin to the
iteration limit and emit 100,000 identical diagnostics.

Decision: a loop whose guard evaluates to an unbound symbol is marked UNRESOLVED
and not entered. A loop with a *bound* guard runs normally and aborts at the
iteration limit — that limit is proven to bite in the test suite.

### D19 — an ellipsis ends the enclosing call with UNRESOLVED, `INFERRED`

`...` appears throughout as "behaviour not specified here". A function whose body
is `...` must not return `NULL`, because `NULL` is a value the spec never
promised.

Decision: reaching `...` inside a call unwinds that call with UNRESOLVED. At
declaration level there is nothing to return from, so it is marked and the next
declaration is read.

### D20 — an untagged operation is recorded, never guessed, `INFERRED`

Spec clause 19.

Decision: a verb with no execution rule is recorded in the operation log with
status `unrecognised` and yields UNRESOLVED naming the verb. It is never
approximated by a similarly-named verb.

### D21 — `NOW` is frozen for the duration of a run, `INFERRED`

`REPRODUCIBILITY` is a stated constitutional principle (line 22 block) and I14
requires deterministic runs.

Decision: the clock is read once at runtime construction. Two runs of the same
source produce byte-identical reports. Proven by hash across five processes in
the test suite.

### D22 — `RULE` bodies are recorded, not auto-enforced, `PROPOSED`

The spec declares rules (lines 3 in section XI) but never says when they fire.

Decision: a `RULE` is stored with its condition and consequence and is available
for inspection. Nothing evaluates it on its own initiative.

Reversed: rules would fire at points the spec does not name, which is invention.

### D23 — the artifact state sequence is quoted from the spec, `INFERRED`

The sequence `DRAFT → REVIEW → APPROVED → RELEASED → SUPERSEDED | ARCHIVED` is
stated in the spec's own comment at lines 431–437. It is not inferred; it is
transcribed, and transitions outside it raise `VALIDATION_ERROR`.

### D24 — a claim's provenance may be written `SOURCE` or `PROVENANCE`, `INFERRED`

`RULE CANONICAL_OUTPUT` (spec lines 463–466) requires
`every_statement.provenance IS_NOT NULL`. The spec's own `CLAIM` form
(lines 457–461) supplies that provenance under the name `SOURCE`.

Decision: `SOURCE`, `PROVENANCE` and `DERIVED_FROM` each establish a claim's
provenance. A status tag alone never does.

Reversed: a claim written with the name the rule itself uses fails
canonicalization, and reports a missing provenance the author did in fact
supply. Both halves are proven in the test suite — a claim with neither is still
refused.

---

## Recorded absences — decided by refusing

These are `UNRESOLVED`. The implementation reports them and stops. It does not
choose.

| # | Spec | What is missing |
|---|---|---|
| U1 | line 1301 | `FILE "README.md"` is `GENERATE_FROM PANINI.DOCUMENTATION`. No `DOCUMENTATION` is declared anywhere in the file. The README is therefore not generated. |
| U2 | lines 567–569 | `PARALLEL` runs `test_unit`, `test_integration` and `test_security`. None of the three is declared. |
| U3 | lines 671–673 | `RESOLUTION EASY` / `MID` / `PRO` appear at module level with no semantics given anywhere. Recorded, not performed. |
| U4 | line 1357 | `PROPERTY compiler_idempotence` quantifies over `valid_panini_sources`, which is never established. The property therefore asserts nothing, and reports `EMPTY` with that reason rather than `PASS`. |
| U5 | line 252 | `CASE x WHEN predicate(x)` — `predicate` is never bound, so it is not callable. |
| U6 | section XXIII | Compiler stages 3–6: lowering, IR, codegen, targets. Not implemented, and reported as not implemented. See below. |

---

## What this implementation does not do

Not deltas — absences of capability, reported by `panini capabilities` and
`panini invariants` at runtime rather than claimed here.

| Capability | Status | Evidence |
|---|---|---|
| `CAN_PARSE` | yes | parses the spec with 0 errors |
| `CAN_TYPECHECK` | yes | structural checking of declared parameter and return types |
| `CAN_EXECUTE` | yes | tree-walking evaluator |
| `CAN_VERIFY` | yes | `TEST` / `PROPERTY` / `ASSERT` / `REQUIRE` / `ENSURE` execute |
| `CAN_RUN` | yes | `PROGRAM` bodies execute |
| `CAN_LOWER` | **no** | no IR; spec section XXIII stages 3–4 are not implemented |
| `CAN_GENERATE_TARGETS` | **no** | no codegen; native, WASM and container backends are not implemented |
| `CAN_COMPILE` | **no** | no compiler; bootstrap stages 1–6 are not built |
| `CAN_BUILD` | **no** | `PROGRAM panini_build` depends on `COMPILE`, which is UNRESOLVED |

Consequently:

- **I2 `PANINI_IS_SELF_HOSTING` does not hold.** This is a stage-0 bootstrap
  written in JavaScript.
- **I15 does not hold.** PANINI can express and inspect PANINI — `lex`, `parse`
  and `typecheck` are callable from PANINI source — but expressing the language
  required to build PANINI is not building it.
- **`ASSERT PANINI.CompilerSource CAN_COMPILE PANINI.CompilerSource`
  (spec line 1188) FAILS.** Both operands resolve to a real module. The assertion
  fails because `CAN_COMPILE` is false with evidence, not because anything is
  unresolved. This is the correct result for a stage-0 bootstrap, and a build
  that reported otherwise would be lying.
- `THEOREM PANINI_SELF_HOSTING` fails 2 of its 7 requirements.
- `TEST self_hosting` (spec line 1365) fails.

---

## The cycler dialect — deltas D25–D38

The self-hosting specification and the live cycler corpus are the same language
written by the same hand at different times. The corpus uses constructs the
specification never demonstrates. Each was found by parsing all 32 files and
reading the failures.

| # | What | Uses in corpus | Tag |
|---|---|---|---|
| D25 | Identifiers admit any Unicode letter (آواز, طلسم, KHĀK) | throughout | INFERRED |
| D26 | `REM ...` to end of line — the BASIC comment | 1,250 | INFERRED |
| D27 | `# ...` to end of line | 662 | INFERRED |
| D28 | `ASK` / `PROMPT` / `CONTENT` open a raw prose block, read as a heredoc, bytes exact | 70 | INFERRED |
| D29 | Typographic punctuation and unknown characters lex as punctuation, never fatally | throughout | PROPOSED |
| D30 | A curly-opened string closes on a curly quote | throughout | INFERRED |
| D31 | A rule of repeated punctuation on its own line is a separator | many | INFERRED |
| D33 | `FOR EACH x IN xs` is `FOREACH x IN xs` | many | INFERRED |
| D34 | `SET a.b = v` assigns through a path | many | INFERRED |
| D35 | `->`, `<->`, `→` are relation operators | many | PROPOSED |
| D36 | `REPEAT FOREACH xs` with no loop variable binds `item` | several | INFERRED |
| D37 | A line ending in a comma continues onto the next | many | INFERRED |
| D38 | Any word may close the block it opened: `PURPOSE ... END PURPOSE` | many | INFERRED |

D28 is the load-bearing one. A prompt is prose addressed to a model — free text,
`{placeholders}`, JSON fragments, apostrophes, blank lines. Reading it as PANINI
source destroyed it. It is now carried verbatim, which is also what makes a
prompt auditable: what the model is asked is what the author wrote.

D29 was a judgement. One apostrophe in `DON'T` was killing a 2,000-line cycler
outright. A character with no lexical rule is now punctuation and is recorded,
not fatal.

**Measured on the 32-file corpus:** `genie.pni`, `matba.pni` and `pench.pni`
parse with zero errors. `tilasm` 1928 to 3, `awaz` 12 to 1, `yadein` 19 to 12,
`khwab` 31 to 24. The remaining ~9,300 errors are almost entirely a **second,
documentary dialect** — `Amanat_bar_Zamin`, `MARHAM`, `Misty_MASI`, `CHIRAG` and
the large GENIEs are prose architecture documents with `KEY: value` front matter
and markdown headings. PANINI has not been made a markdown parser; that is a
language decision for the author, not a defect to paper over.

## Known incomplete — `src/cycler.js` stage nesting

`genie.pni` and `pench.pni` read completely: 6 and 40 stages, contract, prompts,
boundaries. In `matba`, `khwab`, `awaz`, `yadein` and `tilasm` only the FIRST
`STAGE` is recovered — that stage's block swallows its siblings, because their
`END STAGE` terminators are claimed by an enclosing block before the stage can
claim its own. This is a terminator-claiming defect in the parser (rule D5), not
a cycler-runtime defect, and it is the next thing to fix. It is stated here
rather than left for you to discover.
