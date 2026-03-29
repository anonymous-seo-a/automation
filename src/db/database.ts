import Database from 'better-sqlite3';
import { config } from '../config';

let db: Database.Database;

export function getDB(): Database.Database {
  if (!db) {
    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDB(): void {
  if (db) {
    db.close();
  }
}
