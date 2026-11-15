/**
 * ─────────────────────────────────────────────────────────────
 *  Приёмник кандидатов из Telegram-бота в Google Таблицу.
 *
 *  Установка (5 минут, Google Cloud не нужен):
 *   1. Открой свою Google Таблицу.
 *   2. Расширения → Apps Script.
 *   3. Удали всё, что там есть, и вставь этот файл целиком.
 *      Замени CHANGE_ME в SECRET на своё случайное значение и положи его же
 *      в GOOGLE_SHEETS_SECRET в .env бота. Настоящее значение в Git не коммить.
 *   4. Развернуть → Новое развёртывание → тип «Веб-приложение».
 *        Запуск от имени: Я
 *        У кого есть доступ: Все
 *   5. Google попросит выдать разрешения — согласись.
 *   6. Скопируй выданный URL (вида https://script.google.com/macros/s/.../exec)
 *      и положи его в .env бота:
 *        GOOGLE_SHEETS_URL=<этот URL>
 *
 *  «У кого есть доступ: Все» означает, что URL открыт наружу, поэтому
 *  SECRET обязателен — без него запись отклоняется.
 * ─────────────────────────────────────────────────────────────
 */

var SECRET = 'CHANGE_ME';

/**
 * Имя листа (вкладки), куда писать кандидатов.
 * Пусто — пишем в первый лист таблицы.
 */
var SHEET_NAME = '';

var HEADERS = [
  'ID',
  'Дата анкеты',
  'Имя',
  'Телефон',
  'Telegram',
  'Резюме',
  'О себе',
  'Дата созвона',
  'Время',
  'Статус',
  'Комментарий HR',
  'Источник',
];

var STATUS_RU = {
  new: 'Новый',
  no_answer: 'Не дозвонились',
  invited: 'Приглашён',
  hired: 'Вышел на работу',
  reserve: 'В резерве',
  rejected: 'Отказ',
};

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var data = JSON.parse(e.postData.contents);
    if (!SECRET || data.secret !== SECRET) {
      return json({ ok: false, error: 'bad secret' });
    }

    var c = data.candidate;
    var sheet = targetSheet();
    ensureHeaders(sheet);

    var row = [
      c.id,
      c.created_at,
      c.full_name,
      c.phone,
      c.telegram,
      c.resume_url,
      c.about,
      c.call_date,
      c.call_time,
      STATUS_RU[c.status] || c.status,
      c.hr_note,
      c.source,
    ];

    var target = findRowById(sheet, c.id);
    if (target === -1) {
      sheet.appendRow(row);
      target = sheet.getLastRow();
    } else {
      sheet.getRange(target, 1, 1, row.length).setValues([row]);
    }
    // телефон и время — текстом, иначе Таблицы съедят «+» и превратят 11:00 в дату
    sheet.getRange(target, 4).setNumberFormat('@');
    sheet.getRange(target, 9).setNumberFormat('@');

    return json({ ok: true, row: target });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json({ ok: true, note: 'HR bot sheets endpoint is alive' });
}

function targetSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (SHEET_NAME) {
    var named = ss.getSheetByName(SHEET_NAME);
    if (named) return named;
    return ss.insertSheet(SHEET_NAME);
  }
  return ss.getSheets()[0];
}

function ensureHeaders(sheet) {
  // Шапку переписываем и когда добавились новые колонки — иначе после
  // обновления скрипта данные уехали бы под старые заголовки.
  if (sheet.getLastRow() > 0 && sheet.getLastColumn() >= HEADERS.length) return;
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(7, 320); // «О себе» пошире
}

function findRowById(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
