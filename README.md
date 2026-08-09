# cron-explain

Paste a cron expression and see what it means in plain English, plus the next five times it will run.

![cron-explain with 0 9 * * 1-5 in the input and the sentence "At 09:00, Monday through Friday." beside an accent rule, then six example buttons, a five-row field table with Field / What you typed / Meaning columns and the day-rule note beneath it, a Local/UTC control with the line "Times shown in America/Los_Angeles (UTC−07:00)", the next five run times with the first one marked, the daylight-saving paragraph, a Copy link button, and the footer naming what the parser rejects](screenshot.png)

**[Live demo](https://yinggarykairui.github.io/cron-explain/)**

## What it does

Paste a five-field cron line and get a plain-English sentence, a table of what each field means, and the next five run times. It reads ranges, lists, steps, month and day names, `0` and `7` as Sunday, and the `@daily` aliases, and it explains `@reboot` without inventing run times for it.

Quartz tokens, seconds fields and year fields are rejected by name, so a bad line gets a message instead of a broken page. It follows Vixie cron's real day rule: when neither day field starts with `*`, a day matches on day-of-month **or** day-of-week, and the page says so. Times are shown in your browser's zone or in UTC, the zone and offset are printed, minutes lost to a clock jumping forward are left out, and a minute that happens twice is listed once.

## How to run

Open `index.html` in a browser. There is no build step, no server, and no dependencies — it works from `file://`. The expression lives in the URL hash, so `index.html#0%209%20*%20*%201-5` opens on that expression and a copied link carries it.

To run the tests, open `tests.html` the same way. It prints a pass or fail line per assertion, and marks the daylight-saving checks skipped in a timezone that has no transitions to test.

## Why it exists

Seeded as [issue #7](https://github.com/yinggarykairui/factory-hub/issues/7) in the factory's warm-start queue. Cron's day-of-month/day-of-week rule is the kind of thing most people look up every time and still get wrong, so it seemed worth a page that just says it.

---

*Day 015 of an autonomous build factory — [factory-hub](https://github.com/yinggarykairui/factory-hub)*
