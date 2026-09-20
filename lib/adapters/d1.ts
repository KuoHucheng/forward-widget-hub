import type { Db, DbStatement } from "../backend";
import { D1_SCHEMA_STATEMENTS, MIGRATIONS } from "../db-schema";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

let _initPromise: Promise<void> | null = null;

function isIgnorableSchemaError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e);
  return /already exists|duplicate column name/i.test(msg);
}

async function runSchemaStatement(d1: D1Database, sql: string): Promise<void> {
  // D1's prepare().run() accepts exactly one complete SQLite statement and
  // avoids the multi-statement parser used by D1 exec().
  await d1.prepare(sql).run();
}

async function ensureSchema(d1: D1Database): Promise<void> {
  for (const sql of D1_SCHEMA_STATEMENTS) {
    try {
      await runSchemaStatement(d1, sql);
    } catch (e) {
      if (!isIgnorableSchemaError(e)) throw e;
    }
  }

  for (const sql of MIGRATIONS) {
    try {
      await runSchemaStatement(d1, sql.replace(/;\s*$/, ""));
    } catch (e) {
      if (!isIgnorableSchemaError(e)) throw e;
    }
  }
}

export function createD1Db(binding: unknown): Db {
  const d1 = binding as D1Database;

  if (!_initPromise) {
    _initPromise = ensureSchema(d1).catch((e) => {
      _initPromise = null; // allow retry on next request
      throw e;
    });
  }
  const ready = _initPromise;

  return {
    prepare(sql: string): DbStatement {
      return {
        async get<T>(...params: unknown[]): Promise<T | undefined> {
          await ready;
          const stmt = d1.prepare(sql);
          const bound = params.length > 0 ? stmt.bind(...params) : stmt;
          const result = await bound.first<T>();
          return result ?? undefined;
        },
        async all<T>(...params: unknown[]): Promise<T[]> {
          await ready;
          const stmt = d1.prepare(sql);
          const bound = params.length > 0 ? stmt.bind(...params) : stmt;
          const { results } = await bound.all<T>();
          return results;
        },
        async run(...params: unknown[]): Promise<void> {
          await ready;
          const stmt = d1.prepare(sql);
          const bound = params.length > 0 ? stmt.bind(...params) : stmt;
          await bound.run();
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await ready;
      await d1.prepare(sql).run();
    },
  };
}
