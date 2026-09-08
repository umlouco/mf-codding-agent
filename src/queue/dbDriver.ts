import * as fs from 'fs';
import * as path from 'path';

interface RunInfo {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface Stmt {
  run(...params: unknown[]): RunInfo;
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface Driver {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}

/**
 * Opens the database on better-sqlite3, or on Node's built-in `node:sqlite`
 * when no native build for this host exists.
 *
 * better-sqlite3 is a native addon and has to match the Electron ABI of the
 * running VS Code, which its published prebuilds do not always cover: a fresh
 * Electron can ship before a prebuild for it does, and this extension is not
 * going to compile C++ on a user's machine. `node:sqlite` is the same SQLite
 * library, shipped inside the runtime, with no build step. Both expose the
 * same prepare/run/get/all shape and both run WAL, so the rest of this file
 * does not care which one it got. Every query below uses positional `?`
 * parameters, the one binding style both drivers agree on.
 *
 * A build made for this platform can be shipped in the extension's `bin/`
 * folder next to the Go binaries, as `bin/<platform>-<arch>/better_sqlite3.node`;
 * it is preferred over whatever `node_modules` holds, which is what lets a
 * packaged extension carry the native driver without carrying node_modules.
 */
export function openDriver(file: string): { db: Driver; impl: string } {
  // Both are marked external in esbuild.mjs, so these stay real runtime
  // requires in the bundle and either one is allowed to be absent.
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const shipped = path.join(
      __dirname,
      '..',
      'bin',
      `${process.platform}-${process.arch}`,
      'better_sqlite3.node',
    );
    const options = fs.existsSync(shipped) ? { nativeBinding: shipped } : undefined;
    return { db: new BetterSqlite3(file, options) as Driver, impl: 'better-sqlite3' };
  } catch {
    /* not installed, or built against a different ABI — fall through */
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    return { db: new DatabaseSync(file) as Driver, impl: 'node:sqlite' };
  } catch (e: any) {
    // Name the host: this is the failure a remote extension host hits, where
    // the server's Node is not the Electron runtime the same VS Code uses
    // locally, and `node:sqlite` needs Node 22.13 or newer.
    const host =
      `Node ${process.versions.node}` +
      (process.versions.electron ? `, Electron ${process.versions.electron}` : '');
    throw new Error(
      `No SQLite driver available on this host (${host}). better-sqlite3 is not ` +
        'bundled with the extension, and node:sqlite requires Node 22.13 or newer. ' +
        `(${e?.message ?? e})`,
    );
  }
}
