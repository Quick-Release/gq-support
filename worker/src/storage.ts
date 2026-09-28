import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "@cloudflare/workers-types";

/** What the service knows about a Slot. Mappings are code, not rows (docs/support-storage-design.md). */
export interface SlotConfig {
  readonly client: string;
}

export type SlotRegistry = ReadonlyMap<string, SlotConfig>;

export interface StorageConfig {
  readonly slots: SlotRegistry;
  /** The stage's shared database (ADR 0013). */
  readonly shared: D1Database;
  /** Per-Client databases, the ADR 0013 escalation path, keyed by Client. */
  readonly dedicated: Readonly<Record<string, D1Database>>;
}

/** A statement already bound to its Slot. Only its own storage can run it. */
export class ScopedStatement {
  /** @internal */
  constructor(
    readonly owner: SlotStorage,
    readonly prepared: D1PreparedStatement,
  ) {}
}

/**
 * The only query path for Slot-owned records. Every statement must pass
 * {@link assertSlotScoped}, and `?1` is always bound to this Slot: callers'
 * parameters start at `?2`.
 *
 * Cross-Slot work (the delivery sweep, webhook lookups by issue, credential
 * lookups before a Slot is known) does not go through here; each gets its own
 * narrow, named query.
 */
export class SlotStorage {
  /** @internal */
  constructor(
    readonly slot: string,
    private readonly db: D1Database,
  ) {}

  statement(sql: string, ...params: unknown[]): ScopedStatement {
    assertSlotScoped(sql);
    return new ScopedStatement(this, this.db.prepare(sql).bind(this.slot, ...params));
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.statement(sql, ...params).prepared.all<T>()).results;
  }

  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    return this.statement(sql, ...params).prepared.first<T>();
  }

  run(sql: string, ...params: unknown[]): Promise<D1Result> {
    return this.statement(sql, ...params).prepared.run();
  }

  /** D1's only transaction: all statements commit, or none do. */
  batch(statements: readonly ScopedStatement[]): Promise<D1Result[]> {
    for (const statement of statements) {
      if (statement.owner !== this) {
        throw new Error("Slot predicate: a statement from another storage cannot join this batch");
      }
    }
    return this.db.batch(statements.map((statement) => statement.prepared));
  }
}

export const createStorageFor =
  ({ slots, shared, dedicated }: StorageConfig) =>
  (slot: string): SlotStorage => {
    const config = slots.get(slot);
    if (config === undefined) {
      throw new Error(`Unknown Slot: ${slot}`);
    }
    return new SlotStorage(slot, dedicated[config.client] ?? shared);
  };

class SlotPredicateError extends Error {
  constructor(reason: string, sql: string) {
    super(`Slot predicate: ${reason}: ${sql}`);
  }
}

/**
 * Rejects SQL that could reach another Slot's rows. It guards our own SQL
 * against a forgotten predicate; it is not a parser for untrusted input, so it
 * errs on the side of rejecting:
 * - SELECT, UPDATE and DELETE need a top-level WHERE that ANDs `<table>.slot = ?1`
 *   for every table in FROM and JOIN, with no top-level OR;
 * - INSERT needs `slot` as its first column, `?1` as its first value, and one row;
 * - no statement may assign `slot`;
 * - comments, subqueries, CTEs, compound SELECTs and UPDATE … FROM are rejected.
 */
export const assertSlotScoped = (sql: string): void => {
  if (/--|\/\*/.test(sql)) throw new SlotPredicateError("comments are not allowed", sql);
  const masked = maskNested(sql);
  const kind = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase();
  const selects = sql.match(/\bSELECT\b/gi)?.length ?? 0;
  if (selects > (kind === "SELECT" ? 1 : 0)) {
    throw new SlotPredicateError("subqueries are not allowed", sql);
  }

  switch (kind) {
    case "INSERT":
      return assertInsertScoped(sql, masked);
    case "SELECT":
    case "UPDATE":
    case "DELETE":
      return assertWhereScoped(sql, masked, kind);
    default:
      throw new SlotPredicateError("only SELECT, INSERT, UPDATE and DELETE are allowed", sql);
  }
};

const assertInsertScoped = (sql: string, masked: string): void => {
  if (!/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(\s*slot\s*[,)]/i.test(sql)) {
    throw new SlotPredicateError("an INSERT must name slot as its first column", sql);
  }
  const values = /\bVALUES\b/i.exec(masked);
  if (values === null) throw new SlotPredicateError("an INSERT must use VALUES", sql);
  const afterValues = values.index + values[0].length;
  if (!/^\s*\(\s*\?1\s*[,)]/.test(sql.slice(afterValues))) {
    throw new SlotPredicateError("an INSERT must bind ?1 as its first value", sql);
  }
  const rest = masked.slice(masked.indexOf(")", masked.indexOf("(", afterValues)) + 1);
  if (/^\s*,/.test(rest)) throw new SlotPredicateError("an INSERT must insert one row", sql);
  const upsert = /\bDO\s+UPDATE\b/i.exec(rest);
  const upsertStart = sql.length - rest.length + (upsert?.index ?? 0);
  if (upsert !== null && /\bslot\b/i.test(sql.slice(upsertStart))) {
    throw new SlotPredicateError("an upsert must not assign slot", sql);
  }
};

const CLAUSE_END = /\b(GROUP|ORDER|LIMIT|HAVING|WINDOW|RETURNING)\b/i;
const JOIN = /\b(?:(?:NATURAL|LEFT|RIGHT|FULL|INNER|CROSS)\s+)*(?:OUTER\s+)?JOIN\b/i;

const assertWhereScoped = (sql: string, masked: string, kind: string): void => {
  if (/\b(UNION|INTERSECT|EXCEPT)\b/i.test(masked)) {
    throw new SlotPredicateError("compound SELECTs are not allowed", sql);
  }
  const where = /\bWHERE\b/i.exec(masked);
  if (where === null) throw new SlotPredicateError("a top-level WHERE is required", sql);
  const whereStart = where.index + where[0].length;
  const whereEnd = CLAUSE_END.exec(masked.slice(whereStart));
  const clauseEnd = whereEnd === null ? sql.length : whereStart + whereEnd.index;
  if (/\bOR\b/i.test(masked.slice(whereStart, clauseEnd))) {
    throw new SlotPredicateError("a top-level OR would escape the Slot predicate", sql);
  }

  let tables: string[];
  if (kind === "UPDATE") {
    const set = /\bSET\b/i.exec(masked);
    if (set === null || /\bFROM\b/i.test(masked.slice(set.index, where.index))) {
      throw new SlotPredicateError("an UPDATE must be SET … WHERE without FROM", sql);
    }
    if (/\bslot\b/i.test(sql.slice(set.index, where.index))) {
      throw new SlotPredicateError("an UPDATE must not assign slot", sql);
    }
    tables = [sql.slice(0, set.index).replace(/^\s*UPDATE\s+(?:OR\s+\w+\s+)?/i, "")];
  } else {
    const from = /\bFROM\b/i.exec(masked);
    if (from === null || from.index > where.index) {
      throw new SlotPredicateError("a FROM clause is required", sql);
    }
    tables = masked
      .slice(from.index + from[0].length, where.index)
      .split(new RegExp(`,|${JOIN.source}`, "i"))
      .map((ref) => ref.split(/\b(?:ON|USING)\b/i)[0]!);
  }

  const qualifiers = tables.map((ref) => {
    const words = ref.trim().split(/\s+(?:AS\s+)?/i);
    return words[words.length - 1]!;
  });
  const conjuncts = splitTopLevel(sql, masked, whereStart, clauseEnd, /\bAND\b/gi).map(
    (conjunct) => conjunct.trim().replace(/\s+/g, " ").toLowerCase(),
  );
  const scoped = (qualifier: string) =>
    conjuncts.includes(`${qualifier.toLowerCase()}.slot = ?1`) ||
    (qualifiers.length === 1 && conjuncts.includes("slot = ?1"));
  const unscoped = qualifiers.filter((qualifier) => !scoped(qualifier));
  if (unscoped.length > 0) {
    throw new SlotPredicateError(`the WHERE clause must AND slot = ?1 for ${unscoped.join(", ")}`, sql);
  }
};

/** Splits sql[start, end) at the separators found in the masked text, so nested ones are ignored. */
const splitTopLevel = (
  sql: string,
  masked: string,
  start: number,
  end: number,
  separator: RegExp,
): string[] => {
  const parts: string[] = [];
  let from = start;
  for (const match of masked.slice(start, end).matchAll(separator)) {
    parts.push(sql.slice(from, start + match.index));
    from = start + match.index + match[0].length;
  }
  parts.push(sql.slice(from, end));
  return parts;
};

/** Blanks out string literals and everything inside parentheses, keeping offsets. */
const maskNested = (sql: string): string => {
  let depth = 0;
  let quote: string | null = null;
  let out = "";
  for (const char of sql) {
    if (quote !== null) {
      if (char === quote) quote = null;
      out += " ";
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out += " ";
    } else if (char === "(") {
      out += depth === 0 ? "(" : " ";
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      out += depth === 0 ? ")" : " ";
    } else {
      out += depth === 0 ? char : " ";
    }
  }
  return out;
};
