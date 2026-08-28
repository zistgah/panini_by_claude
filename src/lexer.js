// PANINI lexer.
// Spec source: PANINI_SELF_HOSTING_SPEC.pni sections III (CORE SYNTAX) and XXIII.
//
// Design commitments (see spec/DELTAS.md):
//   D1  Keywords are case-INSENSITIVE (a BASIC that is not case-insensitive is not a BASIC).
//   D2  Identifiers are case-SENSITIVE, because the spec relies on the distinction
//       (`sovereign:Sovereign`, `state:State`, `model:Model`).
//   D3  A string may span lines; `""` inside a string is a literal quote
//       (spec line 1319: ENTRYPOINT [""panini""]).
//   D4  Every token carries the indentation of the line it starts on. The parser's
//       block rule is indentation-based, so this is load-bearing, not decoration.

export const T = {
  NUM: 'NUM', STR: 'STR', WORD: 'WORD', OP: 'OP', EOF: 'EOF',
  RAW: 'RAW', // heredoc payload, produced on demand by the parser
};

// Multi-character operators, longest first.
const OPS = [
  '...', ':=', '->', '==', '!=', '<=', '>=', '..', '&&', '||',
  '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}',
  ',', ':', '.', '@', '|', '&', '!', '?', ';', '#', '\\', '^', '~',
];

export class LexError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = 'LexError';
    this.line = line;
    this.col = col;
  }
}

// D25. Identifiers admit any Unicode letter or mark, not just ASCII. The cycler
// corpus names things in Arabic, Persian and Devanagari (آواز, تبدیلی), and
// Project ILM is a multiscript programme: an ASCII-only identifier rule would
// make the language unable to name its own subject matter.
const IDENT_START = /[\p{L}\p{Nl}_]/u;
const IDENT_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_]/u;
function isIdentStart(c) {
  return IDENT_START.test(c);
}
function isIdentPart(c) {
  return IDENT_PART.test(c);
}
// Punctuation a human writes in prose. Lexed, never fatal.
const TYPOGRAPHIC = new Set([
  '\u2013', '\u2014', '\u2015',            // – — ―
  '\u2018', '\u2019',                       // ' '
  '\u2026',                                  // …
  '\u2192', '\u2190', '\u2194', '\u21d2',  // → ← ↔ ⇒
  '\u2022', '\u00b7', '\u00d7', '\u00f7',  // • · × ÷
  '\u00a7', '\u00b6', '\u2020', '\u2021',  // § ¶ † ‡
  '\u00ab', '\u00bb', '\u2039', '\u203a',  // « » ‹ ›
  '\u2032', '\u2033',                       // ′ ″
]);

function isDigit(c) {
  return c >= '0' && c <= '9';
}

/**
 * Compute the indentation (in columns, tabs = 4) of the line containing index i.
 */
function lineIndentAt(src, lineStart) {
  let n = 0;
  for (let i = lineStart; i < src.length; i++) {
    const c = src[i];
    if (c === ' ') n += 1;
    else if (c === '\t') n += 4;
    else break;
  }
  return n;
}

/**
 * Tokenise PANINI source.
 * @param {string} src
 * @param {{file?: string}} [opts]
 * @returns {{tokens: Array, lines: string[]}}
 */
export function lex(src, opts = {}) {
  const file = opts.file || '<source>';
  const tokens = [];
  const unknown = [];   // characters with no lexical rule; reported, never fatal
  const lines = src.split('\n');

  let i = 0;
  let line = 1;
  let lineStart = 0;
  let indent = lineIndentAt(src, 0);
  let sawSpace = true; // D10: `f(x)` is a call, `PROP [a, b]` is a property with a list

  const push = (type, value, startLine, startCol, extra) => {
    const tok = { type, value, line: startLine, col: startCol, indent, file, spaceBefore: sawSpace };
    if (extra) Object.assign(tok, extra);
    tokens.push(tok);
    sawSpace = false;
    return tok;
  };

  const newline = () => {
    line += 1;
    lineStart = i;
    indent = lineIndentAt(src, i);
  };

  while (i < src.length) {
    const c = src[i];

    // Newline
    if (c === '\n') {
      i += 1;
      newline();
      sawSpace = true;
      continue;
    }
    // Horizontal whitespace
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      sawSpace = true;
      continue;
    }
    // Block comment /* ... */
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line;
      i += 2;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (src[i] === '\n') {
          i += 1;
          newline();
          continue;
        }
        i += 1;
      }
      if (!closed) throw new LexError('unterminated block comment', startLine, 1);
      sawSpace = true;
      continue;
    }
    // Line comment // ...
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      sawSpace = true;
      continue;
    }
    // D31. A rule of repeated punctuation on its own line is a visual separator,
    // not code: `================` and `----------------` are used as section
    // rules throughout the corpus. One such line in tilasm.pni produced 1,924
    // errors on its own.
    if ((c === '=' || c === '-' || c === '*' || c === '~' || c === '_')
        && /^[ \t]*$/.test(src.slice(lineStart, i))) {
      let j = i;
      while (j < src.length && src[j] === c) j += 1;
      let k = j;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\r')) k += 1;
      if (j - i >= 4 && (k >= src.length || src[k] === '\n')) {
        i = j;
        sawSpace = true;
        continue;
      }
    }
    // D27. `# ...` to end of line. 662 uses across the cycler corpus.
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      sawSpace = true;
      continue;
    }
    // D26. `REM ...` to end of line — the BASIC comment the spec's ancestry
    // implies and the cycler corpus actually uses (1,250 occurrences). A bare
    // `REM` on its own line is a comment too. It is only a comment at the start
    // of a token, never inside an identifier: REMOVE and REMARK are not comments.
    if ((c === 'R' || c === 'r') && /^rem(?![\p{L}\p{Nd}_])/iu.test(src.slice(i, i + 4))) {
      while (i < src.length && src[i] !== '\n') i += 1;
      sawSpace = true;
      continue;
    }
    // D29. Typographic punctuation is prose, not a lexical error. The cycler
    // corpus is written by a person: it contains en and em dashes, curly quotes,
    // arrows, ellipses and bullets in narrative lines that sit inside blocks
    // which are not raw text. Refusing to lex them loses the whole file over a
    // dash. They lex as punctuation tokens and the parser treats them as it
    // treats any other punctuation it has no rule for.
    if (TYPOGRAPHIC.has(c)) {
      push(T.OP, c, line, i - lineStart + 1);
      i += 1;
      sawSpace = false;
      continue;
    }
    // String
    if (c === '"' || c === '\u201c') {
      // D30. A curly-opened string closes on a curly close quote; a straight one
      // closes on a straight quote. The corpus quotes prose both ways and a
      // mismatched pair would swallow the rest of the file.
      const closer = c === '\u201c' ? '\u201d' : '"';
      const startLine = line;
      const startCol = i - lineStart + 1;
      i += 1;
      let out = '';
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === closer) {
          if (src[i + 1] === '"') { // D3: doubled quote is a literal quote
            out += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        if (ch === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (ch === '\n') {
          out += '\n';
          i += 1;
          newline();
          continue;
        }
        out += ch;
        i += 1;
      }
      if (!closed) throw new LexError('unterminated string', startLine, startCol);
      push(T.STR, out, startLine, startCol, { multiline: out.includes('\n') });
      continue;
    }
    // Number
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]) && !isDigit(src[i - 1] || ''))) {
      const startCol = i - lineStart + 1;
      let j = i;
      while (j < src.length && isDigit(src[j])) j += 1;
      // A range operator `0..10` must not be eaten as a decimal point.
      if (src[j] === '.' && src[j + 1] !== '.') {
        j += 1;
        while (j < src.length && isDigit(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k += 1;
        if (isDigit(src[k])) {
          k += 1;
          while (k < src.length && isDigit(src[k])) k += 1;
          j = k;
        }
      }
      const text = src.slice(i, j);
      push(T.NUM, Number(text), line, startCol, { text });
      i = j;
      continue;
    }
    // Identifier / keyword
    if (isIdentStart(c)) {
      const startCol = i - lineStart + 1;
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j += 1;
      const text = src.slice(i, j);
      push(T.WORD, text, line, startCol, { upper: text.toUpperCase() });
      i = j;
      continue;
    }
    // Operator
    const startCol = i - lineStart + 1;
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) {
      // D29 (general). A character with no lexical rule is punctuation, not a
      // fatal error. The corpus is written by a person and contains apostrophes
      // in prose, mathematical symbols and arrows inside blocks that are not raw
      // text. Losing a 2,000-line cycler because of one apostrophe is the wrong
      // trade. The character is lexed as punctuation and recorded, so it is
      // visible without being fatal.
      unknown.push({ char: c, line, col: startCol });
      push(T.OP, c, line, startCol);
      i += 1;
      sawSpace = false;
      continue;
    }
    push(T.OP, op, line, startCol);
    i += op.length;
  }

  push(T.EOF, null, line, 1);
  return { tokens, lines, unknown };
}

/**
 * Extract a heredoc payload: every line strictly more indented than `openIndent`,
 * from `fromLine` (1-based, exclusive of the opening line) until the first line
 * whose indentation is <= openIndent. Blank lines belong to the payload.
 * Common indentation is stripped uniformly so prose and code survive verbatim.
 */
export function heredoc(lines, fromLine, openIndent) {
  const body = [];
  let n = fromLine; // 0-based index of the first candidate line
  for (; n < lines.length; n++) {
    const raw = lines[n];
    if (raw.trim() === '') { body.push(''); continue; }
    const ind = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    if (ind <= openIndent) break;
    body.push(raw);
  }
  // Drop trailing blank lines that belong to the separator, not the payload.
  while (body.length && body[body.length - 1] === '') body.pop();
  const indents = body.filter((l) => l.trim() !== '')
    .map((l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length);
  const common = indents.length ? Math.min(...indents) : 0;
  const text = body.map((l) => (l.trim() === '' ? '' : l.replace(/^[ \t]*/, (m) => ' '.repeat(Math.max(0, m.replace(/\t/g, '    ').length - common))))).join('\n');
  return { text, endLine: n + 1 }; // endLine is 1-based line number of the terminator
}
