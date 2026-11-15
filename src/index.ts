import {
  bot,
  loadHrChat,
  loadLogo,
  currentHrChat,
  startHeartbeat,
} from "./bot.js";
import { initDb, pool } from "./db.js";
import { config } from "./config.js";
import { describeWindows } from "./slots.js";

/* ─────────────────── логи с отметкой времени ─────────────────── */

function stamp(): string {
  return new Date().toLocaleString("ru-RU", { timeZone: config.timezone });
}
for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => original(`[${stamp()}]`, ...args);
}

/* ─────────────────── ожидание базы ─────────────────── */

/**
 * Docker Desktop поднимается медленнее, чем стартует бот после перезагрузки.
 * Не падаем сразу, а ждём базу — иначе launchd будет перезапускать нас по кругу.
 */
async function waitForDb(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initDb();
      console.log("[db] схема готова");
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`[db] база недоступна (попытка ${i}/${attempts}), жду 5 сек`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/* ─────────────────── сторож ─────────────────── */

/**
 * Однажды опрос Telegram умер молча: процесс жил, но апдейты не забирались,
 * и никто об этом не узнал несколько часов. Больше так не делаем — если опрос
 * встал, выходим с ошибкой, и launchd поднимает процесс заново.
 */
function startWatchdog(): void {
  let ticks = 0;
  setInterval(() => {
    if (!bot.isRunning()) {
      console.error("[watchdog] опрос Telegram остановлен — выхожу на перезапуск");
      process.exit(1);
    }
    // раз в 30 минут отмечаемся в логе, чтобы было видно, что бот жив
    if (++ticks % 60 === 0) console.log("[watchdog] бот работает");
  }, 30_000);
}

/* ─────────────────── запуск ─────────────────── */

async function main() {
  await waitForDb();
  await loadHrChat();
  await loadLogo();

  await bot.api.setMyCommands([
    { command: "start", description: "Заполнить анкету" },
    { command: "restart", description: "Начать анкету заново" },
  ]);

  const me = await bot.api.getMe();
  console.log(`[bot] запущен как @${me.username}`);
  console.log("[слоты]\n" + describeWindows());

  if (currentHrChat()) {
    console.log(`[HR] карточки уходят в чат ${currentHrChat()}`);
  } else {
    console.warn(
      `[HR] чат не привязан — карточки пока пишутся в консоль.\n` +
        `     Отправь в нужном чате: /hr@${me.username}`,
    );
  }

  console.log(
    config.sheetsUrl
      ? "[sheets] выгрузка в Google Таблицу включена"
      : "[sheets] выгрузка выключена — не задан GOOGLE_SHEETS_URL",
  );

  let stopping = false;
  const stop = async (signal: string) => {
    stopping = true;
    console.log(`[bot] ${signal} — останавливаюсь`);
    await bot.stop();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  startWatchdog();
  startHeartbeat();

  // drop_pending_updates НЕ ставим: пока бот лежал, кандидаты могли что-то
  // написать, и эти сообщения надо обработать, а не выбросить.
  await bot.start({
    allowed_updates: ["message", "callback_query", "my_chat_member"],
  });

  // Сюда попадаем, только если опрос прекратился сам по себе.
  if (!stopping) {
    console.error("[bot] опрос прекратился — выхожу на перезапуск");
    process.exit(1);
  }
}

process.on("unhandledRejection", (err) => {
  console.error("[fatal] необработанная ошибка:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
