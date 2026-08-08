/* cron-explain — parser, describer and scheduler for five-field Vixie/POSIX cron.
 *
 * Plain classic script (no modules) so the page works from file://.
 * Exposes one global: window.CronExplain.
 *
 * Three sections, in order: PARSER, DESCRIBER, SCHEDULER.
 * Every function is pure; the only module-level state is frozen tables.
 * The parser never throws — it returns {ok:false, error:{...}}. Callers render
 * error.message directly, so messages must name the offending field.
 */
(function (global) {
  'use strict';

  /* ==================================================================
   * SECTION 1 — PARSER
   * Input: raw expression text. Output: {ok:true, fields:[...]} or
   * {ok:false, error:{field, message}}. Never throws, never mutates input.
   * ================================================================== */

  // Longer than this is a paste accident, not a cron line. Bounds the work the
  // parser can be made to do from a URL hash.
  var MAX_LENGTH = 200;

  var MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']);
  var DAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday']);
  var MONTH_ABBR = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);
  var DAY_ABBR = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

  // Field order is fixed: minute hour day-of-month month day-of-week.
  // `names` is null where names are rejected outright (minute, hour, dom).
  var FIELD_DEFS = Object.freeze([
    Object.freeze({ key: 'minute', label: 'minute', min: 0, max: 59, names: null }),
    Object.freeze({ key: 'hour', label: 'hour', min: 0, max: 23, names: null }),
    Object.freeze({ key: 'dom', label: 'day-of-month', min: 1, max: 31, names: null }),
    Object.freeze({ key: 'month', label: 'month', min: 1, max: 12, names: MONTH_ABBR }),
    Object.freeze({ key: 'dow', label: 'day-of-week', min: 0, max: 7, names: DAY_ABBR })
  ]);

  var ALIASES = Object.freeze({
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *'
  });

  // Quartz-only atoms. Detected before general parsing so the message can name
  // the token instead of complaining that "L" is not a number.
  var QUARTZ_ATOM = /^(\?|L|W|LW|C|\d+[LW]|L-\d+)$/i;

  // Space characters that look like separators but are not. \s in JS matches
  // NBSP, so this check must run before splitting or the failure is invisible.
  var FAKE_SPACE = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/;

  function fail(field, message) {
    return { ok: false, error: { field: field, message: message } };
  }

  function isDigits(s) {
    return s.length > 0 && /^[0-9]+$/.test(s);
  }

  // A single value: a number, or a name where the field allows names.
  // Returns a number, or a string message describing why it is not one.
  function parseValue(token, def) {
    if (isDigits(token)) {
      var n = parseInt(token, 10);
      if (n < def.min || n > def.max) {
        return 'The ' + def.label + ' field has ' + n + ', which is outside ' +
          def.min + '–' + def.max + '.';
      }
      return n;
    }
    if (def.names) {
      var idx = def.names.indexOf(token.toUpperCase());
      if (idx >= 0) return def.key === 'month' ? idx + 1 : idx;
      return 'The ' + def.label + ' field has "' + token + '", which is not a ' +
        def.label + ' name (' + def.names[0] + '–' + def.names[def.names.length - 1] + ') or a number ' +
        def.min + '–' + def.max + '.';
    }
    return 'The ' + def.label + ' field has "' + token + '"; expected a number ' +
      def.min + '–' + def.max + ', a range, a list, a step, or *.';
  }

  // Expand one comma-separated item into values. Returns {values:[]} or {message}.
  function parseItem(item, def) {
    if (item === '') {
      return { message: 'The ' + def.label + ' field has an empty item in its comma list.' };
    }

    var slash = item.split('/');
    if (slash.length > 2) {
      return { message: 'The ' + def.label + ' field has more than one "/" step in "' + item + '".' };
    }

    var step = 1;
    if (slash.length === 2) {
      var stepText = slash[1];
      if (stepText === '') {
        return { message: 'The ' + def.label + ' field is missing a step value after "/" in "' + item + '".' };
      }
      if (!isDigits(stepText)) {
        return { message: 'The ' + def.label + ' field has a step of "' + stepText + '"; a step must be a whole number of 1 or more.' };
      }
      step = parseInt(stepText, 10);
      if (step < 1) {
        return { message: 'The ' + def.label + ' field has a step of 0; a step must be 1 or more.' };
      }
    }

    var base = slash[0];
    var lo, hi;

    if (base === '*') {
      lo = def.min;
      hi = def.max;
    } else if (base.indexOf('-') >= 0) {
      var ends = base.split('-');
      if (ends.length !== 2 || ends[0] === '' || ends[1] === '') {
        return { message: 'The ' + def.label + ' field has a malformed range "' + base + '"; a range looks like 1-5.' };
      }
      var a = parseValue(ends[0], def);
      if (typeof a === 'string') return { message: a };
      var b = parseValue(ends[1], def);
      if (typeof b === 'string') return { message: b };
      if (a > b) {
        return { message: 'The ' + def.label + ' field has the range "' + base + '", which runs backwards; ranges do not wrap around.' };
      }
      lo = a;
      hi = b;
    } else {
      var single = parseValue(base, def);
      if (typeof single === 'string') return { message: single };
      lo = single;
      // Vixie: "N/S" steps from N to the field maximum. A bare "N" is just N.
      hi = slash.length === 2 ? def.max : single;
    }

    var values = [];
    for (var v = lo; v <= hi; v += step) values.push(v);
    return { values: values };
  }

  function parseField(raw, def) {
    if (raw.indexOf('#') >= 0) {
      return { message: 'The ' + def.label + ' field uses "#", the Quartz nth-weekday token. This parser reads standard Vixie/POSIX cron only.' };
    }
    var atoms = raw.split(/[,\-/]/);
    for (var i = 0; i < atoms.length; i++) {
      if (QUARTZ_ATOM.test(atoms[i])) {
        return { message: 'The ' + def.label + ' field uses "' + atoms[i] + '", a Quartz token. This parser reads standard Vixie/POSIX cron only.' };
      }
    }
    if (!def.names && /[a-z]/i.test(raw)) {
      return { message: 'The ' + def.label + ' field has "' + raw + '"; names are not allowed here, only numbers ' + def.min + '–' + def.max + '.' };
    }

    var seen = Object.create(null);
    var values = [];
    var items = raw.split(',');
    for (var j = 0; j < items.length; j++) {
      var got = parseItem(items[j], def);
      if (got.message) return { message: got.message };
      for (var k = 0; k < got.values.length; k++) {
        // day-of-week 7 is Sunday, same as 0. Collapse before de-duplicating.
        var value = def.key === 'dow' && got.values[k] === 7 ? 0 : got.values[k];
        if (!seen[value]) {
          seen[value] = true;
          values.push(value);
        }
      }
    }
    values.sort(function (x, y) { return x - y; });
    return {
      field: {
        key: def.key,
        label: def.label,
        raw: raw,
        values: values,
        // Vixie's star flag is literal on the raw text: "*/2" counts as
        // unrestricted for the day-of-month / day-of-week OR rule.
        star: raw.charAt(0) === '*'
      }
    };
  }

  function parse(input) {
    if (typeof input !== 'string') {
      return fail(null, 'No expression to read.');
    }
    var text = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
    if (text === '') {
      return fail(null, 'Empty expression. Type five fields: minute hour day-of-month month day-of-week.');
    }
    if (text.length > MAX_LENGTH) {
      return fail(null, 'That is ' + text.length + ' characters long; a cron line is at most ' + MAX_LENGTH + '.');
    }
    if (FAKE_SPACE.test(text)) {
      return fail(null, 'The expression contains a non-breaking or exotic space. Separate fields with plain spaces or tabs.');
    }

    if (text.charAt(0) === '@') {
      var alias = text.toLowerCase();
      if (/\s/.test(text)) {
        return fail(null, 'An @alias must stand alone, with nothing after it.');
      }
      if (alias === '@reboot') {
        return {
          ok: true, reboot: true, alias: '@reboot', expression: '@reboot',
          expanded: null, fields: []
        };
      }
      if (!Object.prototype.hasOwnProperty.call(ALIASES, alias)) {
        return fail(null, 'Unknown alias "' + text + '". Known: @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly, @reboot.');
      }
      var expandedResult = parse(ALIASES[alias]);
      expandedResult.alias = alias;
      expandedResult.expression = text;
      expandedResult.expanded = ALIASES[alias];
      return expandedResult;
    }

    var parts = text.split(/[ \t\r\n]+/);
    if (parts.length !== 5) {
      if (parts.length === 6 || parts.length === 7) {
        return fail(null, 'Found ' + parts.length + ' fields; 5 are expected: minute hour day-of-month month day-of-week. No seconds field, no year field.');
      }
      return fail(null, 'Found ' + parts.length + ' field' + (parts.length === 1 ? '' : 's') + '; 5 are expected (minute hour day-of-month month day-of-week).');
    }

    var fields = [];
    for (var i = 0; i < 5; i++) {
      var got = parseField(parts[i], FIELD_DEFS[i]);
      if (got.message) return fail(FIELD_DEFS[i].label, got.message);
      fields.push(got.field);
    }

    return {
      ok: true,
      reboot: false,
      alias: null,
      expanded: null,
      expression: parts.join(' '),
      fields: fields
    };
  }

  /* ==================================================================
   * SECTION 2 — DESCRIBER
   * Turns a parse result into English: one sentence, five table rows and
   * the day-rule note. Reads the parse result, writes nothing back.
   * ================================================================== */

  var SHORT_DAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function ordinal(n) {
    var rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + 'th';
    if (n % 10 === 1) return n + 'st';
    if (n % 10 === 2) return n + 'nd';
    if (n % 10 === 3) return n + 'rd';
    return n + 'th';
  }

  function monthName(n) { return MONTH_NAMES[n - 1]; }
  function dayName(n) { return DAY_NAMES[n]; }
  function numberName(n) { return String(n); }

  // Collapse consecutive values into "A through B" (runs of 3+), then join.
  // Long lists are truncated so a 31-value day list cannot swamp the sentence.
  function compactList(values, nameFn, limit) {
    var groups = [];
    var i = 0;
    while (i < values.length) {
      var j = i;
      while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
      if (j - i >= 2) {
        groups.push(nameFn(values[i]) + ' through ' + nameFn(values[j]));
      } else {
        for (var k = i; k <= j; k++) groups.push(nameFn(values[k]));
      }
      i = j + 1;
    }
    var max = limit || 8;
    if (groups.length > max) {
      // The tail is parenthesised so that a clause continuing after the list —
      // "of the month", "of every hour" — still attaches to the noun in front
      // of the list rather than to "and 2 more".
      return groups.slice(0, max - 1).join(', ') + ' (and ' + (groups.length - (max - 1)) + ' more)';
    }
    if (groups.length === 1) return groups[0];
    return groups.slice(0, -1).join(', ') + ' and ' + groups[groups.length - 1];
  }

  // "*/N" only — the plain-star step form, which reads better as an ordinal.
  function starStep(raw) {
    var m = /^\*\/(\d+)$/.exec(raw);
    return m ? parseInt(m[1], 10) : null;
  }

  function fieldOf(parsed, key) {
    for (var i = 0; i < parsed.fields.length; i++) {
      if (parsed.fields[i].key === key) return parsed.fields[i];
    }
    return null;
  }

  function hoursNoun(hour) {
    return (hour.values.length === 1 ? 'hour ' : 'hours ') + compactList(hour.values, numberName);
  }

  function minutesNoun(minute) {
    return (minute.values.length === 1 ? 'minute ' : 'minutes ') + compactList(minute.values, numberName);
  }

  function timePhrase(minute, hour) {
    var everyMinute = minute.values.length === 60;
    var everyHour = hour.values.length === 24;
    if (everyMinute && everyHour) return 'Every minute';
    if (everyMinute) return 'Every minute of ' + hoursNoun(hour);

    // "Every N minutes" is a claim about the gaps, so it is only true when N
    // divides the hour. "*/45" fires at :00 and :45 — a 45-minute gap, then a
    // 15-minute one — so it falls through and is named by its minutes instead.
    var step = starStep(minute.raw);
    if (step && 60 % step === 0) {
      var head = 'Every ' + (step === 1 ? 'minute' : step + ' minutes');
      return everyHour ? head : head + ' of ' + hoursNoun(hour);
    }
    if (everyHour) return 'At ' + minutesNoun(minute) + ' of every hour';

    if (minute.values.length * hour.values.length <= 8) {
      var stamps = [];
      for (var h = 0; h < hour.values.length; h++) {
        for (var m = 0; m < minute.values.length; m++) {
          stamps.push(pad2(hour.values[h]) + ':' + pad2(minute.values[m]));
        }
      }
      // Clock stamps are never collapsed into ranges: "00:00 through 18:00"
      // would read as a span rather than four separate times.
      if (stamps.length === 1) return 'At ' + stamps[0];
      return 'At ' + stamps.slice(0, -1).join(', ') + ' and ' + stamps[stamps.length - 1];
    }
    return 'At ' + minutesNoun(minute) + ' of ' + hoursNoun(hour);
  }

  // "*/1" selects the whole range, exactly as "*" does, so it restricts
  // nothing and must not add a clause. "on every 1st day of the month" and
  // "in every 1st month" are both just noise around "every".
  function isEveryValue(field) {
    return field.raw === '*' || starStep(field.raw) === 1;
  }

  function domPhrase(dom) {
    if (isEveryValue(dom)) return '';
    var step = starStep(dom.raw);
    if (step) return 'on every ' + ordinal(step) + ' day of the month';
    return 'on ' + (dom.values.length === 1 ? 'day ' : 'days ') +
      compactList(dom.values, numberName) + ' of the month';
  }

  function dowPhrase(dow) {
    if (isEveryValue(dow)) return '';
    if (dow.values.length === 7) return 'on every day of the week';
    var text = compactList(dow.values, dayName);
    // A run reads as "Monday through Friday"; anything else takes "on".
    return text.indexOf(' through ') >= 0 ? text : 'on ' + text;
  }

  function monthPhrase(month) {
    if (isEveryValue(month)) return '';
    var step = starStep(month.raw);
    if (step) return 'in every ' + ordinal(step) + ' month';
    return 'in ' + compactList(month.values, monthName);
  }

  // Vixie's rule, in words. "or" is only correct when neither raw day field
  // starts with a star; otherwise the two fields are ANDed.
  function dayPhrase(dom, dow) {
    var d = domPhrase(dom);
    var w = dowPhrase(dow);
    if (!d && !w) return '';
    if (!d) return w;
    if (!w) return d;
    if (!dom.star && !dow.star) return d + ', or ' + w;
    return d + ', and only ' + w;
  }

  function dayRuleNote(parsed) {
    // Errors and @reboot have no day fields; callers may hand either over.
    if (!parsed || !parsed.ok || parsed.reboot || parsed.fields.length !== 5) return '';
    var dom = fieldOf(parsed, 'dom');
    var dow = fieldOf(parsed, 'dow');
    if (!dom.star && !dow.star) {
      return 'Neither day field starts with *, so Vixie cron matches a day when day-of-month OR day-of-week matches — not both.';
    }
    if (dom.raw === '*' && dow.raw === '*') {
      return 'Both day fields are *, so every day matches.';
    }
    if (dom.raw === '*') {
      return 'Day-of-month is *, so the day-of-week field alone decides which days match (AND).';
    }
    if (dow.raw === '*') {
      return 'Day-of-week is *, so the day-of-month field alone decides which days match (AND).';
    }
    // What is left is a star-prefixed step such as "*/2": it restricts which
    // days run, yet Vixie's star flag is literal, so the field still counts as
    // unrestricted and the two day fields are ANDed. This is the footgun.
    var starred = dom.star
      ? (dow.star ? 'Both day fields start' : 'The day-of-month field "' + dom.raw + '" starts')
      : 'The day-of-week field "' + dow.raw + '" starts';
    return starred + ' with *, so Vixie counts it as unrestricted for this rule. ' +
      'Both day fields must match (AND), not either one.';
  }

  function describe(parsed) {
    if (!parsed.ok) return parsed.error.message;
    if (parsed.reboot) {
      return 'Once, when the machine boots. There is no clock time to predict.';
    }
    var dom = fieldOf(parsed, 'dom');
    var dow = fieldOf(parsed, 'dow');
    var time = timePhrase(fieldOf(parsed, 'minute'), fieldOf(parsed, 'hour'));
    var month = monthPhrase(fieldOf(parsed, 'month'));

    // On the OR branch the sentence carries two alternative day rules. A month
    // clause tacked on the end reads as if it qualified only the second one
    // ("on day 29 of the month, or on Friday, in February"), so a restricted
    // month leads instead and scopes both. The comma after the time phrase is
    // load-bearing: without it "every minute of hours 9 through 17 on day 15"
    // binds as one clause and "or on Friday" is left dangling.
    if (month && !dom.star && !dow.star) {
      var d = domPhrase(dom);
      var w = dowPhrase(dow);
      if (d && w) {
        return month.charAt(0).toUpperCase() + month.slice(1) + ', ' +
          time.charAt(0).toLowerCase() + time.slice(1) + ', ' + d + ' or ' + w + '.';
      }
    }

    var parts = [time];
    var day = dayPhrase(dom, dow);
    if (day) parts.push(day);
    if (month) parts.push(month);
    return parts.join(', ') + '.';
  }

  // A step that does not divide its range runs out before the range does and
  // starts again from the bottom: "*/45" is minutes 0 and 45, then the hour
  // rolls over. Saying so keeps the table and the run list from disagreeing.
  function stepMeaning(step, noun, span, cycle, values, nameFn) {
    return 'Every ' + ordinal(step) + ' ' + noun +
      (span % step === 0 ? '' : ', restarting each ' + cycle) +
      ': ' + compactList(values, nameFn);
  }

  function meaningOf(field) {
    var step = starStep(field.raw);
    var everything = isEveryValue(field);
    switch (field.key) {
      case 'minute':
        if (everything) return 'Every minute (0–59)';
        if (step) return stepMeaning(step, 'minute', 60, 'hour', field.values, numberName);
        return (field.values.length === 1 ? 'Minute ' : 'Minutes ') + compactList(field.values, numberName);
      case 'hour':
        if (everything) return 'Every hour (0–23)';
        if (step) return stepMeaning(step, 'hour', 24, 'day', field.values, numberName);
        return (field.values.length === 1 ? 'Hour ' : 'Hours ') + compactList(field.values, numberName);
      case 'dom':
        if (everything) return 'Every day of the month';
        if (step) return stepMeaning(step, 'day', 31, 'month', field.values, numberName);
        return (field.values.length === 1 ? 'Day ' : 'Days ') + compactList(field.values, numberName);
      case 'month':
        if (everything) return 'Every month';
        if (step) return stepMeaning(step, 'month', 12, 'year', field.values, monthName);
        return compactList(field.values, monthName);
      default:
        if (everything) return 'Every day of the week';
        return compactList(field.values, dayName) + (field.values.indexOf(0) >= 0 ? ' (0 and 7 both mean Sunday)' : '');
    }
  }

  function fieldRows(parsed) {
    if (!parsed.ok || parsed.reboot) return [];
    var rows = [];
    for (var i = 0; i < parsed.fields.length; i++) {
      rows.push({
        name: FIELD_DEFS[i].label,
        raw: parsed.fields[i].raw,
        meaning: meaningOf(parsed.fields[i])
      });
    }
    return rows;
  }

  // Runs carry their own wall-clock parts, so formatting is the same in both
  // timezone modes and does not depend on the host locale.
  function formatRun(run, utc) {
    return SHORT_DAYS[run.dow] + ' ' + run.y + '-' + pad2(run.mo) + '-' + pad2(run.d) +
      ' ' + pad2(run.h) + ':' + pad2(run.mi) + (utc ? ' UTC' : '');
  }

  function relativeHint(fromMs, toMs) {
    var minutes = Math.floor((toMs - fromMs) / 60000);
    if (minutes < 0) return 'now';
    if (minutes < 1) return 'in less than a minute';
    if (minutes < 60) return 'in ' + minutes + ' minute' + (minutes === 1 ? '' : 's');
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return 'in ' + hours + ' hour' + (hours === 1 ? '' : 's');
    var days = Math.floor(hours / 24);
    if (days < 60) return 'in ' + days + ' days';
    var months = Math.round(days / 30.44);
    if (months < 24) return 'in ' + months + ' months';
    return 'in ' + Math.round(days / 365.25) + ' years';
  }

  /* ==================================================================
   * SECTION 3 — SCHEDULER
   * Walks candidate days from `from`, then the hour and minute sets inside
   * a matching day. Pure: builds its own lookup tables per call.
   * ================================================================== */

  var HORIZON_YEARS = 50;

  function toSet(values) {
    var set = Object.create(null);
    for (var i = 0; i < values.length; i++) set[values[i]] = true;
    return set;
  }

  function nextRuns(parsed, options) {
    var opts = options || {};
    var count = opts.count || 5;
    var utc = !!opts.utc;
    var from = opts.from ? new Date(opts.from.getTime()) : new Date();
    var empty = { runs: [], reboot: false, complete: false, horizonYears: HORIZON_YEARS };

    if (!parsed || !parsed.ok) return empty;
    if (parsed.reboot) {
      return { runs: [], reboot: true, complete: true, horizonYears: HORIZON_YEARS };
    }

    var minute = fieldOf(parsed, 'minute');
    var hour = fieldOf(parsed, 'hour');
    var dom = fieldOf(parsed, 'dom');
    var month = fieldOf(parsed, 'month');
    var dow = fieldOf(parsed, 'dow');
    var monthSet = toSet(month.values);
    var domSet = toSet(dom.values);
    var dowSet = toSet(dow.values);

    var y = utc ? from.getUTCFullYear() : from.getFullYear();
    var mo = utc ? from.getUTCMonth() : from.getMonth();
    var d = utc ? from.getUTCDate() : from.getDate();

    // Day stepping runs on a UTC-midnight cursor even in local mode: adding
    // 24h to a local midnight can land on the wrong date across a DST seam.
    var cursor = Date.UTC(y, mo, d);
    var horizon = Date.UTC(y + HORIZON_YEARS, mo, d);
    var fromMs = from.getTime();
    var runs = [];

    while (cursor <= horizon && runs.length < count) {
      var day = new Date(cursor);
      var cy = day.getUTCFullYear();
      var cm = day.getUTCMonth() + 1;
      var cd = day.getUTCDate();
      var cw = day.getUTCDay();

      var matches = false;
      if (monthSet[cm]) {
        // Vixie: if either raw day field starts with *, both must match; only
        // when neither is starred does either one matching suffice. With a
        // plain "*" the AND branch collapses to the other field, which is why
        // "* * MON" is Mondays and "*/2 * MON" is odd-numbered Mondays.
        matches = (dom.star || dow.star)
          ? (!!domSet[cd] && !!dowSet[cw])
          : (!!domSet[cd] || !!dowSet[cw]);
      }

      if (matches) {
        for (var hi = 0; hi < hour.values.length && runs.length < count; hi++) {
          for (var mi = 0; mi < minute.values.length && runs.length < count; mi++) {
            var h = hour.values[hi];
            var m = minute.values[mi];
            var at = utc ? new Date(Date.UTC(cy, cm - 1, cd, h, m, 0, 0))
              : new Date(cy, cm - 1, cd, h, m, 0, 0);
            if (!utc) {
              // A wall-clock minute that does not read back is one the spring
              // forward skipped; it never happens, so it is not listed.
              if (at.getFullYear() !== cy || at.getMonth() !== cm - 1 || at.getDate() !== cd ||
                at.getHours() !== h || at.getMinutes() !== m) continue;
            }
            var ms = at.getTime();
            if (ms <= fromMs) continue;
            // A wall-clock minute repeated by a fall-back is listed once, but
            // nothing here enforces that: new Date(y, mo, d, h, mi) resolves an
            // ambiguous local time to its first instant, so the second pass is
            // never constructed. Candidates are generated in ascending
            // wall-clock order, and each one maps to a strictly later instant,
            // so the list increases on its own. A guard against a non-increasing
            // ms used to sit here; it never fired in any zone.
            runs.push({ ms: ms, date: at, y: cy, mo: cm, d: cd, h: h, mi: m, dow: cw });
          }
        }
      }
      cursor += 86400000;
    }

    return {
      runs: runs,
      reboot: false,
      complete: runs.length === count,
      horizonYears: HORIZON_YEARS
    };
  }

  global.CronExplain = {
    parse: parse,
    describe: describe,
    fieldRows: fieldRows,
    dayRuleNote: dayRuleNote,
    nextRuns: nextRuns,
    formatRun: formatRun,
    relativeHint: relativeHint,
    MAX_LENGTH: MAX_LENGTH,
    HORIZON_YEARS: HORIZON_YEARS
  };
}(typeof window !== 'undefined' ? window : this));
