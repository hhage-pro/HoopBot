import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hoops.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL UNIQUE,        -- ISO date YYYY-MM-DD of the game
    open_at TEXT NOT NULL,                  -- ISO datetime when signups open
    status TEXT NOT NULL DEFAULT 'pending', -- pending | open | closed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    sender_jid TEXT NOT NULL,
    display_name TEXT NOT NULL,
    plus_count INTEGER NOT NULL DEFAULT 0,  -- 0 = just the person, 1 = +1 friend, etc.
    signed_up_at TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id),
    UNIQUE(game_id, sender_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_signups_game_time ON signups(game_id, signed_up_at);
`);

export const queries = {
  getOrCreateGame: db.prepare(`
    INSERT INTO games (game_date, open_at, status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(game_date) DO UPDATE SET open_at = excluded.open_at
    RETURNING *
  `),

  getGameByDate: db.prepare(`SELECT * FROM games WHERE game_date = ?`),

  setGameStatus: db.prepare(`UPDATE games SET status = ? WHERE id = ?`),

  getNextOpenGame: db.prepare(`
    SELECT * FROM games
    WHERE status = 'open'
    ORDER BY game_date ASC
    LIMIT 1
  `),

  addSignup: db.prepare(`
    INSERT INTO signups (game_id, sender_jid, display_name, plus_count, signed_up_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id, sender_jid) DO UPDATE SET
      plus_count = excluded.plus_count,
      display_name = excluded.display_name
    RETURNING *
  `),

  removeSignup: db.prepare(`
    DELETE FROM signups WHERE game_id = ? AND sender_jid = ?
  `),

  getSignup: db.prepare(`
    SELECT * FROM signups WHERE game_id = ? AND sender_jid = ?
  `),

  getAllSignupsForGame: db.prepare(`
    SELECT * FROM signups WHERE game_id = ? ORDER BY signed_up_at ASC, id ASC
  `),
};

export default db;
