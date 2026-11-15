import { config } from "./config.js";
import type { Candidate } from "./db.js";

/**
 * Выгрузка в Google Таблицу через веб-приложение Apps Script.
 * Скрипт лежит в google-sheets/Code.gs, инструкция — в README.
 *
 * Отправка «в фоне»: если таблица недоступна, кандидат об этом не узнает,
 * данные всё равно лежат в базе.
 */
export async function syncCandidate(c: Candidate): Promise<void> {
  if (!config.sheetsUrl) return;

  const payload = {
    secret: config.sheetsSecret,
    candidate: {
      id: c.id,
      created_at: c.created_at instanceof Date
        ? c.created_at.toISOString().slice(0, 19).replace("T", " ")
        : String(c.created_at ?? ""),
      full_name: c.full_name ?? "",
      phone: c.phone ?? "",
      telegram: c.telegram ?? (c.tg_username ? `@${c.tg_username}` : ""),
      resume_url: c.resume_url ?? "",
      about: c.about ?? "",
      call_date: c.call_date ?? "",
      call_time: c.call_time ?? "",
      status: c.status,
      hr_note: c.hr_note ?? "",
      source: c.source ?? "",
      chat_link: `tg://user?id=${c.tg_id}`,
    },
  };

  try {
    const res = await fetch(config.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok || text.includes('"ok":false')) {
      console.error("[sheets] таблица ответила ошибкой:", res.status, text.slice(0, 300));
    }
  } catch (err) {
    console.error("[sheets] не удалось записать строку:", err);
  }
}
