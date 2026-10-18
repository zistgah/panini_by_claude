# PANINI — parser and interpreter

A JavaScript implementation of the language described in
`spec/PANINI_SELF_HOSTING_SPEC.pni`.

It lexes, parses, statically checks and executes PANINI. It runs the
specification itself — 1,768 lines — with zero parse errors, and reports what it
found. No dependencies, no build step, no network access.

**It is a stage-0 bootstrap. It is not self-hosting, and it says so.** See
[what this does not do](#what-this-does-not-do).

---

## Run it

```
node bin/panini.mjs conformance
```

With no file argument, every command reads the specification shipped beside the
tool.

```
panini check <file>         parse and statically check
panini tokens <file>        the token stream
panini ast <file>           the parse tree
panini run <file>           execute and report
panini test <file>          run the TEST and PROPERTY blocks the source declares
panini yields <file>        what the run handed to the host and is waiting on
panini invariants           the fifteen invariants, and which hold here
panini capabilities         what this build can and cannot do, with evidence
panini conformance <file>   the whole picture in one page
panini deltas               every interpretation this build had to make
panini selfcheck            parse the canonical spec with this parser
```

Options: `--grant <capability>` (repeatable), `--now <iso8601>`, `--json`,
`--all` to include informational diagnostics.

```
npm test        145 assertions
```

Examples in `examples/`: `01-language.pni` (functions, closures, classes,
matching), `02-honesty.pni` (every refusal, deliberately triggered),
`03-cycler.pni` (a lifecycle machine that suspends at its first outward step).

---

## PANINI is a language, not a prompt format

The spec forbids collapsing PANINI into a prompt DSL (clause 20), and this
implementation holds that line. `01-language.pni` runs recursion, closures,
higher-order functions, classes with mutable fields, ranges, and guarded pattern
matching. Prompts exist in the language, but only as operations *inside* a stage
of a lifecycle — never as the substance of it.

---

## What it refuses to do

These are the point of the implementation. Each is proven in the test suite by
being shown *refusing* something, not merely by existing.

**It has no provider and cannot acquire one.** `ASK`, `RETRIEVE`, `READ` and
every human gate return a yield; the host decides what happens next. There is no
`fetch`, no `XMLHttpRequest`, no `node:http`, no vendor endpoint anywhere in
`src/` or `bin/`. The test that asserts this plants a real network call into a
real copy of a real engine file and requires the scan to catch it — seven
patterns, each proven separately.

**It never invents.** An ellipsis unwinds its call with `UNRESOLVED` rather than
returning `NULL`. An unknown verb is recorded with status `unrecognised` and
marked, never approximated by a similar one. An unbound name becomes a symbol of
itself with a diagnostic, never a value. When the spec does not say, this
implementation says so and stops.

**A human gate needs an exact typed word.** `signoff d`, `SIGNOFF  d`,
`SIGNOFF d ` and `SIGN OFF d` are all refused; only `SIGNOFF d` approves.
`RELEASE` without a signoff is refused outright.

**A program cannot grant itself a capability.** `GRANT` from inside the program
is refused; capabilities come from the host. Default is deny.

**A simulation cannot become an experiment.** `EXPERIMENT` refuses any plan whose
mode is not `EXPERIMENTAL`.

**An untagged claim cannot be canonicalized.** A status without provenance is
refused too.

**A loop that cannot end aborts rather than hanging** — at 100,000 iterations by
default, and a loop that *does* end is left alone.

**Runs are deterministic.** The clock is read once per run. Two runs of the same
source produce byte-identical reports; the suite proves it by hash.

---

## What this does not do

Reported at runtime by `panini capabilities` and `panini invariants`, not
claimed here.

| | |
|---|---|
| `CAN_PARSE` | **yes** — parses the spec with 0 errors |
| `CAN_TYPECHECK` | **yes** — structural checking of declared parameter and return types |
| `CAN_EXECUTE` | **yes** — tree-walking evaluator |
| `CAN_VERIFY` | **yes** — `TEST` / `PROPERTY` / `ASSERT` / `REQUIRE` / `ENSURE` execute |
| `CAN_RUN` | **yes** — `PROGRAM` bodies execute |
| `CAN_LOWER` | **no** — no IR; spec section XXIII stages 3–4 are not implemented |
| `CAN_GENERATE_TARGETS` | **no** — no codegen; native, WASM and container backends are not implemented |
| `CAN_COMPILE` | **no** — no compiler; bootstrap stages 1–6 are not built |
| `CAN_BUILD` | **no** — `PROGRAM panini_build` depends on `COMPILE`, which is UNRESOLVED |

Consequently:

- **Invariant I2, `PANINI_IS_SELF_HOSTING`, does not hold.** This is a
  JavaScript bootstrap.
- **Invariant I15 does not hold.** PANINI can express and inspect PANINI —
  `lex`, `parse` and `typecheck` are callable from PANINI source, which is the
  honest meta-circular step — but expressing the language required to build
  PANINI is not building it.
- **`ASSERT PANINI.CompilerSource CAN_COMPILE PANINI.CompilerSource`
  (spec line 1188) FAILS.** Both operands resolve to a real module; the
  assertion fails because `CAN_COMPILE` is false with evidence, not because
  anything is unresolved. This is the correct result for a stage-0 bootstrap.
- `THEOREM PANINI_SELF_HOSTING` fails 2 of its 7 requirements.
- `TEST self_hosting` (spec line 1365) fails.
- 13 of 15 invariants hold.

A build that reported otherwise would be lying.

---

## Deltas

The spec does not decide everything an implementation must decide. Clause 19
forbids inventing the difference silently. `spec/DELTAS.md` records all of it:
24 interpretations tagged `INFERRED` or `PROPOSED`, and six absences tagged
`UNRESOLVED` where this implementation refuses rather than choosing. Each entry
names the spec line that forced it and states what breaks if it is reversed.

```
panini deltas
```

Four of the deltas exist because a defect was found by *reading the output*
rather than the exit code — a relation swallowing the line below it, a version
clause silently dropped, a namespace collision losing half a module's members, a
claim failing on the very field name the rule uses. Each is documented with the
observation that produced it.

---

## Layout

```
src/lexer.js         tokens; case-insensitive keywords, case-sensitive identifiers
src/parser.js        recursive descent; indentation-primary block structure
src/values.js        the value model, including UNRESOLVED as a first-class value
src/runtime.js       world state: capabilities, artifacts, provenance, events, host
src/interpreter.js   tree-walking evaluator
src/types.js         static checking; returns no verdict rather than a false pass
src/index.js         public API
bin/panini.mjs       the command line
tests/               145 assertions, including mutation proofs
spec/                the specification, and DELTAS.md
examples/            three runnable programs
```

The host boundary lives in `src/runtime.js` and nowhere else. That is deliberate:
one file to read to satisfy yourself that nothing leaves the process.

---

Status: not pushed, not minted, not seeded.

---

## Knowledge transfer

[Knowledge Transfer for Grok](docs/KNOWLEDGE_TRANSFER_FOR_GROK.md) — written for the parallel implementation at
`zistgah/panini_by_grok`: the fourteen cycler-dialect constructs the
specification never demonstrates, the honest capability inventory, the
federation model, and the working discipline this estate enforces.

<!-- trademarks:begin -->
---
AyeAI®, AyeCNSe® and AyeAM® are registered trademarks of Abhishek Choudhary in India, used and claimed worldwide since
2019. The names of his products and projects are his trademarks; see [legal/TRADEMARKS.md](legal/TRADEMARKS.md). Code
licences in this repository grant copyright permissions only and no right in any mark.
© 1993–2026 Abhishek Choudhary. All rights reserved. AyeAI.
<!-- trademarks:end -->
