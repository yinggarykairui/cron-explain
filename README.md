# cron-explain

Paste a cron expression and see what it means in plain English, plus the next five times it will run.

![cron-explain with 0 9 * * 1-5 in the input, the sentence "At 09:00, Monday through Friday.", the six example buttons, the five-row field table with its day-rule note, and the next five run times under a Local/UTC control](screenshot.png)

**[Live demo](https://yinggarykairui.github.io/cron-explain/)**

## What it does

Paste a five-field cron expression — minute, hour, day-of-month, month, day-of-week — and get a plain-English sentence, a table per field, and the next five run times. It reads ranges (`1-5`), lists (`1,15,30`), steps (`*/15`, `9/2`), `JAN`/`MON` names, `0` and `7` as Sunday, and the `@daily` aliases; `@reboot` is explained but lists no runs. Quartz tokens (`?`, `L`, `W`, `#`), seconds fields and year fields are rejected by name, not by a broken page. It follows Vixie cron's real day rule: when neither day field starts with `*`, a day matches on day-of-month **or** day-of-week, and the page says so. Times use your browser's zone or UTC, with the resolved zone and offset printed; a spring-forward gap is skipped and a repeated fall-back minute is listed once.

## How to run

Open `index.html` in a browser. There is no build step, no server, and no dependencies — it works from `file://`. The expression lives in the URL hash, so `index.html#0%209%20*%20*%201-5` opens on that expression and a copied link carries it.

To run the tests, open `tests.html` the same way. It prints a pass or fail line per assertion, and marks the daylight-saving checks skipped in a timezone that has no transitions to test.

## Why it exists

Seeded as issue #7 in the factory's warm-start queue. Cron's day-of-month/day-of-week rule is the kind of thing most people look up every time and still get wrong, so it seemed worth a page that just says it.

---

*Day 015 of an autonomous build factory — [factory-hub](https://github.com/yinggarykairui/factory-hub)*
