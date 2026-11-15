import { Bot, Context, InlineKeyboard, InputFile, Keyboard } from "grammy";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import * as t from "./texts.js";
import * as db from "./db.js";
import type { Candidate, Step } from "./db.js";
import { syncCandidate } from "./sheets.js";
import {
  dateButtonLabel,
  dateLabel,
  describeWindows,
  freeDates,
  freeTimes,
  isFreeSlot,
  todayIso,
} from "./slots.js";

export const bot = new Bot(config.botToken);

const HTML = { parse_mode: "HTML" as const };
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

/* ────────────────────────── HR-чат ────────────────────────── */

/**
 * Куда слать карточки. Берём из .env, иначе из базы (команда /hr).
 * Хранение в базе избавляет от правки .env при смене чата.
 */
let hrChat: string | null = config.hrChatId;

export async function loadHrChat(): Promise<void> {
  if (!hrChat) hrChat = await db.getSetting("hr_chat_id");
}

async function bindHrChat(chatId: number | string): Promise<void> {
  hrChat = String(chatId);
  await db.setSetting("hr_chat_id", hrChat);
}

export function currentHrChat(): string | null {
  return hrChat;
}

function isHrChat(ctx: Context): boolean {
  return hrChat !== null && String(ctx.chat?.id) === hrChat;
}

/* ────────────────────────── логотип ────────────────────────── */

/**
 * Telegram выдаёт file_id на загруженное фото — им можно слать ту же картинку
 * снова, не перезаливая мегабайт на каждого кандидата. Держим его в базе.
 * Ключ завязан на размер файла: заменил логотип — file_id перевыпустится.
 */
let logoFileId: string | null = null;

function logoPath(): string | null {
  if (!config.welcomeImage) return null;
  const path = resolve(process.cwd(), config.welcomeImage);
  return existsSync(path) ? path : null;
}

function logoKey(): string | null {
  const path = logoPath();
  return path ? `logo_file_id:${statSync(path).size}` : null;
}

export async function loadLogo(): Promise<void> {
  const key = logoKey();
  logoFileId = key ? await db.getSetting(key) : null;
  if (!logoPath() && config.welcomeImage) {
    console.warn(
      `[логотип] файл ${config.welcomeImage} не найден — приветствие уйдёт текстом`,
    );
  }
}

/** Приветствие: логотип + подпись + кнопка «Начать». */
async function sendWelcome(ctx: Context): Promise<void> {
  const options = {
    ...HTML,
    reply_markup: new InlineKeyboard().text(t.btn.begin, "begin"),
  };

  const path = logoPath();
  const key = logoKey();
  if (!path || !key) {
    await ctx.reply(t.welcome, options);
    return;
  }

  if (logoFileId) {
    try {
      await ctx.replyWithPhoto(logoFileId, { caption: t.welcome, ...options });
      return;
    } catch {
      logoFileId = null; // file_id протух — перезальём файлом
    }
  }

  try {
    const msg = await ctx.replyWithPhoto(new InputFile(path), {
      caption: t.welcome,
      ...options,
    });
    const largest = msg.photo?.[msg.photo.length - 1];
    if (largest) {
      logoFileId = largest.file_id;
      await db.setSetting(key, logoFileId);
    }
  } catch (err) {
    console.error("[логотип] не удалось отправить фото:", err);
    await ctx.reply(t.welcome, options);
  }
}

/* ────────────────────────── утилиты ────────────────────────── */

function esc(s: string | null | undefined): string {
  return (s ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return "+7" + digits.slice(1);
  }
  if (digits.length === 10) return "+7" + digits;
  if (digits.length >= 11 && digits.length <= 15) return "+" + digits;
  return null;
}

const USERNAME_RE = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/;

function normalizeUsername(raw: string): string | null {
  const m = raw.trim().replace(/^https?:\/\/t\.me\//i, "").match(USERNAME_RE);
  return m ? "@" + m[1] : null;
}

function looksLikeName(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2 || s.length > 80) return false;
  if (s.startsWith("/")) return false;
  return /\p{L}/u.test(s);
}

function looksLikeUrl(raw: string): boolean {
  const s = raw.trim();
  if (/\s/.test(s)) return false;
  return /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(s);
}

/* ─────────────────── порядок шагов анкеты ─────────────────── */

const STEP_ORDER: Step[] = [
  "consent",
  "name",
  "phone",
  "telegram",
  "resume",
  "about",
  "date",
  "time",
  "done",
];

function stepEnabled(step: Step): boolean {
  if (step === "resume") return config.askResume;
  if (step === "about") return config.askAbout;
  return true;
}

function nextStep(current: Step): Step {
  let i = STEP_ORDER.indexOf(current) + 1;
  while (i < STEP_ORDER.length) {
    const step = STEP_ORDER[i]!;
    if (stepEnabled(step)) return step;
    i++;
  }
  return "done";
}

/* ────────────────────── клавиатуры ────────────────────── */

const phoneKeyboard = new Keyboard()
  .requestContact(t.btn.phone)
  .resized()
  .oneTime();

function telegramKeyboard(username: string | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (username) kb.text(t.btn.useUsername(username), "tg:use").row();
  kb.text(t.btn.noUsername, "tg:none");
  return kb;
}

const skipKeyboard = (what: string) =>
  new InlineKeyboard().text(t.btn.skip, `skip:${what}`);

function datesKeyboard(dates: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const iso of dates) kb.text(dateButtonLabel(iso), `d:${iso}`).row();
  return kb;
}

function timesKeyboard(iso: string, times: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  times.forEach((time, i) => {
    kb.text(time, `t:${iso}:${time}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text(t.btn.backToDates, "back:dates");
  return kb;
}

/* ─────────────────── карточка кандидата ─────────────────── */

const STATUS_LABEL: Record<db.Status, string> = {
  new: "🆕 Новый",
  no_answer: "📵 Не дозвонились",
  invited: "✅ Приглашён",
  hired: "🎓 Вышел на работу",
  reserve: "🕓 В резерве",
  rejected: "❌ Отказ",
};

function hrCardText(c: Candidate): string {
  const slot =
    c.call_date && c.call_time
      ? `<b>${dateLabel(c.call_date)} в ${c.call_time}</b> (мск)`
      : "не выбран";

  const lines = [
    `🆕 <b>Новый кандидат</b> — менеджер по продажам`,
    ``,
    `<b>Имя:</b> ${esc(c.full_name)}`,
    `<b>Телефон:</b> <code>${esc(c.phone)}</code>`,
    `<b>Telegram:</b> ${esc(c.telegram)} · <a href="tg://user?id=${c.tg_id}">написать</a>`,
  ];
  if (c.resume_url) lines.push(`<b>Резюме:</b> ${esc(c.resume_url)}`);
  if (c.about) {
    const short = c.about.length > 600 ? c.about.slice(0, 600) + "…" : c.about;
    lines.push(``, `<b>О себе:</b>`, `<i>${esc(short)}</i>`);
  }
  lines.push(``, `📞 <b>Созвон:</b> ${slot}`);
  if (c.source) lines.push(`<b>Источник:</b> ${esc(c.source)}`);
  if (c.hr_note) lines.push(``, `📝 <b>Комментарий HR:</b>`, `<i>${esc(c.hr_note)}</i>`);
  lines.push(``, `<i>#${c.id}</i>`);
  return lines.join("\n");
}

function hrKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Пригласить", `hr:invited:${id}`)
    .text("🎓 Вышел", `hr:hired:${id}`)
    .row()
    .text("📵 Не дозвонились", `hr:no_answer:${id}`)
    .text("🕓 Резерв", `hr:reserve:${id}`)
    .row()
    .text("❌ Отказ", `hr:rejected:${id}`);
}

async function sendHrCard(c: Candidate): Promise<void> {
  if (!hrChat) {
    console.log("[HR-чат не привязан] Новая анкета:\n" + hrCardText(c));
    return;
  }
  try {
    const msg = await bot.api.sendMessage(hrChat, hrCardText(c), {
      ...HTML,
      ...NO_PREVIEW,
      reply_markup: hrKeyboard(c.id),
    });
    await db.update(Number(c.tg_id), { hr_message_id: msg.message_id });
  } catch (err) {
    console.error("[HR] не удалось отправить карточку:", err);
  }
}

/* ─────────────────────── шаги анкеты ─────────────────────── */

async function promptStep(ctx: Context, c: Candidate): Promise<void> {
  switch (c.step) {
    case "consent":
      await sendWelcome(ctx);
      return;

    case "name":
      await ctx.reply(t.askName, HTML);
      return;

    case "phone":
      await ctx.reply(t.askPhone(esc(c.full_name?.split(" ")[0])), {
        ...HTML,
        reply_markup: phoneKeyboard,
      });
      return;

    case "telegram": {
      const username = ctx.from?.username ?? null;
      await ctx.reply(
        username ? t.askTelegramWithGuess(username) : t.askTelegram,
        { ...HTML, reply_markup: telegramKeyboard(username) },
      );
      return;
    }

    case "resume":
      await ctx.reply(t.askResume, {
        ...HTML,
        ...NO_PREVIEW,
        reply_markup: skipKeyboard("resume"),
      });
      return;

    case "about":
      await ctx.reply(t.askAbout, { ...HTML, reply_markup: skipKeyboard("about") });
      return;

    case "date": {
      const taken = await db.takenSlots();
      const dates = freeDates(taken);
      if (dates.length === 0) {
        await finish(ctx, c);
        return;
      }
      await ctx.reply(t.askDate, { ...HTML, reply_markup: datesKeyboard(dates) });
      return;
    }

    case "time": {
      if (!c.call_date) return;
      const taken = await db.takenSlots();
      const times = freeTimes(c.call_date, taken);
      if (times.length === 0) {
        const dates = freeDates(taken);
        if (dates.length === 0) {
          await finish(ctx, c);
          return;
        }
        await ctx.reply(t.askDate, { ...HTML, reply_markup: datesKeyboard(dates) });
        return;
      }
      await ctx.reply(t.askTime(dateLabel(c.call_date)), {
        ...HTML,
        reply_markup: timesKeyboard(c.call_date, times),
      });
      return;
    }
  }
}

/** Переводит на следующий шаг и сразу показывает его. */
async function advance(
  ctx: Context,
  c: Candidate,
  patch: Record<string, unknown> = {},
): Promise<void> {
  const next = await db.update(Number(c.tg_id), {
    ...patch,
    step: nextStep(c.step),
  });
  if (next.step === "done") {
    await finish(ctx, next);
    return;
  }
  await promptStep(ctx, next);
}

/** Завершает анкету: подтверждение кандидату, карточка в HR-чат, строка в таблицу. */
async function finish(ctx: Context, c: Candidate): Promise<void> {
  const done = await db.update(Number(c.tg_id), {
    step: "done",
    completed_at: new Date(),
  });
  if (done.call_date && done.call_time) {
    await ctx.reply(t.finished(dateLabel(done.call_date), done.call_time), HTML);
  } else {
    await ctx.reply(t.noSlots, HTML);
  }
  await sendHrCard(done);
  void syncCandidate(done);
}

/* ─────────────────────── команды ─────────────────────── */

bot.command("start", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  const source = ctx.match?.trim() || null;
  const existing = await db.getByTgId(ctx.from.id);

  if (existing?.step === "done") {
    if (existing.call_date && existing.call_time) {
      await ctx.reply(
        t.alreadyDone(dateLabel(existing.call_date), existing.call_time),
        HTML,
      );
    } else {
      await ctx.reply(t.alreadyDoneNoSlot, HTML);
    }
    return;
  }

  const c = await db.getOrCreate(ctx.from.id, ctx.from.username ?? null, source);
  await promptStep(ctx, c);
});

bot.command("restart", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  await db.resetToStart(ctx.from.id);
  const c = await db.getOrCreate(ctx.from.id, ctx.from.username ?? null, null);
  await ctx.reply(t.restarted);
  await promptStep(ctx, c);
});

/** Привязать текущий чат как HR-чат. Работает где угодно. */
bot.command("hr", async (ctx) => {
  await bindHrChat(ctx.chat.id);
  await ctx.reply(
    `✅ Готово. Карточки кандидатов теперь приходят сюда.\n\n` +
      `ID чата: <code>${ctx.chat.id}</code>\n` +
      `Команды здесь: /stats — сводка, /slots — расписание, /export — выгрузка в файл.`,
    HTML,
  );
});

bot.command("chatid", async (ctx) => {
  await ctx.reply(`ID этого чата: <code>${ctx.chat.id}</code>`, HTML);
});

bot.command("stats", async (ctx) => {
  if (!isHrChat(ctx)) return;
  const s = await db.stats();
  const line = (k: db.Status) => `${STATUS_LABEL[k]}: ${s.byStatus[k] ?? 0}`;
  await ctx.reply(
    `📊 <b>Кандидаты</b>\n\n` +
      `Начали анкету: ${s.total}\n` +
      `Заполнили полностью: ${s.done}\n` +
      `Пришли сегодня: ${s.today}\n\n` +
      `${line("new")}\n${line("invited")}\n${line("reserve")}\n${line("rejected")}`,
    HTML,
  );
});

bot.command("slots", async (ctx) => {
  if (!isHrChat(ctx)) return;
  const taken = await db.takenSlots();
  const dates = freeDates(taken);
  const lines = dates.map(
    (iso) => `${dateLabel(iso)} — свободно ${freeTimes(iso, taken).length}`,
  );
  await ctx.reply(
    `🗓 <b>Расписание созвонов</b>\n\n<code>${describeWindows()}</code>\n\n` +
      `<b>Ближайшие дни</b>\n` +
      (lines.length ? lines.join("\n") : "свободных слотов нет"),
    HTML,
  );
});

bot.command("export", async (ctx) => {
  if (!isHrChat(ctx)) return;
  const rows = await db.allCompleted();
  if (rows.length === 0) {
    await ctx.reply("Пока никто не заполнил анкету до конца.");
    return;
  }
  const header = [
    "ID", "Дата анкеты", "Имя", "Телефон", "Telegram",
    "Резюме", "О себе", "Дата созвона", "Время", "Статус", "Комментарий HR", "Источник",
  ];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv =
    "﻿" +
    [header, ...rows.map((c) => [
      c.id,
      c.created_at instanceof Date ? c.created_at.toISOString().slice(0, 16).replace("T", " ") : c.created_at,
      c.full_name, c.phone, c.telegram, c.resume_url, c.about,
      c.call_date, c.call_time, STATUS_LABEL[c.status], c.hr_note, c.source,
    ])]
      .map((r) => r.map(cell).join(";"))
      .join("\r\n");

  await ctx.replyWithDocument(
    new InputFile(Buffer.from(csv, "utf8"), "candidates.csv"),
    { caption: `Кандидатов в файле: ${rows.length}` },
  );
});

/* ─────────────────── inline-кнопки кандидата ─────────────────── */

/** «Начать» под приветствием — показываем вакансию и просим согласие. */
bot.callbackQuery("begin", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  const c = await db.getByTgId(ctx.from.id);
  if (!c || c.step !== "consent") return;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(t.vacancy, { ...HTML, ...NO_PREVIEW });
  await ctx.reply(t.consent(), {
    ...HTML,
    ...NO_PREVIEW,
    reply_markup: new InlineKeyboard().text(t.btn.consent, "consent"),
  });
});

bot.callbackQuery("consent", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  const c = await db.getByTgId(ctx.from.id);
  if (!c || c.step !== "consent") return;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await advance(ctx, c, { consent_at: new Date() });
});

bot.callbackQuery("tg:use", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  const c = await db.getByTgId(ctx.from.id);
  if (!c || c.step !== "telegram") return;
  const username = ctx.from.username;
  if (!username) {
    await ctx.reply(t.askTelegram, HTML);
    return;
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await advance(ctx, c, { telegram: "@" + username });
});

bot.callbackQuery("tg:none", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  const c = await db.getByTgId(ctx.from.id);
  if (!c || c.step !== "telegram") return;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await advance(ctx, c, { telegram: "нет ника" });
});

bot.callbackQuery(/^skip:(resume|about)$/, async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  const what = ctx.match[1] as "resume" | "about";
  const c = await db.getByTgId(ctx.from.id);
  if (!c || c.step !== what) return;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await advance(ctx, c);
});

bot.callbackQuery(/^d:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  if (!ctx.from) return;
  const iso = ctx.match[1]!;
  const c = await db.getByTgId(ctx.from.id);
  if (!c || (c.step !== "date" && c.step !== "time")) {
    await ctx.answerCallbackQuery();
    return;
  }
  const taken = await db.takenSlots();
  const times = freeTimes(iso, taken);
  if (times.length === 0) {
    await ctx.answerCallbackQuery({ text: "На этот день всё занято" });
    await ctx
      .editMessageText(t.askDate, {
        ...HTML,
        reply_markup: datesKeyboard(freeDates(taken)),
      })
      .catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery();
  await db.update(ctx.from.id, { call_date: iso, step: "time" });
  await ctx
    .editMessageText(t.askTime(dateLabel(iso)), {
      ...HTML,
      reply_markup: timesKeyboard(iso, times),
    })
    .catch(() => {});
});

bot.callbackQuery("back:dates", async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  await db.update(ctx.from.id, { step: "date", call_date: null, call_time: null });
  const taken = await db.takenSlots();
  const dates = freeDates(taken);
  if (dates.length === 0) return;
  await ctx
    .editMessageText(t.askDate, { ...HTML, reply_markup: datesKeyboard(dates) })
    .catch(() => {});
});

bot.callbackQuery(/^t:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/, async (ctx) => {
  if (!ctx.from) return;
  const iso = ctx.match[1]!;
  const time = ctx.match[2]!;
  const c = await db.getByTgId(ctx.from.id);
  if (!c || c.step !== "time") {
    await ctx.answerCallbackQuery();
    return;
  }

  const showTaken = async () => {
    const fresh = await db.takenSlots();
    const times = freeTimes(iso, fresh);
    await ctx.answerCallbackQuery({ text: "Это время уже заняли" });
    if (times.length > 0) {
      await ctx
        .editMessageText(t.slotTaken, {
          ...HTML,
          reply_markup: timesKeyboard(iso, times),
        })
        .catch(() => {});
    } else {
      await ctx
        .editMessageText(t.askDate, {
          ...HTML,
          reply_markup: datesKeyboard(freeDates(fresh)),
        })
        .catch(() => {});
    }
  };

  const taken = await db.takenSlots();
  if (!isFreeSlot(iso, time, taken)) {
    await showTaken();
    return;
  }

  let updated: Candidate;
  try {
    // Гонку двух одновременных нажатий ловит уникальный индекс в базе.
    updated = await db.update(ctx.from.id, { call_date: iso, call_time: time });
  } catch (err: any) {
    if (err?.code === db.UNIQUE_VIOLATION) {
      await showTaken();
      return;
    }
    throw err;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await finish(ctx, updated);
});

/* ─────────────────── inline-кнопки HR ─────────────────── */

bot.callbackQuery(
  /^hr:(invited|hired|no_answer|reserve|rejected):(\d+)$/,
  async (ctx) => {
  if (!isHrChat(ctx)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const status = ctx.match[1] as db.Status;
  const id = Number(ctx.match[2]);
  const existing = await db.getById(id);
  if (!existing) {
    await ctx.answerCallbackQuery({ text: "Кандидат не найден" });
    return;
  }
  const updated = await db.setStatus(id, status);
  const who = ctx.from?.first_name ?? "HR";
  await ctx.answerCallbackQuery({ text: STATUS_LABEL[status] });
  await ctx
    .editMessageText(
      `${hrCardText(updated)}\n\n<b>${STATUS_LABEL[status]}</b> — ${esc(who)}`,
      { ...HTML, ...NO_PREVIEW, reply_markup: hrKeyboard(id) },
    )
    .catch(() => {});
  void syncCandidate(updated);
});

/* ─────────────── бота добавили в группу ─────────────── */

bot.on("my_chat_member", async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const joined = status === "member" || status === "administrator";
  if (!isGroup || !joined) return;
  if (hrChat) return; // уже привязан — не перехватываем

  await bindHrChat(ctx.chat.id);
  await ctx.reply(
    `👋 Привет! Я буду присылать сюда карточки кандидатов.\n\n` +
      `Команды: /stats — сводка, /slots — расписание, /export — выгрузка в файл.\n` +
      `Если нужно перепривязать меня к другому чату — отправьте там /hr`,
  );
});

/* ────────── комментарий HR: ответ на карточку в группе ────────── */

/**
 * Екатерина отвечает на карточку прямо в группе — текст попадает в hr_note
 * и в выгрузку. Это дешевле, чем отдельная форма, и привычнее в переписке.
 */
bot.on("message:text", async (ctx, next) => {
  if (!isHrChat(ctx)) return next();

  const replyTo = ctx.message.reply_to_message?.message_id;
  const text = ctx.message.text.trim();
  if (!replyTo || !text || text.startsWith("/")) return next();

  const card = await db.getByHrMessageId(replyTo);
  if (!card) return next();

  const who = ctx.from?.first_name ?? "HR";
  const updated = await db.appendNote(card.id, `${who}: ${text}`);

  await ctx.api
    .editMessageText(ctx.chat.id, replyTo, hrCardText(updated), {
      ...HTML,
      ...NO_PREVIEW,
      reply_markup: hrKeyboard(updated.id),
    })
    .catch(() => {});
  await ctx.react("👌").catch(() => {});
  void syncCandidate(updated);
});

/* ─────────────── суточный сигнал «бот жив» ─────────────── */

async function sendHeartbeat(): Promise<void> {
  const target = config.heartbeatChat ?? hrChat;
  if (!target) return;
  const s = await db.stats();
  await bot.api.sendMessage(
    target,
    `🟢 <b>Бот работает</b>\n\n` +
      `Заполнили анкету всего: ${s.done}\n` +
      `Новых за сутки: ${s.today}\n\n` +
      `<i>Это ежедневная проверка связи. Если утром сообщения нет — бот лежит.</i>`,
    HTML,
  );
}

/**
 * Проверяем раз в минуту и запоминаем дату отправки в базе — иначе после
 * каждого перезапуска сигнал уходил бы заново.
 */
export function startHeartbeat(): void {
  const time = config.heartbeatTime;
  if (!time) {
    console.log("[heartbeat] выключен — не задан HEARTBEAT_TIME");
    return;
  }
  const tick = async () => {
    try {
      const now = new Intl.DateTimeFormat("en-GB", {
        timeZone: config.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      if (now !== time) return;
      const today = todayIso();
      if ((await db.getSetting("heartbeat_sent")) === today) return;
      await db.setSetting("heartbeat_sent", today);
      await sendHeartbeat();
      console.log("[heartbeat] сигнал отправлен");
    } catch (err) {
      console.error("[heartbeat] не удалось отправить:", err);
    }
  };
  setInterval(() => void tick(), 60_000);
  console.log(
    `[heartbeat] суточный сигнал в ${time} (${config.timezone}) → чат ${config.heartbeatChat ?? hrChat ?? "не задан"}`,
  );
}

/* ─────────────────── сообщения кандидата ─────────────────── */

bot.on("message:contact", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  const c = await db.getByTgId(ctx.from.id);
  if (!c || c.step !== "phone") return;

  const contact = ctx.message.contact;
  if (contact.user_id !== ctx.from.id) {
    await ctx.reply(t.askPhoneNotYours, { ...HTML, reply_markup: phoneKeyboard });
    return;
  }
  const phone = normalizePhone(contact.phone_number) ?? contact.phone_number;
  await ctx.reply(t.phoneAccepted, { reply_markup: { remove_keyboard: true } });
  await advance(ctx, c, { phone });
});

bot.on("message:text", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  const text = ctx.message.text.trim();
  const c = await db.getByTgId(ctx.from.id);

  if (!c) {
    const fresh = await db.getOrCreate(ctx.from.id, ctx.from.username ?? null, null);
    await promptStep(ctx, fresh);
    return;
  }

  switch (c.step) {
    case "name": {
      if (!looksLikeName(text)) {
        await ctx.reply(t.askNameRetry, HTML);
        return;
      }
      await advance(ctx, c, { full_name: text });
      return;
    }

    case "phone": {
      const phone = normalizePhone(text);
      if (!phone) {
        await ctx.reply(t.askPhoneRetry, { ...HTML, reply_markup: phoneKeyboard });
        return;
      }
      await ctx.reply(t.phoneAccepted, { reply_markup: { remove_keyboard: true } });
      await advance(ctx, c, { phone });
      return;
    }

    case "telegram": {
      const username = normalizeUsername(text);
      if (!username) {
        await ctx.reply(t.askTelegramRetry, {
          ...HTML,
          reply_markup: telegramKeyboard(ctx.from.username ?? null),
        });
        return;
      }
      await advance(ctx, c, { telegram: username });
      return;
    }

    case "resume": {
      if (!looksLikeUrl(text)) {
        await ctx.reply(t.askResumeRetry, {
          ...HTML,
          reply_markup: skipKeyboard("resume"),
        });
        return;
      }
      const url = /^https?:\/\//i.test(text) ? text : "https://" + text;
      await advance(ctx, c, { resume_url: url });
      return;
    }

    case "about": {
      if (text.length > 1000) {
        await ctx.reply(t.askAboutTooLong, {
          ...HTML,
          reply_markup: skipKeyboard("about"),
        });
        return;
      }
      await advance(ctx, c, { about: text });
      return;
    }

    case "consent":
    case "date":
    case "time":
      await ctx.reply(t.stepReminder, HTML);
      await promptStep(ctx, c);
      return;

    case "done": {
      await ctx.reply(t.afterDoneMessage, HTML);
      if (hrChat) {
        await bot.api
          .sendMessage(
            hrChat,
            `💬 <b>Сообщение от кандидата</b> ${esc(c.full_name)} (#${c.id})\n` +
              `<a href="tg://user?id=${c.tg_id}">ответить</a>\n\n${esc(text)}`,
            { ...HTML, ...NO_PREVIEW },
          )
          .catch((e) => console.error("[HR] пересылка не удалась:", e));
      }
      return;
    }
  }
});

bot.catch((err) => {
  console.error("[bot] ошибка при обработке апдейта:", err.error);
});
