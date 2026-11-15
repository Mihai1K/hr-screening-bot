import { config } from "./config.js";

const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** Ключ слота для множества занятых */
export function slotKey(iso: string, time: string): string {
  return `${iso}|${time}`;
}

/* ─────────────────────── время и даты ─────────────────────── */

/** Сегодняшняя дата в рабочей таймзоне, формат YYYY-MM-DD */
export function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Текущее время в рабочей таймзоне, в минутах от полуночи */
function nowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function fromMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** ISO-строка даты → Date в полдень UTC (безопасно для арифметики по дням) */
function isoToDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function addDays(iso: string, days: number): string {
  const d = isoToDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 1 = понедельник … 7 = воскресенье */
function weekday(iso: string): number {
  const day = isoToDate(iso).getUTCDay();
  return day === 0 ? 7 : day;
}

/** «30 июля, чт» */
export function dateLabel(iso: string): string {
  const d = isoToDate(iso);
  return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}, ${WEEKDAYS_SHORT[d.getUTCDay()]}`;
}

/** Подпись на кнопке: «Завтра, 29 июля, ср» */
export function dateButtonLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return `Сегодня, ${dateLabel(iso)}`;
  if (iso === addDays(today, 1)) return `Завтра, ${dateLabel(iso)}`;
  return dateLabel(iso);
}

/* ─────────────────────── генерация слотов ─────────────────────── */

/**
 * Все слоты дня по окну из CALL_WINDOWS, нарезанные по SLOT_MINUTES.
 * На сегодня отбрасываем всё, до чего осталось меньше MIN_LEAD_MINUTES.
 * Занятость здесь не учитывается — для этого freeTimes().
 */
export function slotsForDate(iso: string): string[] {
  const win = config.callWindows.find((w) => w.weekday === weekday(iso));
  if (!win) return [];

  const start = toMinutes(win.from);
  const end = toMinutes(win.to);
  const step = config.slotMinutes;
  if (step <= 0 || end <= start) return [];

  const cutoff = iso === todayIso() ? nowMinutes() + config.minLeadMinutes : -1;

  const slots: string[] = [];
  for (let m = start; m < end; m += step) {
    if (m >= cutoff) slots.push(fromMinutes(m));
  }
  return slots;
}

/** Свободные времена дня — слоты минус занятые */
export function freeTimes(iso: string, taken: Set<string>): string[] {
  return slotsForDate(iso).filter((t) => !taken.has(slotKey(iso, t)));
}

/** Ближайшие дни, где есть хотя бы один свободный слот */
export function freeDates(taken: Set<string>): string[] {
  const result: string[] = [];
  let cursor = todayIso();
  const horizon = config.callDaysAhead * 3 + 14; // запас на выходные
  for (let i = 0; i < horizon && result.length < config.callDaysAhead; i++) {
    if (freeTimes(cursor, taken).length > 0) result.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return result;
}

export function isFreeSlot(
  iso: string,
  time: string,
  taken: Set<string>,
): boolean {
  return freeTimes(iso, taken).includes(time);
}

/** Человекочитаемое расписание окон — для README и команды /slots */
export function describeWindows(): string {
  const names = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  return config.callWindows
    .map((w) => {
      const count = Math.max(
        0,
        Math.floor((toMinutes(w.to) - toMinutes(w.from)) / config.slotMinutes),
      );
      return `${names[w.weekday]} ${w.from}–${w.to} — ${count} слотов по ${config.slotMinutes} мин`;
    })
    .join("\n");
}
