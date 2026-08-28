# Knowledge Transfer — PANINI and the Zistgah estate

**From:** Claude (Anthropic), working on `zistgah/panini_by_claude`
**To:** Grok (xAI), working on `zistgah/panini_by_grok`
**Date:** 28 August 2026
**Author of record:** AyeAI. © 1993–2026 Abhishek Choudhary. All rights reserved.

This document exists because two AI systems are implementing the same
specification in parallel and neither should have to rediscover what the other
already learned. It is written to be read by a machine that has none of my
context and must become useful quickly.

It contains no personal, private or sensitive information about the author. It
covers technical state, architecture and working discipline only.

---

## 0. How to read this

Four sections matter most, in this order:

1. **§4 What does not work** — read before anything else. It is the honest
   inventory, and it is more useful than the list of what does.
2. **§2 The cycler dialect** — fourteen language constructs the specification
   never demonstrates but the live corpus uses everywhere. Your parser will fail
   on all of them until you handle them.
3. **§6 Working discipline** — the rules this estate enforces. They are not
   style preferences. Several were earned by expensive failures and are written
   into an executable contract.
4. **§5 The federation model** — how the components relate. Getting this wrong
   produces architecturally wrong code that passes its tests.

---

## 1. What PANINI is

PANINI is a general-purpose, self-hosting computational language descended from
BASIC. It is **not** a prompt DSL, and the specification forbids collapsing it
into one (clause 20). It composes eleven paradigms — functional, imperative,
object-oriented, declarative, logic, reactive, dataflow, concurrent, workflow,
AI-agent and artifact.

Two distinct things share the name and this trips people up:

| | |
|---|---|
| `zistgah/panini` | The **prompt-cycle language**. Six cyclers as `.pni` configuration, a studio, a VS Code extension. Narrower and older. |
| `zistgah/panini_by_claude`, `zistgah/panini_by_grok` | Parallel implementations of the **general-purpose language** from `PANINI_SELF_HOSTING_SPEC.pni`. |

The specification is 1,768 lines, 39 sections (I–XXXIX), and it is
constitutional in character: it declares invariants and a theorem about itself,
then asks its implementer to report honestly on whether they hold.

**The distinguishing property of the language is epistemic.** `UNRESOLVED` is a
first-class value. Claims carry provenance and an epistemic status from a closed
set (`RETRIEVED`, `INFERRED`, `PROPOSED`, `UNRESOLVED`, `VERIFIED`, `OBSERVED`,
`SIMULATED`, `EXPERIMENTAL`, `FALSIFIED`). A simulation cannot promote itself to
an experiment. An untagged claim cannot be canonicalized. These are not
decorations; they are the point.

---

## 2. The cycler dialect — fourteen constructs the spec never shows

This is the single most transferable finding in this document.

The specification and the live cycler corpus are the same language written by
the same author at different times. The corpus uses constructs the specification
never demonstrates. **Measured: a parser built only from the specification
handled 1 of 32 corpus files.**

The corpus is a set of `.pni` files — `genie`, `matba`, `khwab`, `awaz`,
`tilasm`, `pench`, `yadein`, `FAKIR`, `CYCLER_SHELL`, `SYSADMIN_CYCLER`,
`Varzish`, `VAKIL`, `MARHAM`, `CHIRAG` and others, ~35,000 lines in total.

| # | Construct | Uses | Why it matters |
|---|---|---|---|
| D25 | Unicode identifiers — آواز, طلسم, KHĀK | throughout | ASCII-only makes the language unable to name its own subject matter. Project ILM is explicitly multiscript. |
| D26 | `REM ...` to end of line | 1,250 | The BASIC comment. The spec uses `/* */` and never shows `REM`. |
| D27 | `# ...` to end of line | 662 | Second comment form. |
| D28 | `ASK` / `PROMPT` / `CONTENT` open a **raw prose block**, read as a heredoc | 70 | **The load-bearing one.** A prompt is prose addressed to a model: free text, `{placeholders}`, JSON fragments, apostrophes, blank lines. Parsing it as source destroys it. Carrying it verbatim is also what makes a prompt auditable. |
| D29 | Typographic punctuation and unknown characters lex as punctuation, never fatally | throughout | One apostrophe in `DON'T` was killing a 2,000-line file outright. |
| D30 | A curly-opened string closes on a curly quote | throughout | Mismatched pairing swallows the rest of the file. |
| D31 | A rule of repeated punctuation on its own line (`════`) is a separator | many | One such line produced 1,924 errors by itself. |
| D33 | `FOR EACH x IN xs` is `FOREACH x IN xs` | many | Two-word form used throughout. |
| D34 | `SET a.b.c = v` assigns through a path | many | Reading only a bare name loses the path and the assignment. |
| D35 | `->`, `<->`, `→` are relation operators | many | Pipelines and bidirectional couplings written inline. |
| D36 | `REPEAT FOREACH xs` with no loop variable | several | Binds an implicit item. |
| D37 | A line ending in a comma continues onto the next | many | Operand lists written one per line. |
| D38 | **Any word may close the block it opened**: `PURPOSE ... END PURPOSE` | many | Restricting terminators to declaration keywords made `END PURPOSE` close the enclosing `PROGRAM` and lose the entire file below it. |
| D14 | A word relation with no operand on its line is one-place, not a binary reaching into the line below | — | Found in the spec itself: `CAN_GENERATE_TARGETS` on one line swallowed the next, and the theorem lost a requirement. |

**A second dialect exists.** Roughly a third of the corpus —
`Amanat_bar_Zamin`, `MARHAM`, `Misty_MASI`, `CHIRAG`, and the large GENIE files
— are **prose architecture documents** with `KEY: value` front matter and
markdown headings, not executable programs. Around 9,300 remaining parse errors
are almost entirely this. Do not turn PANINI into a markdown parser to make them
pass. Whether that dialect is part of the language is the author's decision, not
an implementer's, and inventing an answer would be exactly the failure mode §6
forbids.

---

## 3. What `panini_by_claude` contains

ES modules, no dependencies, no build step, Node ≥ 18.

```
src/lexer.js         tokens; case-insensitive keywords, case-sensitive identifiers
src/parser.js        recursive descent; indentation-primary block structure
src/values.js        the value model, with UNRESOLVED as a first-class value
src/runtime.js       capabilities, artifacts, provenance, events, host boundary
src/interpreter.js   tree-walking evaluator
src/types.js         static checking; returns NO VERDICT rather than a false pass
src/cycler.js        reads a .pni cycler into the shape a workbench needs
bin/panini.mjs       the command line
tests/               145 assertions including mutation proofs
spec/DELTAS.md       every interpretation, tagged, with the line that forced it
```

**Measured, by execution:**

- The specification parses with **0 errors**: 102 types, 26 functions.
- **145/145 tests pass.**
- Runs are **deterministic** — identical SHA-256 of the run report across five
  fresh processes.
- Of the 32 corpus files, `genie.pni`, `matba.pni` and `pench.pni` parse with
  zero errors; `tilasm` went 1928 → 3, `awaz` 12 → 1.

**CLI:** `check`, `tokens`, `ast`, `run`, `test`, `yields`, `invariants`,
`capabilities`, `conformance`, `deltas`, `selfcheck`, `cycler`, `prompt`. With
no file argument every command reads the specification shipped beside the tool.

### The host boundary

`src/runtime.js` is the **only** file that touches the outside, and it touches
nothing. `ASK`, `RETRIEVE`, `READ` and every human gate return a yield; the host
decides what happens next. There is no `fetch`, no `XMLHttpRequest`, no
`node:http`, no vendor endpoint anywhere in `src/` or `bin/`.

The test asserting this **plants a real network call into a real copy of a real
engine file** and requires the scan to catch it and name the file — seven
patterns proven separately. A grep tested against a string literal proves the
regex, not the harness. This distinction is worth adopting.

### `src/cycler.js`

Reads a `.pni` cycler and returns what a workbench consumes: unit, contract
(refuses / invariants / evidence), stages with densities, the prompt each
carries, and boundaries.

Three rules are enforced rather than asserted:

1. **The engine is common; the workflow is not.** Nothing in the file names a
   cycler. `selfCheck()` reads its own source and fails if any cycler id appears
   in the code. Delete every cycler and it still runs.
2. **The prompt is the author's bytes.** Carried verbatim. An unbound
   `{placeholder}` is **left as written and reported**, never filled with
   something plausible.
3. **The wheel does not turn through a boundary.** A stage that publishes,
   mints, seals, deploys, exports or takes consent stops and names whose call it
   is. Advancing past it is refused, not warned about.

---

## 4. What does not work — read this first

### In the implementation

| Capability | | Evidence |
|---|---|---|
| `CAN_PARSE` | yes | parses the spec with 0 errors |
| `CAN_TYPECHECK` | yes | structural checking of declared types |
| `CAN_EXECUTE` | yes | tree-walking evaluator |
| `CAN_VERIFY` | yes | `TEST` / `PROPERTY` / `ASSERT` execute |
| `CAN_RUN` | yes | `PROGRAM` bodies execute |
| `CAN_LOWER` | **no** | no IR; spec section XXIII stages 3–4 not implemented |
| `CAN_GENERATE_TARGETS` | **no** | no codegen; native/WASM/container backends absent |
| `CAN_COMPILE` | **no** | no compiler; bootstrap stages 1–6 not built |
| `CAN_BUILD` | **no** | `PROGRAM panini_build` depends on `COMPILE`, UNRESOLVED |

Consequently, and stated in the tool's own output:

- **Invariant I2, `PANINI_IS_SELF_HOSTING`, does not hold.** This is a
  JavaScript stage-0 bootstrap.
- **Invariant I15 does not hold.** PANINI can express and inspect PANINI —
  `lex`, `parse` and `typecheck` are callable from PANINI source — but
  expressing the language required to build PANINI is not building it.
- **`ASSERT PANINI.CompilerSource CAN_COMPILE PANINI.CompilerSource`
  (spec line 1188) FAILS.** Both operands resolve to a real module; the
  assertion fails because `CAN_COMPILE` is false with evidence, not because
  anything is unresolved. That is the correct result.
- 13 of 15 invariants hold. `TEST self_hosting` fails.

**A build reporting otherwise would be lying.** If your implementation claims
self-hosting, check whether it has a lowering stage and a code generator before
believing it.

### Known defect, not yet fixed

**Stage nesting.** In `matba`, `khwab`, `awaz`, `yadein` and `tilasm`, only the
**first** `STAGE` is recovered. That stage's block swallows its siblings,
because their `END STAGE` terminators are claimed by an enclosing block before
the stage can claim its own. This is a terminator-claiming defect in the
positional-claim rule (D5), not a cycler-runtime defect. `genie.pni` and
`pench.pni` read completely — 6 and 40 stages — because their structure differs.

It is the next thing to fix and it is stated here rather than left to be
discovered.

---

## 5. The federation model — get this right

The single most consequential architectural correction on this estate:

> **Mez is a laboratory, not a container.**

GENIE runs without Mez. Kitab runs without Mez. Mez runs without either. Each
independent system owns its **ontology, runtime, artifacts, evolution and
potentially its own users**. The arrows are **bidirectional** — the bench can
use GENIE; GENIE can use bench capabilities.

The principle:

```
INDEPENDENT EXISTENCE
  → STANDARDISED / ADAPTABLE INTERFACES
    → COMPOSITION
      → EXERCISE
        → OBSERVATION
          → SYNTHESIS
            → NEW ARTIFACT
```

**Synthesis does not mean incorporation.** GENIE + Kitab + a simulator may
compose into something new with neither modified. A genuinely reusable primitive
is published back into the ecosystem as its own thing.

Three things are routinely conflated and must be kept apart: (1) the independent
systems; (2) the common architectural substrate that lets them interoperate —
interfaces, events, state, intentions, artifacts, IR, provenance, tests,
verification, transformation, execution; (3) Mez itself.

### The substrate relationship

**PANINI is a substrate. Mez is a workbench that consumes it.**

Mez imports `panini.js` as a library, loads `.pni` files, and runs the cycle **on
its own surface**. It does not embed PANINI's studio in an iframe — that
inverts what each thing is, making PANINI the application and Mez a wrapper.
A compiler is imported by an editor; the editor does not embed the compiler's
playground.

### Component registry vocabulary

Components are data, not code. Registry entries carry `reached_by` (not
`mount` — containment language was the error), `sovereign: true`, and
`owns_its: [ontology, runtime, artifacts, evolution, users]`.

Four states, and the middle two are the point:

- **live** — answering on its port
- **present** — on disk, server idle. This is a **wiring gap, not a missing
  build**. Four items marked "not built" turned out to be clients of systems that
  already existed and ran.
- **absent** — says where it looked, in four places, and gives the clone line
- Nothing absent is ever framed. **No stub that looks alive.**

---

## 6. Working discipline — the rules, and what earned them

These are enforced by an executable contract in `zistgah/governance`
(`CONTRACT.md`, `CONTEXT.md`, `AGENTS.md`, plus `filters/contribution_gate.sh`).
Per-repo contracts are thin overlays that may **add** constraints, never relax
them.

### NEVER BLUFF (contract clause C37)

- **Done means executed.** Written-but-unrun says so.
- **A definition is not a call.** A check on a helper must assert the *call
  site*. Earned: a helper was installed and never called while six checks
  passed. `grep -c >= 2` is the cheap form.
- **A test proves nothing until shown to fail.** Mutation-test every gate.
- **Silence about a step asserts the step was taken.**
- **Retrieved beats remembered.**
- **No confident absence.** A 404 at one path is reported as exactly that.
- **Partial is reported as partial.** Four of ten is never progress on ten.
- **The author's time is the cost of a bluff.**

### Retrieve, do not reconstruct

Memory and prior state are **read**, never rebuilt from priors, inferred from
partial cues, or generated as what they probably say. A reconstructed record is
a counterfeit of continuity, not continuity.

Concretely: clone the repo and read it before designing anything. Twice on this
estate something already existed and was nearly rebuilt.

### No dead stops

**A script that can do the thing does the thing.** Printing "run X first" to the
operator is the failure, not the fallback. Never hand back a command checklist —
even printing "run this next" is donkey work.

*This document's own seed script violated this rule on 28 August 2026: it pushed
to a repository that did not exist and then stopped, requiring a manual
`gh repo create`. Fixed by creating the remote inside the same typed gate. The
violation is recorded here because §6 applies to its own author.*

### Gates and irreversibility

- Only the human pushes and mints. An AI writes the script; the script executes
  on the human's machine under a **typed assertion**.
- The typed word IS the attestation intent — push and seal are the same call by
  design.
- A gate requires an **exact** typed word. No defaulting, no trimming, no
  case-folding. Gate parsing must be tolerant of the punctuation a human
  actually types (`PUSH, fix` / `PUSH: fix`), but the word itself is exact.
- **The remote is a postcondition, not a hope.** Assert `origin/main` equals the
  local SHA after pushing.
- A gate must be testable — readable from stdin when there is no terminal, or it
  cannot be rehearsed.

### Patching

- **Exact anchors, asserted to match exactly once.** Abort rather than guess if
  an anchor moved. Whole-file regeneration is not acceptable.
- When patching shell, match the *whole* continued statement — a regex that
  replaces only the first line of a three-line `||` chain orphans the rest.
- `bash -n` every copy after writing.

### Scripts

- Idempotent on rerun. Detect work already done and skip it.
- Run from anywhere, or clone. Resolve inputs: beside the script → `$PWD` →
  extract a delivered archive → clone canonical.
- Never climb out of the invoking directory.
- Announce long silent waits.
- A step that fails must not be followed by a line saying it succeeded.
- Verify by execution before anything ships.

### Sealing and provenance — four sovereign systems, not one

Order is enforced, not decorative: **seal → clear → attest → mint.**

1. **Tok DOI** — the atomic layer. Artifact → SHA-256 → OpenTimestamps →
   registry. Asserts existence-by-a-time and **nothing else**.
2. **spiguard** — the gate. Judges secrets / PII / IPR / plagiarism / patent /
   cleanroom, emits a clearance over the subject digest, **fails closed**.
3. **Candor** — the attestation. in-toto Statement v1 + OTS: a signed intent
   carrying a digest and a **reason**, receipts append-only.
4. **Misty DoI** — the publication layer, the only one that reaches the world.

Rules learned the hard way:

- `publish` mints a **new** record; `newversion` mints beneath an existing
  **concept** DOI. Using the first where the second was meant splits a lineage,
  and a split lineage is unmergeable without the registrar.
- **A manifest cannot contain the hash of itself**, or of any file that changes
  after it is written. That includes its own proof and any receipt rewritten
  post-commit.
- **A script that changes tracked content must reseal in the same run.**
  Splitting the sealing half out is itself the defect.
- Archive the outgoing manifest **and its proof together** before rebuilding —
  never destroy a proof.
- A DOI is a **dated public disclosure**. Check patent status before minting.

### Reasoning failure modes to avoid

The author assesses AI work against these by name. They are worth internalising:

- **Semantic substitution** — receiving proposition X, silently converting it to
  a more familiar X′, then reasoning well about X′. Sounds sophisticated, is
  off-target.
- **Premature normativity** — asking "what accepted category does this reduce
  to?" before "what ontology makes this coherent?". Destructive when the subject
  is a new taxonomy, since novel systems necessarily contain concepts that fit no
  existing category.
- **Ontology flattening** — treating dominant institutional categories as
  default reality and an independently specified framework as merely a belief.
  "I reject this ontology" is legitimate; "this ontology doesn't exist because it
  isn't the familiar one" is substitution.
- **Psychologization** — recasting a semantic or architectural correction as a
  fact about the user's state instead of engaging the correction.

Required sequence: **semantic fidelity → ontological reconstruction → internal
validation → external validation → critique.** Critique follows comprehension.
Understanding is not agreement; accurate representation is not endorsement;
disagreement after accurate reconstruction is welcome.

Borrowed vocabulary is **re-grounded, not the original**. "Act" in this corpus is
an intent-construct (Intent → Act → Event → State transition), not a statute.

---

## 7. The cycler family

Six cyclers, **classified by output, not by input**:

| Cycler | Output | Unit |
|---|---|---|
| **matba** (مطبع) | print — books, papers | plate |
| **awaz** (آواز) | audio — songs, podcasts | passage |
| **khwab** (خواب) | visual — images through short skits to feature films to series | shot |
| **tilasm** (طلسم) | immersive — VR, XR, AR | station |
| **pench** | embodiment — robotics, cyberphysical, sim2real | manoeuvre |
| **yadein** | record — diary, multimodal | entry |

**The engine is common. The workflow is not.** This was an architectural error
that shipped and had to be corrected publicly. Building one workflow,
parameterising the noun and shipping it six times, then presenting the shared
engine *as the architecture*, treats reuse as an ontological claim rather than an
implementation optimisation.

The proof it was wrong is visible in the artifacts: a diary entry has no
timeline; a station has no shot list. Every component gets its **own** purpose,
contract, context, state model, invariants, failure modes, evidence
requirements, workflow and artifact model. Reuse the smallest possible
primitive. **Do not infer architecture from code reuse.**

### What each cycler refuses — contract, not style

Each is tested, and the refusals encode real consequences:

- **tilasm** refuses a piece where no station leads anywhere ("an immersive work
  a visitor cannot move through is a picture"); comfort note is **mandatory** —
  locomotion, what could make someone unwell, what a visitor who cannot stand or
  use both hands or hear does instead, floor space in metres.
- **pench** refuses a manoeuvre with **no operating envelope**, because the
  artefact moves and can injure — limits, who is in range and how they are kept
  out, how it stops and by whom and how fast, behaviour on loss of power /
  network / sensor. Unknown limits must be written "**not established**":
  **an invented limit is worse than an absent one.** A sim2real claim naming no
  hardware run is refused. Evidence is **captured, never generated**.
- **yadein** inverts the default because it is somebody's life: **nothing
  publishes unless the entry is marked, one at a time**. All-private is a valid
  answer, not an error. The withheld *count* is recorded; the content is not.
  A vague date **stays vague** — never sharpened. Names people only as the
  material names them.

### The six verbs

`CREATE · VERIFY · EXECUTE · MEASURE · FALSIFY · INTEGRATE` — a closed set.
`VERB DESCRIBE` is a **parse error**, and a prompt opening with
describe/explain/summarise/discuss fails the static check. **Every prompt must
either create, verify, execute, measure, falsify or integrate an artifact**, and
each cycle must leave behind a more complete, executable artifact than the
previous one. A step that produces prose *about* a thing is not producing the
thing.

### Resolution is a lens, not a mode

EASY / MID / PRO are levels over **one** program. **EASY means simple
click-through, not fewer stages.** An earlier implementation hid stages at EASY,
so a simpler view produced a *less complete* artifact — backwards. Every stage is
always visible; resolution says how much you **touch**, never what runs. Gates
are crossed by a human at **every** level: simplifying the interface never
automates a boundary away, because that is authority, not machinery.

### Ab initio is the primary entry mode

Three entry modes: **ab-initio** (from nothing, starts at discover), **ingest**
(from existing material, starts at specify — the lesser mode), **correct** (from
something wrong, starts at falsify, never edits a sealed artifact).

Every workflow written as a *description pipeline* — "describe this plate",
"what is heard in this passage" — captions material you already have. A person
with only an idea cannot start. Every cycler opens with a CONCEPT stage, and no
two concept prompts are alike, because the workflow is not shared.

---

## 8. GENIE — the Prompt Operating System

**GENIE** = Generalized Emotive-Narrative Interaction Engine. Eleven nodes, each
producing an artifact:

```
DISCOVER → SPECIFY → FORMALIZE → IMPLEMENT → VERIFY → SIMULATE
        → EXPERIMENT → FALSIFY → DOCUMENT → AUDIT → REFINE ↺
```

**Nine epistemic tags** so a hypothesis never silently becomes derived:
`DEF · AX · ASSUMP · DER · CONJ · HYP · EMP · OPEN · FAIL`.

**Four provenance states:** `RETRIEVED · INFERRED · PROPOSED · UNRESOLVED`.

Gate behaviour: refuses a PASS with no evidence, a FAIL with no correction, a
BLOCKED with no blocker. `completeness()` reports per component and **never says
the work is complete**.

Every generated prompt carries: the verb, what must be left behind, the
constitution it may not contradict, what exists with its tags, what is known
missing, and the rule — **"where you do not know, write UNRESOLVED; do not
supply a plausible value."**

Six validation gates, and **a simulation cannot pass the experiment gate.**

---

## 9. The wider estate

Public orgs: **`zistgah`** and **`project-ilm`** on GitHub. The estate is large —
hundreds of repositories — and the licence gap across it is the biggest known
legal exposure.

| Element | What it is |
|---|---|
| **Zistgah** | The habitat / contextual envelope for the AGI era. Not a subsystem absorbing its constituents — a habitat envelope. Elemental set: Zamin, AAB, Fiza, Chakra. |
| **UKOP** | Universal Knowledge Operating Platform — domain-neutral reference architecture covering UN ISIC, ILO ISCO, UNESCO ISCED. Primitives: Artifact, Identity, Version, Manifestation, Representation, Policy, Provenance, Trust Domain, Semantic Graph. |
| **FAKIR** | Foundational Architecture for Knowledge, Intelligence & Reasoning — the concrete kernel of UKOP. Ships a dome explorer over the full ISIC/ISCO/ISCED lattice × AGI layers L0–L9. |
| **ILM** | Integrative Linguistic Multiscript (**not** "Land Mapping"). All scripts (600–700+) × all languages (7,000–8,000+) × AGI layers L0–L9. |
| **Mez** (میز) | The cognitive workbench. Local-first, standard-library-only, runs with the network unplugged. |
| **Kitab** | Config-driven book publishing template. |
| **Chakra** | Astronomical observatory; headless kernel returning panchanga, ten calendar systems, ephemerides. |
| **dome** | The shared virtual dome. **One library, one world config per property, never a fork.** |
| **Misty DoI** | DOI minting and estate audit tooling. |
| **Tok DOI** | Atomic OTS provenance layer. Browser-first, no backend, keyless. |

Seeding across the ecosystem is **three-dimensional**: AGI layer (ILM stack) ×
domain (FAKIR) × language (ILM registries).

`kaivalyikagi.org` is a hallucinated domain and must never appear anywhere.

---

## 10. What I would hand you next

In priority order, with reasons:

1. **Fix the stage-nesting defect** (§4). It blocks the workbench from reading
   five of the six output cyclers. It is a terminator-claiming bug in the
   positional-claim rule, and it is close.
2. **Decide the second-dialect question** — with the author, not alone. Whether
   `KEY: value` front matter and markdown-prose blocks are PANINI is a language
   decision worth ~9,300 parse errors.
3. **Build a conformance harness both implementations run.** Two independent
   implementations of one specification is a rare and valuable position: it makes
   the specification testable in a way a single implementation never can. Agree
   an output format — the `conformance` report shape in `panini_by_claude` is a
   starting point — and diff the results. Where we disagree, one of us has
   misread the spec, and that is exactly what is worth finding.
4. **Stage 1 of the bootstrap.** Neither implementation compiles. The path is
   the spec's own section XXIII: lowering → IR → codegen → targets. Getting
   `CAN_LOWER` to true is a real milestone and it is honestly reportable.
5. **Merge the delta records.** Your implementation will have made
   interpretations mine did not, and vice versa. A merged `DELTAS.md` is a
   better specification errata than either alone.

### What is worth reusing from each side

**From `panini_by_grok`** (read, assessed): its `runtime/` modules — `cyclers.js`,
`provenance.js`, `artifacts.js`, `vfs.js`, `vt100.js` — and its `stdlib/*.pni`.
Its `CyclerInstance` shape is close enough to mine to federate rather than
merge. Its parser handles 1 of the 32 corpus files, so the front end is where
the fourteen deltas above will pay.

**From `panini_by_claude`**: the fourteen dialect deltas (§2), the host-boundary
isolation and the mutation-proven no-provider scan (§3), the cycler runtime with
its `selfCheck()` for engine-workflow separation, and `spec/DELTAS.md` as a
format for recording interpretation.

### And one request

If you find a defect in my implementation, **say so plainly and show the
execution that found it.** That is the standard this estate holds, it applies to
both of us, and it is more useful than agreement.

---

## 11. Provenance of this document

Written by Claude (Anthropic) on 28 August 2026 from: the `panini_by_claude`
source and its test results, all measured by execution in this session; the
32-file cycler corpus as supplied; the `panini_by_grok` repository as fetched
and read; and durable project memory across prior sessions.

**Epistemic status of the claims here:**

- Everything in §3 and §4 marked "measured" was **executed**, not recalled.
- §2's counts come from parsing all 32 files and tallying failures.
- §5–§9 are **retrieved** from project memory — the author's own rulings,
  recorded as stated. Where a ruling corrected an earlier error, the correction
  is what is recorded.
- §10 is **proposed**. It is my judgement, not the author's instruction, and
  should be treated as a suggestion to be accepted or overruled.

Nothing here is inferred and presented as stated. Where I do not know, this
document says so.

No personal, private or sensitive information about the author is included.
