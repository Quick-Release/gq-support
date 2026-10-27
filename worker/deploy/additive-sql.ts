// Small, closed SQLite grammar. This is deliberately not a general SQL parser.
// Tokenization preserves strings; comments cannot splice keywords or statements.
import { requireEvidence } from "./planning-state.ts";
type Token = { text: string; kind: "word" | "literal" | "punct" };
export function validateAdditiveSql(sql: string): void {
  requireEvidence(typeof sql === "string" && sql.length > 0 && sql.length <= 32_768 && !sql.includes("statement-breakpoint"));
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const rest = sql.slice(offset);
    const skip = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (skip) { offset += skip[0].length; continue; }
    // Reject control bytes in literals; newline whitespace outside them is valid.
    // eslint-disable-next-line no-control-regex
    const token = /^(?:'((?:[^'\x00-\x1f]|'')*)'|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[(),;=])/.exec(rest);
    requireEvidence(token);
    const text = token[0];
    tokens.push({ text: text.toUpperCase(), kind: text.startsWith("'") || /^[0-9]/.test(text) ? "literal" : /^[A-Za-z_]/.test(text) ? "word" : "punct" });
    offset += text.length;
  }
  requireEvidence(tokens.length > 0 && tokens.length <= 4096);
  let i = 0, statements = 0;
  const is = (s: string) => tokens[i]?.text === s;
  const take = (s: string) => { if (!is(s)) return false; i++; return true; };
  const need = (s: string) => requireEvidence(take(s));
  const reserved = new Set("CREATE TABLE INSERT INTO VALUES PRIMARY KEY NOT NULL DEFAULT CHECK IN TEXT INTEGER REAL BLOB NUMERIC DROP DELETE UPDATE REPLACE SELECT PRAGMA ATTACH DETACH VACUUM TRIGGER RENAME BEGIN COMMIT ROLLBACK ALTER REFERENCES UNIQUE CONSTRAINT GENERATED AS COLLATE ON CONFLICT".split(" "));
  const identifier = () => {
    const t = tokens[i++]; requireEvidence(t?.kind === "word" && !reserved.has(t.text) && !/^(SQLITE_|__)/.test(t.text)); return t.text;
  };
  const literal = () => { requireEvidence(tokens[i]?.kind === "literal" || is("NULL")); i++; };
  const tables = new Map<string, Set<string>>(), seeded = new Set<string>();
  while (i < tokens.length) {
    requireEvidence(++statements <= 32);
    if (take("CREATE")) {
      need("TABLE"); const table = identifier(); requireEvidence(!tables.has(table)); need("(");
      const columns = new Set<string>();
      do {
        const column = identifier(); requireEvidence(!columns.has(column)); columns.add(column);
        requireEvidence(["TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC"].some(take));
        const constraints = new Set<string>();
        while (!is(",") && !is(")")) {
          const constraint = tokens[i]?.text; requireEvidence(constraint && !constraints.has(constraint)); constraints.add(constraint);
          if (take("PRIMARY")) need("KEY");
          else if (take("NOT")) need("NULL");
          else if (take("DEFAULT")) literal();
          else {
            need("CHECK"); need("("); requireEvidence(identifier() === column);
            if (take("=")) literal();
            else { need("IN"); need("("); literal(); while (take(",")) literal(); need(")"); }
            need(")");
          }
        }
      } while (take(","));
      need(")"); tables.set(table, columns);
    } else {
      need("INSERT"); need("INTO"); const table = identifier(), columns = tables.get(table);
      requireEvidence(columns && !seeded.has(table)); seeded.add(table); need("(");
      const used = new Set<string>();
      do { const column = identifier(); requireEvidence(columns.has(column) && !used.has(column)); used.add(column); } while (take(","));
      need(")"); need("VALUES"); need("(");
      let count = 0; do { literal(); count++; } while (take(","));
      requireEvidence(count === used.size); need(")");
    }
    need(";");
  }
}
