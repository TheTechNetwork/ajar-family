/**
 * Thin async SQL driver interface with two adapters:
 *  - NodeSqliteDatabase — node:sqlite (a Node host; file- or memory-backed)
 *  - D1Database adapter  — Cloudflare D1 (Workers)
 * Both speak SQLite, so SqlStore's SQL is identical across runtimes.
 */
export interface SqlRow { [k: string]: unknown }

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T = SqlRow>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T = SqlRow>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** node:sqlite adapter. Import is lazy so Workers bundles never pull node:sqlite. */
export async function createNodeSqlite(path = ":memory:"): Promise<SqlDatabase> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    async exec(sql) { db.exec(sql); },
    async run(sql, params = []) { db.prepare(sql).run(...(params as never[])); },
    async get<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as never[])) as T) ?? null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

/** Minimal shape of the Cloudflare D1 binding we use. */
export interface D1Like {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
  };
  exec(sql: string): Promise<unknown>;
}

/** Cloudflare D1 adapter. */
export function createD1(db: D1Like): SqlDatabase {
  return {
    async exec(sql) {
      // D1 exec runs one statement per line; split on ";\n" to be safe.
      for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        await db.prepare(stmt).bind().run();
      }
    },
    async run(sql, params = []) { await db.prepare(sql).bind(...params).run(); },
    async get<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).bind(...params).first<T>(); },
    async all<T>(sql: string, params: unknown[] = []) { return (await db.prepare(sql).bind(...params).all<T>()).results; },
  };
}
