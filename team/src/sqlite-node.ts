// better-sqlite3's API, as the wiki store uses it, over Node's own SQLite (node:sqlite, Node 22.13
// and newer). Only for the team brain's single-file bundle (gateway/src/team-bundle.ts), which
// can't carry a native module: everywhere else the wiki uses better-sqlite3 itself.
import { DatabaseSync } from "node:sqlite";

type Param = null | number | bigint | string | Uint8Array;

export default class Database {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  prepare(sql: string) {
    const st = this.db.prepare(sql);
    return {
      run: (...params: Param[]) => st.run(...params),
      get: (...params: Param[]) => st.get(...params),
      all: (...params: Param[]) => st.all(...params),
    };
  }

  /** fn in one transaction, as better-sqlite3's db.transaction(fn) returns it. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      this.db.exec("BEGIN");
      try {
        const out = fn(...args);
        this.db.exec("COMMIT");
        return out;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
