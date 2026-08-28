// PANINI parser — recursive descent over the token stream.
//
// The spec file closes blocks in three different ways, and all three are real:
//   (a) explicit `END <KEYWORD> [name]`   — `END FILE`, `END MODULE PANINI`
//   (b) bare `END` at or below the header's indentation
//   (c) dedent with no END at all        — INVARIANT, and THEOREM's GIVEN/DEFINE/
//                                          REQUIRE/CONCLUDE sections
// So block structure is indentation-primary with explicit terminators overriding it.
// See spec/DELTAS.md D5-D9 for every rule below and why it is what it is.

import { T, lex, heredoc } from './lexer.js';

export class ParseError extends Error {
  constructor(message, tok) {
    super(`${message} (line ${tok ? tok.line : '?'}, col ${tok ? tok.col : '?'})`);
    this.name = 'ParseError';
    this.line = tok ? tok.line : 0;
    this.col = tok ? tok.col : 0;
  }
}

// Declaration keywords: constructs that introduce a named thing.
// Keywords whose body is prose, read verbatim as a heredoc.
// D28, narrowed. SYSTEM, USER and TEXT are ordinary property words throughout
// the corpus ("OUTPUT TEXT", "USER consent"); treating them as raw-text openers
// let one of them swallow an entire file. Only ASK, PROMPT and CONTENT open
// prose, and only when they open a block at all.
export const RAW_BLOCK_KEYWORDS = new Set(['CONTENT', 'ASK', 'PROMPT']);

export const DECL_KEYWORDS = new Set([
  'MODULE', 'PACKAGE', 'FUNCTION', 'PROCEDURE', 'CLASS', 'TRAIT', 'INTERFACE',
  'TYPE', 'SCHEMA', 'CONSTRAINT', 'ENUM', 'CONFIGURATION', 'FILE', 'ARTIFACT',
  'DELIVERABLE', 'ARTIFACT_REVISION', 'CLAIM', 'RULE', 'MEASUREMENT', 'EVENT',
  'SIGNAL', 'ACTOR', 'CYCLER', 'META_CYCLER', 'CYCLE', 'STAGE', 'GATE', 'AGENT',
  'MODEL', 'PROMPT', 'STATE', 'RUNTIME', 'BOOTSTRAP', 'TEST', 'PROPERTY',
  'CAPABILITY', 'POLICY', 'RESOURCE', 'TASK', 'SCHEDULE', 'DOCUMENT', 'PROGRAM',
  'INVARIANT', 'THEOREM', 'ESTATE', 'SYNTAX', 'CONSTITUTION', 'METHOD', 'FIELD',
  'TOOL', 'SKILL', 'WORKFLOW',
]);

// Declarations that carry a namespace: nested bare declarations inside them are
// declarations, not properties.
const NAMESPACE_KEYWORDS = new Set(['MODULE', 'PACKAGE']);

// Class/interface members: always declarations, never properties.
const MEMBER_KEYWORDS = new Set(['FIELD', 'METHOD']);

// Statement keywords handled by dedicated parsers.
const STMT_KEYWORDS = new Set([
  'IF', 'WHILE', 'UNTIL', 'REPEAT', 'FOR', 'FOREACH', 'FORALL', 'TRY', 'MATCH',
  'RETURN', 'BREAK', 'CONTINUE', 'PRINT', 'ASSERT', 'REQUIRE', 'ENSURE',
  'PARALLEL', 'IMPORT', 'EXPORT', 'AFTER', 'WHEN', 'ON', 'WATCH', 'CONTENT',
  // D28. Raw-text block openers. Each is a declaration only when it opens a
  // block; opensRawBlock() decides, so `ASK m "q"` stays an operation.
  'ASK', 'PROMPT',
  'VAR', 'LET', 'SET', 'ELSE', 'ELSEIF', 'CATCH', 'FINALLY', 'CASE', 'JOIN', 'END',
]);

// Prepositional clause introducers in an operation statement.
// D15. Clause introducers in an operation. VERSION is here because the spec
// writes `RELEASE architecture VERSION "1.1.0"` (line 420): without it VERSION
// is read as a bare operand, the version is lost, and the release silently
// mutates the artifact in place instead of producing a new released version.
const PREPOSITIONS = new Set([
  'FROM', 'TO', 'INTO', 'WITH', 'AS', 'BY', 'AGAINST', 'OF', 'USING', 'AT', 'THROUGH',
  'VERSION',
]);

// Word-form binary operators.
const WORD_BINOPS = new Set([
  'AND', 'OR', 'IS', 'IS_NOT', 'IN', 'HAS', 'MATCHES', 'CONTRIBUTES_TO',
  'CAN_PARSE', 'CAN_TYPECHECK', 'CAN_LOWER', 'CAN_GENERATE_TARGETS',
  'CAN_EXECUTE', 'CAN_BUILD', 'CAN_VERIFY', 'CAN_COMPILE', 'CAN_RUN',
]);
const WORD_POSTFIX = new Set(['EXISTS']);
const QUANTIFIERS = new Set(['ALL', 'ANY', 'EVERY', 'NONE']);

const PRECEDENCE = {
  OR: 1, '||': 1,
  AND: 2, '&&': 2,
  '==': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3,
  IS: 3, IS_NOT: 3, IN: 3, HAS: 3, MATCHES: 3, CONTRIBUTES_TO: 3,
  CAN_PARSE: 3, CAN_TYPECHECK: 3, CAN_LOWER: 3, CAN_GENERATE_TARGETS: 3,
  CAN_EXECUTE: 3, CAN_BUILD: 3, CAN_VERIFY: 3, CAN_COMPILE: 3, CAN_RUN: 3,
  // D35. Flow and relation arrows. The corpus draws pipelines and bidirectional
  // couplings inline (`AFFECTIVE_STATE <-> AESTHETIC_STATE`, `-> EVALUATION`).
  '->': 2, '<->': 2, '<-': 2, '=>': 2, '\u2192': 2, '\u2194': 2, '\u2190': 2, '\u21d2': 2,
  '..': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

export class Parser {
  constructor(src, opts = {}) {
    const { tokens, lines } = lex(src, opts);
    this.tokens = tokens;
    this.lines = lines;
    this.src = src;
    this.file = opts.file || '<source>';
    this.pos = 0;
    this.depth = 0; // bracket nesting; while > 0, line breaks do not end a statement
    this.diagnostics = [];
    this.terminators = this.scanTerminators();
  }

  // ---- token helpers -------------------------------------------------------
  peek(k = 0) { return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]; }
  prev() { return this.tokens[Math.max(0, this.pos - 1)]; }
  next() { return this.tokens[this.pos++]; }
  atEnd() { return this.peek().type === T.EOF; }

  isWord(up, k = 0) {
    const t = this.peek(k);
    return t.type === T.WORD && t.upper === up;
  }
  isOp(v, k = 0) {
    const t = this.peek(k);
    return t.type === T.OP && t.value === v;
  }
  eatWord(up) { if (this.isWord(up)) { this.next(); return true; } return false; }
  eatOp(v) { if (this.isOp(v)) { this.next(); return true; } return false; }
  expectOp(v) {
    if (!this.eatOp(v)) throw new ParseError(`expected '${v}'`, this.peek());
    return this.prev();
  }

  /** True when the next token starts a new source line and no bracket is open. */
  atLineBreak() {
    if (this.depth > 0) return false;
    if (this.peek().line === this.prev().line) return false;
    // D37. A line ending in a comma continues onto the next. The corpus writes
    // operand lists one per line (`ACCEPT fragment FROM` / `SIGHT,` / `HEARING,`),
    // and treating the newline as a terminator splits one statement into many.
    if (this.prev().type === T.OP && this.prev().value === ',') return false;
    return true;
  }

  note(severity, code, message, tok) {
    this.diagnostics.push({
      severity, code, message,
      line: tok ? tok.line : 0, col: tok ? tok.col : 0, file: this.file,
    });
  }

  // ---- explicit terminators (rule D5) --------------------------------------
  /** Index every `END <KEYWORD> [name]` so a header can claim its own closer. */
  scanTerminators() {
    const out = [];
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.type !== T.WORD || t.upper !== 'END') continue;
      const n = this.tokens[i + 1];
      if (!n || n.type !== T.WORD || n.line !== t.line) continue;
      // D38. Any word may close a block it opened. The cycler corpus writes
      // multi-line properties as `PURPOSE ... END PURPOSE`, `CONTRACT ... END
      // CONTRACT`, `CAPABILITIES ... END CAPABILITIES`. Restricting terminators
      // to the declaration keywords made `END PURPOSE` close the PROGRAM
      // instead, which lost the whole file below it.
      if (!/^[A-Z][A-Z0-9_]*$/.test(n.upper)) continue;
      const nm = this.tokens[i + 2];
      const name = (nm && nm.type === T.WORD && nm.line === t.line) ? nm.value : null;
      out.push({ index: i, keyword: n.upper, name, claimed: false, tokens: name ? 3 : 2 });
    }
    return out;
  }

  /** Is there an unclaimed `END <keyword>` ahead, and is the keyword alone on its line? */
  hasOwnTerminator(keyword) {
    if (!this.opensRawBlock()) return false;
    for (const term of this.terminators) {
      if (term.claimed || term.index < this.pos) continue;
      if (term.keyword === keyword) return true;
    }
    return false;
  }

  claimTerminator(keyword, name) {
    for (const term of this.terminators) {
      if (term.claimed || term.index < this.pos) continue;
      if (term.keyword !== keyword) continue;
      if (term.name && name && term.name !== name) continue;
      if (term.name && !name) continue;
      term.claimed = true;
      return term;
    }
    return null;
  }

  // ---- entry point ---------------------------------------------------------
  parseProgram() {
    const body = [];
    while (!this.atEnd()) {
      const before = this.pos;
      let stmt = null;
      try {
        stmt = this.parseStatement({ inDecl: false, namespace: true, indent: -1 });
      } catch (err) {
        // A malformed statement is a diagnostic with a line, not an exception
        // thrown at whoever called parse(). The parser records it, steps past
        // the offending token, and carries on so the rest of the file is still
        // reported on.
        if (!(err instanceof ParseError)) throw err;
        this.note('error', 'parse', err.message, { line: err.line, col: err.col, indent: 0 });
        this.pos = Math.max(this.pos, before) + 1;
        continue;
      }
      if (stmt) body.push(stmt);
      if (this.pos === before) {
        this.note('error', 'stuck', `could not parse token ${JSON.stringify(String(this.peek().value))}`, this.peek());
        this.next();
      }
    }
    return { kind: 'Program', file: this.file, body, diagnostics: this.diagnostics };
  }

  // ---- block bodies (rules D6-D8) ------------------------------------------
  /**
   * Does the header at `headerIndent` open a block?
   * Yes if it claimed an explicit END, or if the next statement is more indented.
   */
  opensBlock(headerIndent, term) {
    if (term) return true;
    if (this.atEnd()) return false;
    return this.peek().indent > headerIndent;
  }

  /**
   * Parse statements until the block closes. Consumes the closing END when
   * there is one; closes silently on dedent when there is not.
   */
  parseBlockBody(headerIndent, ctx, term) {
    const body = [];
    for (;;) {
      // The heredoc reader can skip past a claimed terminator; if that happened,
      // release the claim and fall back to the indentation rule.
      if (term && this.pos > term.index) { term.claimed = false; term = null; }
      if (this.atEnd()) {
        if (term) this.note('warning', 'unterminated', 'block reached end of file without its END', this.peek());
        break;
      }
      if (term) {
        if (this.pos === term.index) {
          for (let k = 0; k < term.tokens; k++) this.next();
          break;
        }
      } else if (this.peek().indent <= headerIndent) {
        // An END *below* this header's indentation closes an outer block, not this one.
        if (this.isWord('END') && this.peek().indent === headerIndent) {
          this.next();
          // A bare `END` may still be followed by a keyword+name on the same line.
          if (this.peek().type === T.WORD && this.peek().line === this.prev().line
              && DECL_KEYWORDS.has(this.peek().upper)) {
            this.next();
            if (this.peek().type === T.WORD && this.peek().line === this.prev().line) this.next();
          }
        }
        break;
      }
      const before = this.pos;
      const stmt = this.parseStatement(ctx);
      if (stmt) body.push(stmt);
      if (this.pos === before) {
        this.note('error', 'stuck', `could not parse token ${JSON.stringify(String(this.peek().value))}`, this.peek());
        this.next();
      }
    }
    return body;
  }

  // ---- statements ----------------------------------------------------------
  parseStatement(ctx) {
    const tok = this.peek();
    if (tok.type === T.EOF) return null;

    if (tok.type === T.WORD) {
      const up = tok.upper;

      // `END` reaching here means an unbalanced close; report and consume.
      if (up === 'END' || up === 'JOIN') {
        this.note('warning', 'stray-end', `unmatched ${up}`, tok);
        this.next();
        return null;
      }

      if (STMT_KEYWORDS.has(up)) {
        const s = this.parseKeywordStatement(up, ctx);
        if (s) return s;
      }

      if (this.isDeclarationHere(up, ctx)) return this.parseDeclaration(ctx);
    }

    // `...` on its own line: an UNRESOLVED body, executable as such.
    if (this.isOp('...')) {
      const t = this.next();
      return { kind: 'Unresolved', line: t.line, indent: t.indent };
    }

    return this.parseSimpleStatement(ctx);
  }

  /**
   * Decide whether a declaration keyword is a declaration here or a property key.
   * Inside a non-namespace declaration body, `TYPE HUMAN` is the GATE's TYPE
   * property; inside MODULE it is a type declaration. (Rule D9.)
   */
  isDeclarationHere(up, ctx) {
    // D38. A word alone on its line with a matching, unclaimed `END <word>`
    // ahead of it opens a block, whether or not it is a declaration keyword.
    if (!DECL_KEYWORDS.has(up)) return this.hasOwnTerminator(up);
    // D28. A raw-text opener is a declaration wherever it opens a block, even
    // deep inside a STAGE body — that is exactly where prompts live.
    if (RAW_BLOCK_KEYWORDS.has(up)) return this.opensRawBlock();
    if (MEMBER_KEYWORDS.has(up)) {
      // `METHOD` with nothing after it on the line is a section, not a member.
      const n = this.peek(1);
      return n.line === this.peek().line;
    }
    if (!ctx.inDecl) return true;
    if (ctx.namespace) return true;
    // Inside a plain declaration body it is a declaration only if it opens a block.
    const n = this.peek(1);
    if (n.type === T.STR && n.line === this.peek().line) {
      // `TYPE "specification"` — a declaration name is never a string literal
      // unless the construct is FILE/SIGNAL, which name themselves with strings.
      if (up !== 'FILE' && up !== 'SIGNAL' && up !== 'DOCUMENT') return false;
    }
    let k = 1;
    while (this.peek(k).line === this.peek().line && this.peek(k).type !== T.EOF) k += 1;
    return this.peek(k).indent > this.peek().indent;
  }

  parseKeywordStatement(up, ctx) {
    const tok = this.peek();
    const indent = tok.indent;
    switch (up) {
      case 'IF': return this.parseIf(ctx);
      case 'WHILE': case 'UNTIL': return this.parseWhile(up, ctx);
      case 'REPEAT': return this.parseRepeat(ctx);
      case 'FOR': case 'FOREACH': case 'FORALL': return this.parseFor(up, ctx);
      case 'TRY': return this.parseTry(ctx);
      case 'MATCH': return this.parseMatch(ctx);
      case 'PARALLEL': return this.parseParallel(ctx);
      case 'RETURN': {
        this.next();
        const value = this.atLineBreak() ? null : this.parseExpression();
        return { kind: 'Return', value, line: tok.line };
      }
      case 'BREAK': case 'CONTINUE': {
        this.next();
        let when = null;
        if (!this.atLineBreak() && this.isWord('IF')) { this.next(); when = this.parseExpression(); }
        return { kind: up === 'BREAK' ? 'Break' : 'Continue', when, line: tok.line };
      }
      case 'PRINT': {
        this.next();
        const args = this.parseExpressionList();
        return { kind: 'Print', args, line: tok.line };
      }
      case 'ASSERT': case 'REQUIRE': case 'ENSURE': {
        // Bare, with an indented body: a section (THEOREM's REQUIRE block).
        if (this.peek(1).line !== tok.line && this.peek(1).indent > indent) return this.parseSection(ctx);
        this.next();
        const test = this.parseExpression();
        const start = this.tokenIndexOfLine(tok.line);
        return {
          kind: 'Obligation', mode: up, test, line: tok.line,
          source: this.sourceOfLine(tok.line),
        };
      }
      case 'IMPORT': case 'EXPORT': {
        this.next();
        const names = [];
        do { names.push(this.parseQualifiedName()); } while (!this.atLineBreak() && this.eatOp(','));
        return { kind: up === 'IMPORT' ? 'Import' : 'Export', names, line: tok.line };
      }
      case 'VAR': case 'LET': case 'SET': {
        this.next();
        // D34. `SET a.b.c = v` and `SET xs[0] = v` assign through a path. The
        // cycler corpus sets artifact fields constantly (`SET item.status = ...`),
        // and reading only a bare name loses the path and the assignment with it.
        const target = this.parsePostfix();
        if (target.kind !== 'Identifier') {
          const value = this.eatOp('=') ? this.parseValueExpression() : null;
          return { kind: 'Assign', target, value, line: tok.line };
        }
        const name = target.name;
        let type = null;
        if (this.eatOp(':')) type = this.parseTypeExpr();
        let value = null;
        if (this.eatOp('=')) value = this.parseValueExpression();
        return { kind: 'Declare', name, type, value, line: tok.line };
      }
      case 'AFTER': case 'WHEN': case 'ON': case 'WATCH': {
        this.next();
        const subject = this.atLineBreak() ? null : this.parseExpression();
        const term = this.claimTerminator(up, null);
        const body = this.opensBlock(indent, term)
          ? this.parseBlockBody(indent, { ...ctx, inDecl: false, namespace: false }, term)
          : [];
        return { kind: 'Reactive', mode: up, subject, body, line: tok.line };
      }
      case 'CONTENT': case 'ASK': case 'PROMPT':
        // D28. The body of a prompt block is prose addressed to a model, not
        // PANINI source: it holds free text, {placeholders}, JSON fragments,
        // apostrophes, dashes and blank lines. It is read as a heredoc so its
        // bytes survive exactly, which is also what makes a prompt auditable.
        // Only when the keyword actually opens a block — `ASK m "question"` on
        // one line is still an operation.
        if (this.opensRawBlock()) return this.parseContent(ctx);
        break;
      default: return null;
    }
  }

  /** A bare word with an indented body and no operands: GIVEN / PRINCIPLES / METHOD. */
  parseSection(ctx) {
    const tok = this.next();
    const body = this.parseBlockBody(tok.indent, { ...ctx, inDecl: true, namespace: false }, null);
    return { kind: 'Section', name: tok.value, upper: tok.upper, body, line: tok.line };
  }

  parseIf(ctx) {
    const tok = this.next();
    const indent = tok.indent;
    const test = this.parseExpression();
    const consequent = [];
    const alternates = [];
    let current = consequent;
    for (;;) {
      if (this.atEnd()) break;
      if (this.peek().indent <= indent) {
        if (this.isWord('ELSE') || this.isWord('ELSEIF')) {
          const kw = this.next().upper;
          if (kw === 'ELSEIF') {
            const t2 = this.parseExpression();
            const branch = { test: t2, body: [] };
            alternates.push(branch);
            current = branch.body;
          } else {
            const branch = { test: null, body: [] };
            alternates.push(branch);
            current = branch.body;
          }
          continue;
        }
        if (this.isWord('END')) { this.next(); break; }
        break;
      }
      const before = this.pos;
      const s = this.parseStatement({ ...ctx, inDecl: false, namespace: false });
      if (s) current.push(s);
      if (this.pos === before) { this.next(); }
    }
    return { kind: 'If', test, consequent, alternates, line: tok.line };
  }

  parseWhile(up, ctx) {
    const tok = this.next();
    const test = this.parseExpression();
    const body = this.parseBlockBody(tok.indent, { ...ctx, inDecl: false, namespace: false }, null);
    return { kind: 'Loop', mode: up, test, body, line: tok.line };
  }

  parseRepeat(ctx) {
    const tok = this.next();
    const count = this.atLineBreak() ? null : this.parseExpression();
    const body = this.parseBlockBody(tok.indent, { ...ctx, inDecl: false, namespace: false }, null);
    return { kind: 'Repeat', count, body, line: tok.line };
  }

  parseFor(up, ctx) {
    const tok = this.next();
    // D33. `FOR EACH x IN xs` is `FOREACH x IN xs`. The cycler corpus writes the
    // two-word form throughout; BASIC ancestry admits both.
    if (up === 'FOR' && this.peek().type === T.WORD && this.peek().upper === 'EACH'
        && this.peek().line === tok.line) this.next();
    // D36. `REPEAT FOREACH passages` names a collection and no loop variable.
    // The corpus uses it wherever a stage repeats once per item; the item is
    // bound to `item` so the stage body can name it.
    // The head is a name or a path, never a full expression: `IN` is itself a
    // binary operator, and parsing an expression here would swallow it.
    const first = this.parsePostfix();
    let name;
    let iterable;
    if (this.isWord('IN')) {
      this.next();
      name = first.kind === 'Identifier' ? first.name : String(first.name || 'item');
      iterable = this.parseExpression();
    } else {
      name = 'item';
      iterable = first;
    }
    const body = this.parseBlockBody(tok.indent, { ...ctx, inDecl: false, namespace: false }, null);
    return { kind: 'ForEach', mode: up, name, iterable, body, line: tok.line };
  }

  parseTry(ctx) {
    const tok = this.next();
    const indent = tok.indent;
    const block = [];
    let handler = null;
    let finalizer = null;
    let current = block;
    for (;;) {
      if (this.atEnd()) break;
      if (this.peek().indent <= indent) {
        if (this.isWord('CATCH')) {
          this.next();
          const param = (this.peek().type === T.WORD && !this.atLineBreak()) ? this.next().value : 'error';
          handler = { param, body: [] };
          current = handler.body;
          continue;
        }
        if (this.isWord('FINALLY')) {
          this.next();
          finalizer = [];
          current = finalizer;
          continue;
        }
        if (this.isWord('END')) { this.next(); break; }
        break;
      }
      const before = this.pos;
      const s = this.parseStatement({ ...ctx, inDecl: false, namespace: false });
      if (s) current.push(s);
      if (this.pos === before) this.next();
    }
    return { kind: 'Try', block, handler, finalizer, line: tok.line };
  }

  parseMatch(ctx) {
    const tok = this.next();
    const indent = tok.indent;
    const subject = this.parseExpression();
    const cases = [];
    for (;;) {
      if (this.atEnd()) break;
      if (this.peek().indent <= indent) {
        if (this.isWord('END')) { this.next(); }
        break;
      }
      if (!this.isWord('CASE')) {
        this.note('warning', 'match-body', 'statement outside CASE in MATCH', this.peek());
        this.next();
        continue;
      }
      const caseTok = this.next();
      let pattern;
      if (this.isOp('_')) { this.next(); pattern = { kind: 'Wildcard' }; }
      else pattern = this.parseExpression();
      let guard = null;
      if (!this.atLineBreak() && this.isWord('WHEN')) { this.next(); guard = this.parseExpression(); }
      const body = this.parseBlockBody(caseTok.indent, { ...ctx, inDecl: false, namespace: false }, null);
      cases.push({ pattern, guard, body, line: caseTok.line });
    }
    return { kind: 'Match', subject, cases, line: tok.line };
  }

  parseParallel(ctx) {
    const tok = this.next();
    const indent = tok.indent;
    const body = [];
    for (;;) {
      if (this.atEnd()) break;
      if (this.peek().indent <= indent) {
        if (this.isWord('JOIN')) { this.next(); break; }
        if (this.isWord('END')) { this.next(); break; }
        break;
      }
      const before = this.pos;
      const s = this.parseStatement({ ...ctx, inDecl: false, namespace: false });
      if (s) body.push(s);
      if (this.pos === before) this.next();
    }
    return { kind: 'Parallel', body, line: tok.line };
  }

  /**
   * True when a raw-text keyword is followed by nothing else on its line, i.e.
   * it opens a block rather than taking operands. `ASK` alone opens a prompt;
   * `ASK model "question"` is an operation.
   */
  opensRawBlock() {
    const here = this.peek();
    const nxt = this.peek(1);
    return !nxt || nxt.type === T.EOF || nxt.line !== here.line;
  }

  /** CONTENT is a heredoc: bytes survive, blank lines survive, indent is stripped. */
  parseContent(ctx) {
    const tok = this.next();
    const { text, endLine } = heredoc(this.lines, tok.line, tok.indent);
    while (!this.atEnd() && this.peek().line < endLine) this.next();
    // `END` or `END ASK` — consume the keyword too when it names this block.
    if (this.isWord('END')) {
      this.next();
      if (!this.atEnd() && this.peek().type === T.WORD && this.peek().upper === tok.upper
          && this.peek().line === this.prev().line) this.next();
    }
    return { kind: 'Content', keyword: tok.upper, text, line: tok.line };
  }

  // ---- declarations --------------------------------------------------------
  parseDeclaration(ctx) {
    const tok = this.next();
    const keyword = tok.upper;
    const indent = tok.indent;

    // INVARIANT has no END: a name, then one expression on the following line.
    if (keyword === 'INVARIANT') {
      const name = this.parseDeclName();
      let test = null;
      if (!this.atEnd() && this.peek().indent > indent) test = this.parseExpression();
      return { kind: 'Invariant', name, test, line: tok.line, source: this.sourceOfLine(tok.line) };
    }

    const sameLine = () => !this.atEnd() && !this.atLineBreak();
    const name = sameLine() ? this.parseDeclName() : null;
    const generics = sameLine() ? this.parseGenerics() : null;
    const params = (sameLine() && this.isOp('(')) ? this.parseParams() : null;
    let declaredType = null;
    if (sameLine() && this.eatOp(':')) declaredType = this.parseTypeExpr();
    let returnType = null;
    if (sameLine() && this.eatOp('->')) returnType = this.parseTypeExpr();

    // `TYPE PositiveInt = Refinement<Int> WHERE x > 0`
    let alias = null;
    let where = null;
    if (sameLine() && this.eatOp("=")) alias = this.parseTypeExpr();
    if (!this.atLineBreak() && this.isWord('WHERE')) { this.next(); where = this.parseExpression(); }

    // A trailing modifier clause on the header line, e.g. `SIGNOFF x BY HUMAN`.
    const clauses = this.parseClauses();

    const term = this.claimTerminator(keyword, typeof name === 'string' ? name : null);
    const isBlock = this.opensBlock(indent, term);
    const body = isBlock
      ? this.parseBlockBody(indent, {
        inDecl: true,
        namespace: NAMESPACE_KEYWORDS.has(keyword),
        indent,
      }, term)
      : [];

    return {
      kind: 'Declaration', keyword, name, generics, params, returnType, declaredType,
      alias, where, clauses, body, block: isBlock, line: tok.line, indent,
    };
  }

  parseDeclName() {
    const t = this.peek();
    if (t.type === T.STR) { this.next(); return t.value; }
    if (t.type === T.NUM) { this.next(); return String(t.text ?? t.value); }
    if (t.type === T.WORD) return this.parseQualifiedName();
    return null;
  }

  parseQualifiedName() {
    let name = this.next().value;
    while (this.isOp('.') && this.peek(1).type === T.WORD && !this.atLineBreak()) {
      this.next();
      name += `.${this.next().value}`;
    }
    return name;
  }

  parseGenerics() {
    if (!this.isOp('<') || this.atLineBreak()) return null;
    this.next();
    this.depth += 1;
    const out = [];
    while (!this.isOp('>') && !this.atEnd()) {
      out.push(this.parseTypeExpr());
      if (!this.eatOp(',')) break;
    }
    this.depth -= 1;
    this.expectOp('>');
    return out;
  }

  parseParams() {
    this.expectOp('(');
    this.depth += 1;
    const params = [];
    while (!this.isOp(')') && !this.atEnd()) {
      if (this.eatOp('...')) { params.push({ name: '...', variadic: true, type: null }); }
      else {
        const nameTok = this.next();
        const p = { name: String(nameTok.value), type: null, variadic: false };
        if (this.eatOp(':')) p.type = this.parseTypeExpr();
        if (this.eatOp('...')) p.variadic = true;
        if (this.eatOp('=')) p.default = this.parseExpression();
        params.push(p);
      }
      if (!this.eatOp(',')) break;
    }
    this.depth -= 1;
    this.expectOp(')');
    return params;
  }

  parseTypeExpr() {
    const t = this.peek();
    if (t.type !== T.WORD) {
      if (t.type === T.OP && t.value === '_') { this.next(); return { kind: 'TypeRef', name: '_' }; }
      throw new ParseError('expected a type', t);
    }
    const name = this.parseQualifiedName();
    const args = this.isOp('<') ? this.parseGenerics() : null;
    let node = { kind: 'TypeRef', name, args, line: t.line };
    while (this.isOp('|') && !this.atLineBreak()) {
      this.next();
      node = { kind: 'TypeUnion', left: node, right: this.parseTypeExpr(), line: t.line };
    }
    return node;
  }

  parseClauses() {
    const clauses = [];
    while (!this.atLineBreak() && this.peek().type === T.WORD && PREPOSITIONS.has(this.peek().upper)) {
      const prep = this.next().upper;
      const value = this.parseExpression();
      clauses.push({ prep, value });
    }
    return clauses;
  }

  // ---- simple statements ---------------------------------------------------
  parseSimpleStatement(ctx) {
    const tok = this.peek();

    // `name: Type` — a schema or class field.
    if (tok.type === T.WORD && this.peek(1).type === T.OP && this.peek(1).value === ':'
        && this.peek(1).line === tok.line) {
      this.next(); this.next();
      const type = this.parseTypeExpr();
      return { kind: 'Field', name: tok.value, type, line: tok.line };
    }

    // A variant constructor inside a TYPE block: `OK(value:T)`.
    if (ctx.inDecl && tok.type === T.WORD && this.isOp('(', 1) && this.peek(1).line === tok.line) {
      const save = this.pos;
      this.next();
      let params = null;
      try { params = this.parseParams(); } catch { params = null; }
      if (params && params.every((p) => p.type) && params.length > 0 && this.atLineBreak()) {
        return { kind: 'Variant', name: tok.value, params, line: tok.line };
      }
      this.pos = save;
    }

    // Grammar production inside SYNTAX: `block := KEYWORD [name] BODY END`.
    if (tok.type === T.WORD && this.isOp(':=', 1)) {
      this.next(); this.next();
      const startLine = tok.line;
      const parts = [];
      while (!this.atEnd() && this.peek().line === startLine) parts.push(String(this.next().value));
      return { kind: 'Production', name: tok.value, rhs: this.sourceOfLine(startLine).split(':=').slice(1).join(':=').trim(), tokens: parts, line: startLine };
    }

    // Assignment or an expression statement.
    const start = this.pos;
    let expr;
    try {
      expr = this.parseExpression();
    } catch (err) {
      this.pos = start;
      throw err;
    }

    if (!this.atLineBreak() && this.isOp('=')) {
      this.next();
      const value = this.parseValueExpression();
      return { kind: 'Assign', target: expr, value, line: tok.line };
    }

    // `ELEVATE(cycler) -> GENIE` — an operation signature, not a call to run.
    if (!this.atLineBreak() && this.isOp('->')) {
      this.next();
      const returnType = this.parseTypeExpr();
      return { kind: 'Signature', subject: expr, returnType, line: tok.line, source: this.sourceOfLine(tok.line) };
    }

    // An operation statement: a verb, its operands, and prepositional clauses.
    if (expr.kind === 'Identifier' || expr.kind === 'Member') {
      const operands = [];
      const clauses = [];
      let arrow = null;
      while (!this.atLineBreak() && !this.atEnd()) {
        if (this.peek().type === T.WORD && PREPOSITIONS.has(this.peek().upper)) {
          const prep = this.next().upper;
          clauses.push({ prep, value: this.parseExpression() });
          continue;
        }
        if (this.isOp('->')) { this.next(); arrow = this.parseExpression(); continue; }
        const before = this.pos;
        operands.push(this.parseExpression());
        this.eatOp(',');
        if (this.pos === before) break;
      }
      if (operands.length || clauses.length || arrow) {
        return {
          kind: 'Operation',
          verb: expr.kind === 'Identifier' ? expr.name : this.flattenMember(expr),
          verbUpper: (expr.kind === 'Identifier' ? expr.name : this.flattenMember(expr)).toUpperCase(),
          operands, clauses, arrow, line: tok.line, source: this.sourceOfLine(tok.line),
        };
      }
      // A bare word with an indented body is a section; alone it is a marker.
      if (expr.kind === 'Identifier' && !this.atEnd() && this.peek().indent > tok.indent
          && this.peek().line > tok.line && ctx.inDecl) {
        const body = this.parseBlockBody(tok.indent, { ...ctx, inDecl: true, namespace: false }, null);
        return { kind: 'Section', name: expr.name, upper: expr.name.toUpperCase(), body, line: tok.line };
      }
      return {
        kind: 'Operation', verb: expr.kind === 'Identifier' ? expr.name : this.flattenMember(expr),
        verbUpper: (expr.kind === 'Identifier' ? expr.name : this.flattenMember(expr)).toUpperCase(),
        operands: [], clauses: [], marker: true, line: tok.line, source: this.sourceOfLine(tok.line),
      };
    }

    return { kind: 'ExpressionStatement', expression: expr, line: tok.line };
  }

  flattenMember(node) {
    if (node.kind === 'Identifier') return node.name;
    if (node.kind === 'Member') return `${this.flattenMember(node.object)}.${node.property}`;
    return '<expr>';
  }

  // ---- expressions ---------------------------------------------------------
  parseExpressionList() {
    const out = [this.parseExpression()];
    while (!this.atLineBreak() && this.eatOp(',')) out.push(this.parseExpression());
    return out;
  }

  /**
   * A value position that may hold an operation form: `source = READ FILE "x.pni"`.
   * Falls back to an ordinary expression when the line does not continue.
   */
  parseValueExpression() {
    const expr = this.parseExpression();
    if (this.atLineBreak() || this.atEnd()) return expr;
    if (expr.kind !== 'Identifier' && expr.kind !== 'Member') return expr;
    const operands = [];
    const clauses = [];
    while (!this.atLineBreak() && !this.atEnd()) {
      if (this.peek().type === T.WORD && PREPOSITIONS.has(this.peek().upper)) {
        const prep = this.next().upper;
        clauses.push({ prep, value: this.parseExpression() });
        continue;
      }
      const before = this.pos;
      operands.push(this.parseExpression());
      this.eatOp(',');
      if (this.pos === before) break;
    }
    if (!operands.length && !clauses.length) return expr;
    const verb = expr.kind === 'Identifier' ? expr.name : this.flattenMember(expr);
    return {
      kind: 'OperationExpr', verb, verbUpper: verb.toUpperCase(),
      operands, clauses, line: expr.line,
    };
  }

  parseExpression(minPrec = 0) {
    let left = this.parseUnary();
    for (;;) {
      if (this.atLineBreak() || this.atEnd()) break;
      const t = this.peek();
      let op = null;
      if (t.type === T.OP && PRECEDENCE[t.value] !== undefined) op = t.value;
      else if (t.type === T.WORD && WORD_BINOPS.has(t.upper)) op = t.upper;
      else if (t.type === T.WORD && WORD_POSTFIX.has(t.upper)) {
        this.next();
        left = { kind: 'Postfix', operator: t.upper, argument: left, line: t.line };
        continue;
      }
      if (op === null) break;
      const prec = PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      // D14. A word relation whose right operand is not on the same line is a
      // one-place relation, not a binary reaching into the line below. The spec
      // writes `PANINI_COMPILER CAN_GENERATE_TARGETS` (line 1680) directly above
      // `PANINI_RUNTIME CAN_EXECUTE PANINI`; without this the first swallows the
      // second and the REQUIRE section loses a requirement.
      if (t.type === T.WORD && (this.atLineBreak() || this.atEnd())) {
        left = { kind: 'Postfix', operator: op, argument: left, line: t.line };
        continue;
      }
      const right = this.parseExpression(prec + 1);
      left = op === '..'
        ? { kind: 'Range', start: left, end: right, line: t.line }
        : { kind: 'Binary', operator: op, left, right, line: t.line };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.type === T.WORD && t.upper === 'NOT') {
      this.next();
      return { kind: 'Unary', operator: 'NOT', argument: this.parseUnary(), line: t.line };
    }
    if (t.type === T.WORD && QUANTIFIERS.has(t.upper) && this.peek(1).type === T.WORD
        && this.peek(1).line === t.line) {
      this.next();
      return { kind: 'Quantifier', quantifier: t.upper, argument: this.parseUnary(), line: t.line };
    }
    if (t.type === T.OP && (t.value === '-' || t.value === '!' || t.value === '+')) {
      this.next();
      const op = t.value === '!' ? 'NOT' : t.value;
      return { kind: 'Unary', operator: op, argument: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      if (this.atEnd()) break;
      if (this.isOp('(') && !this.atLineBreak() && !this.peek().spaceBefore) {
        this.next();
        this.depth += 1;
        const args = [];
        while (!this.isOp(')') && !this.atEnd()) {
          if (this.eatOp('...')) { args.push({ kind: 'Spread', argument: null, line: this.prev().line }); }
          else {
            const a = this.parseExpression();
            if (this.eatOp('...')) args.push({ kind: 'Spread', argument: a, line: a.line });
            else args.push(a);
          }
          if (!this.eatOp(',')) break;
        }
        this.depth -= 1;
        this.expectOp(')');
        node = { kind: 'Call', callee: node, args, line: node.line };
        continue;
      }
      if (this.isOp('[') && !this.atLineBreak() && !this.peek().spaceBefore) {
        this.next();
        this.depth += 1;
        const index = this.parseExpression();
        this.depth -= 1;
        this.expectOp(']');
        node = { kind: 'Index', object: node, index, line: node.line };
        continue;
      }
      if (this.isOp('.') && this.peek(1).type === T.WORD && !this.atLineBreak()) {
        this.next();
        node = { kind: 'Member', object: node, property: this.next().value, line: node.line };
        continue;
      }
      if (this.isOp('@') && !this.atLineBreak() && !this.peek().spaceBefore) {
        this.next();
        const v = this.next();
        const version = v.type === T.NUM ? String(v.text ?? v.value) : String(v.value);
        node = { kind: 'Versioned', object: node, version, line: node.line };
        continue;
      }
      break;
    }
    return node;
  }

  parsePrimary() {
    const t = this.peek();

    if (t.type === T.NUM) { this.next(); return { kind: 'Number', value: t.value, text: t.text, line: t.line }; }
    if (t.type === T.STR) { this.next(); return { kind: 'String', value: t.value, line: t.line }; }

    if (t.type === T.OP) {
      if (t.value === '...') { this.next(); return { kind: 'UnresolvedExpr', line: t.line }; }
      if (t.value === '(') {
        this.next();
        this.depth += 1;
        const e = this.parseExpression();
        this.depth -= 1;
        this.expectOp(')');
        return e;
      }
      if (t.value === '[') {
        this.next();
        this.depth += 1;
        const elements = [];
        while (!this.isOp(']') && !this.atEnd()) {
          elements.push(this.parseExpression());
          if (!this.eatOp(',')) break;
        }
        this.depth -= 1;
        this.expectOp(']');
        return { kind: 'ListLiteral', elements, line: t.line };
      }
      if (t.value === '{') {
        this.next();
        this.depth += 1;
        const entries = [];
        while (!this.isOp('}') && !this.atEnd()) {
          const k = this.peek();
          let key;
          if (k.type === T.STR) { this.next(); key = { kind: 'String', value: k.value, line: k.line }; }
          else if (k.type === T.WORD) { this.next(); key = { kind: 'String', value: k.value, line: k.line }; }
          else key = this.parseExpression();
          this.expectOp(':');
          entries.push({ key, value: this.parseExpression() });
          if (!this.eatOp(',')) break;
        }
        this.depth -= 1;
        this.expectOp('}');
        return { kind: 'MapLiteral', entries, line: t.line };
      }
      if (t.value === '@') {
        this.next();
        const name = this.parseQualifiedName();
        const args = this.isOp('(') ? (() => {
          this.next(); this.depth += 1;
          const a = [];
          while (!this.isOp(')') && !this.atEnd()) { a.push(this.parseExpression()); if (!this.eatOp(',')) break; }
          this.depth -= 1; this.expectOp(')');
          return a;
        })() : [];
        return { kind: 'Annotation', name, args, line: t.line };
      }
      if (t.value === '_') { this.next(); return { kind: 'Wildcard', line: t.line }; }
    }

    if (t.type === T.WORD) {
      const up = t.upper;
      // Anonymous function as a value.
      if (up === 'FUNCTION' || up === 'LAMBDA') {
        this.next();
        let name = null;
        if (this.peek().type === T.WORD && !this.isOp('(')) name = this.next().value;
        const params = this.isOp('(') ? this.parseParams() : [];
        let returnType = null;
        if (this.eatOp('->')) returnType = this.parseTypeExpr();
        const body = this.parseBlockBody(t.indent, { inDecl: false, namespace: false, indent: t.indent }, null);
        return { kind: 'Lambda', name, params, returnType, body, line: t.line };
      }
      // `READ FILE "x.pni"` — a file reference in expression position.
      if (up === 'FILE' && this.peek(1).type === T.STR && this.peek(1).line === t.line) {
        this.next();
        const s = this.next();
        return { kind: 'FileRef', path: s.value, line: t.line };
      }
      if (up === 'TRUE') { this.next(); return { kind: 'Boolean', value: true, line: t.line }; }
      if (up === 'FALSE') { this.next(); return { kind: 'Boolean', value: false, line: t.line }; }
      if (up === 'NULL' || up === 'NIL') { this.next(); return { kind: 'Null', line: t.line }; }
      if (up === 'NOW') { this.next(); return { kind: 'Now', line: t.line }; }
      // Dots are Member accesses here; only declaration names are dotted atoms.
      this.next();
      return { kind: 'Identifier', name: t.value, upper: t.upper, line: t.line };
    }

    throw new ParseError(`unexpected ${t.type === T.EOF ? 'end of input' : JSON.stringify(String(t.value))}`, t);
  }

  // ---- source helpers ------------------------------------------------------
  sourceOfLine(line) { return (this.lines[line - 1] || '').trim(); }
  tokenIndexOfLine(line) {
    for (let i = 0; i < this.tokens.length; i++) if (this.tokens[i].line === line) return i;
    return 0;
  }
}

export function parse(src, opts = {}) {
  const p = new Parser(src, opts);
  const ast = p.parseProgram();
  return ast;
}
