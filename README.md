# HR Screening Bot

A Telegram bot for first-contact candidate screening: a candidate leaves contacts and books a short call in about two minutes; the recruiter gets a card with action buttons and a row in Google Sheets.

> Russian documentation: [docs/README.ru.md](docs/README.ru.md)

## Problem

Collecting candidates by hand means chasing people for phone numbers, agreeing on a call time in chat, and copying everything into a spreadsheet. Candidates drop out while waiting for an answer.

## Solution

The bot runs the whole first step as a guided dialog and writes the result where the recruiter already works.

```
/start
  -> welcome and vacancy description
  -> personal data consent
  -> name, phone (Telegram contact button), Telegram username
  -> resume link and short "about me" (both optional)
  -> call day -> call time
  -> confirmation to the candidate
     + card in the HR chat with Invite / Reserve / Reject buttons
     + row in Google Sheets
```

## Features

- Guided funnel with per-candidate dialog state
- Call slot booking: configurable weekly windows, slot length, booking horizon and minimum lead time
- **One slot - one candidate**, enforced by a unique index in the database rather than a check in code, so two simultaneous taps cannot double-book
- HR card with inline action buttons; status changes are reflected back to the candidate record
- Google Sheets export through an Apps Script web app (`google-sheets/Code.gs`) protected by a shared secret
- Watchdog: if Telegram polling silently stops, the process exits and the service manager restarts it
- Daily heartbeat message
- Schema is created and extended automatically on first start

## Tech stack

TypeScript, grammY, PostgreSQL (`pg`), Docker Compose for the database, Google Apps Script, `tsx`.

## Layout

```
src/
  index.ts    startup, watchdog, heartbeat
  bot.ts      dialog flow and HR actions
  slots.ts    slot generation and availability
  db.ts       schema and queries
  sheets.ts   Google Sheets export
  texts.ts    all user-facing texts
  config.ts   environment parsing and validation
google-sheets/Code.gs   Apps Script receiver
```

## Run locally

```bash
cp .env.example .env     # bot token from @BotFather, database URL and password, call windows
docker compose up -d     # PostgreSQL
npm install
npm start
```

`npm run typecheck` runs the TypeScript compiler without emitting.

## Status and limitations

- Used for a real hiring funnel, running as a `launchd` service on a laptop. That protects against process crashes but not against sleep or loss of network; for a steady flow it should be moved to a server.
- No automated tests.
- User-facing texts are in Russian.

## How this was built

I designed the funnel, the slot rules and the recruiter workflow, and I operated the bot. The code was written together with an AI coding agent (Claude Code) under my specifications and review.
