import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export type Step =
  | "consent"
  | "name"
  | "phone"
  | "telegram"
  | "resume"
  | "about"
  | "date"
  | "time"
  | "done";

export type Status =
  | "new"
  | "no_answer"
  | "invited"
  | "hired"
  | "reserve"
  | "rejected";

/** Ошибка Postgres при попытке занять уже занятый слот */
export const UNIQUE_VIOLATION = "23505";

export interface Candidate {
  id: number;
  tg_id: string;
  tg_username: string | null;
  step: Step;
  consent_at: Date | null;
  full_name: string | null;
  phone: string | null;
  telegram: string | null;
  resume_url: string | null;
  about: string | null;
  call_date: string | null; // YYYY-MM-DD
  call_time: string | null; // HH:MM
  status: Status;
  hr_message_id: string | null;
  /** Комментарий HR — приходит ответом на карточку в группе */
  hr_note: string | null;
  source: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id            SERIAL PRIMARY KEY,
  tg_id         BIGINT UNIQUE NOT NULL,
  tg_username   TEXT,
  step          TEXT NOT NULL DEFAULT 'consent',
  consent_at    TIMESTAMPTZ,
  full_name     TEXT,
  phone         TEXT,
  call_date     DATE,
  call_time     TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  hr_message_id BIGINT,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- поля, добавленные после первой версии
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS telegram   TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS resume_url TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS about      TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS hr_note    TEXT;

-- по этому полю ищем карточку, когда HR отвечает на неё в группе
CREATE INDEX IF NOT EXISTS candidates_hr_msg_idx ON candidates (hr_message_id);

CREATE INDEX IF NOT EXISTS candidates_status_idx ON candidates (status);
CREATE INDEX IF NOT EXISTS candidates_call_idx   ON candidates (call_date, call_time);

-- Созвоны индивидуальные: один слот — один кандидат.
-- Гонку двух одновременных нажатий ловим именно здесь, а не в коде.
CREATE UNIQUE INDEX IF NOT EXISTS candidates_slot_uniq
  ON candidates (call_date, call_time)
  WHERE call_date IS NOT NULL AND call_time IS NOT NULL;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export async function initDb(): Promise<void> {
  await pool.query(SCHEMA);
}

function normalize(row: any): Candidate {
  return {
    ...row,
    tg_id: String(row.tg_id),
    hr_message_id: row.hr_message_id === null ? null : String(row.hr_message_id),
    call_date:
      row.call_date instanceof Date
        ? row.call_date.toISOString().slice(0, 10)
        : row.call_date,
  };
}

/* ─────────────────────── кандидаты ─────────────────────── */

export async function getOrCreate(
  tgId: number,
  username: string | null,
  source: string | null,
): Promise<Candidate> {
  const { rows } = await pool.query(
    `INSERT INTO candidates (tg_id, tg_username, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (tg_id) DO UPDATE
       SET tg_username = EXCLUDED.tg_username,
           source      = COALESCE(candidates.source, EXCLUDED.source),
           updated_at  = now()
     RETURNING *`,
    [tgId, username, source],
  );
  return normalize(rows[0]);
}

export async function getByTgId(tgId: number): Promise<Candidate | null> {
  const { rows } = await pool.query(`SELECT * FROM candidates WHERE tg_id = $1`, [
    tgId,
  ]);
  return rows[0] ? normalize(rows[0]) : null;
}

export async function getById(id: number): Promise<Candidate | null> {
  const { rows } = await pool.query(`SELECT * FROM candidates WHERE id = $1`, [id]);
  return rows[0] ? normalize(rows[0]) : null;
}

const UPDATABLE = new Set([
  "step",
  "consent_at",
  "full_name",
  "phone",
  "telegram",
  "resume_url",
  "about",
  "call_date",
  "call_time",
  "status",
  "hr_message_id",
  "hr_note",
  "completed_at",
]);

export async function update(
  tgId: number,
  patch: Record<string, unknown>,
): Promise<Candidate> {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length === 0) {
    const existing = await getByTgId(tgId);
    if (!existing) throw new Error(`candidate ${tgId} not found`);
    return existing;
  }
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) => patch[k]);
  const { rows } = await pool.query(
    `UPDATE candidates SET ${sets}, updated_at = now() WHERE tg_id = $1 RETURNING *`,
    [tgId, ...values],
  );
  return normalize(rows[0]);
}

export async function setStatus(id: number, status: Status): Promise<Candidate> {
  const { rows } = await pool.query(
    `UPDATE candidates SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return normalize(rows[0]);
}

export async function resetToStart(tgId: number): Promise<void> {
  await pool.query(
    `UPDATE candidates
        SET step = 'consent', consent_at = NULL, full_name = NULL, phone = NULL,
            telegram = NULL, resume_url = NULL, about = NULL,
            call_date = NULL, call_time = NULL, hr_note = NULL,
            status = 'new', completed_at = NULL, updated_at = now()
      WHERE tg_id = $1`,
    [tgId],
  );
}

/** Карточка, на которую HR ответил в группе */
export async function getByHrMessageId(
  messageId: number,
): Promise<Candidate | null> {
  const { rows } = await pool.query(
    `SELECT * FROM candidates WHERE hr_message_id = $1`,
    [messageId],
  );
  return rows[0] ? normalize(rows[0]) : null;
}

/** Дописывает комментарий HR к карточке */
export async function appendNote(
  id: number,
  note: string,
): Promise<Candidate> {
  const { rows } = await pool.query(
    `UPDATE candidates
        SET hr_note = CASE
              WHEN hr_note IS NULL OR hr_note = '' THEN $2
              ELSE hr_note || E'\n' || $2
            END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, note],
  );
  return normalize(rows[0]);
}

/* ─────────────────────── слоты ─────────────────────── */

/** Множество занятых слотов в виде "YYYY-MM-DD|HH:MM" */
export async function takenSlots(): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT to_char(call_date, 'YYYY-MM-DD') AS d, call_time AS t
       FROM candidates
      WHERE call_date IS NOT NULL AND call_time IS NOT NULL`,
  );
  return new Set(rows.map((r) => `${r.d}|${r.t}`));
}

/* ─────────────────────── настройки ─────────────────────── */

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = $1`, [
    key,
  ]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

/* ─────────────────────── сводка и выгрузка ─────────────────────── */

export async function stats(): Promise<{
  total: number;
  done: number;
  today: number;
  byStatus: Record<string, number>;
}> {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int                                                        AS total,
      COUNT(*) FILTER (WHERE step = 'done')::int                           AS done,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int  AS today
    FROM candidates
  `);
  const { rows: statusRows } = await pool.query(`
    SELECT status, COUNT(*)::int AS n
      FROM candidates WHERE step = 'done' GROUP BY status
  `);
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.n;
  return { ...rows[0], byStatus };
}

export async function allCompleted(): Promise<Candidate[]> {
  const { rows } = await pool.query(
    `SELECT * FROM candidates WHERE step = 'done'
      ORDER BY call_date NULLS LAST, call_time NULLS LAST, id`,
  );
  return rows.map(normalize);
}
