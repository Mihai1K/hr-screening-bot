import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`\n[config] Не заполнена переменная ${name} в файле .env\n`);
    process.exit(1);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export interface CallWindow {
  /** 1 = понедельник … 5 = пятница */
  weekday: number;
  /** начало окна, HH:MM */
  from: string;
  /** конец окна, HH:MM — сам не занимается */
  to: string;
}

/**
 * Разбирает строку вида "1:11:00-12:00,2:12:00-13:00".
 * Ключ — номер дня недели (пн=1 … вс=7).
 */
function parseWindows(raw: string): CallWindow[] {
  const windows: CallWindow[] = [];
  for (const chunk of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = chunk.match(/^([1-7]):(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) {
      console.error(
        `[config] Не понимаю окно "${chunk}" в CALL_WINDOWS. Формат: 1:11:00-12:00`,
      );
      process.exit(1);
    }
    const pad = (t: string) => (t.length === 4 ? "0" + t : t);
    windows.push({ weekday: Number(m[1]), from: pad(m[2]!), to: pad(m[3]!) });
  }
  return windows;
}

export const config = {
  botToken: required("BOT_TOKEN"),

  /**
   * Чат, куда падают карточки кандидатов.
   * Можно не заполнять: отправь в нужном чате /hr@имя_бота — бот запомнит сам.
   */
  hrChatId: process.env.HR_CHAT_ID?.trim() || null,

  databaseUrl: optional(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5433/hr_bot",
  ),

  timezone: optional("TIMEZONE", "Europe/Moscow"),

  /** Окна для созвонов по дням недели */
  callWindows: parseWindows(
    optional(
      "CALL_WINDOWS",
      "1:11:00-12:00,2:12:00-13:00,3:13:00-14:00,4:14:00-15:00,5:15:00-16:00",
    ),
  ),

  /** Длина одного слота в минутах */
  slotMinutes: Number(optional("SLOT_MINUTES", "10")),

  /** На сколько рабочих дней вперёд открывать запись */
  callDaysAhead: Number(optional("CALL_DAYS_AHEAD", "10")),

  /** За сколько минут до слота его ещё можно выбрать на сегодня */
  minLeadMinutes: Number(optional("MIN_LEAD_MINUTES", "90")),

  companyName: optional("COMPANY_NAME", "Медиацентр"),

  /** Ссылка на политику обработки персональных данных. Может быть пустой. */
  privacyUrl: process.env.PRIVACY_URL?.trim() || null,

  /**
   * Картинка над приветствием. Путь от корня проекта.
   * Пустая строка — приветствие уйдёт текстом, без фото.
   */
  welcomeImage: optional("WELCOME_IMAGE", "assets/logo.png"),

  /** URL веб-приложения Google Apps Script. Пусто — выгрузка в таблицу выключена. */
  sheetsUrl: process.env.GOOGLE_SHEETS_URL?.trim() || null,

  /** Общий секрет: должен совпадать со SECRET внутри Apps Script */
  sheetsSecret: process.env.GOOGLE_SHEETS_SECRET?.trim() || "",

  /** Время суточного сигнала «бот жив», HH:MM. Пусто — выключено. */
  heartbeatTime: process.env.HEARTBEAT_TIME?.trim() || null,

  /** Куда слать сигнал. Пусто — в тот же чат, что и карточки. */
  heartbeatChat: process.env.HEARTBEAT_CHAT?.trim() || null,

  /** Спрашивать ли «коротко о себе». Выключается через ASK_ABOUT=0 */
  askAbout: optional("ASK_ABOUT", "1") !== "0",

  /** Спрашивать ли ссылку на резюме. Выключается через ASK_RESUME=0 */
  askResume: optional("ASK_RESUME", "1") !== "0",
};
