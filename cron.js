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
    Object.freeze({ key: 'minute', label: 'minute', unit: 'minute', min: 0, max: 59, names: null }),
    Object.freeze({ key: 'hour', label: 'hour', unit: 'hour', min: 0, max: 23, names: null }),
    Object.freeze({ key: 'dom', label: 'day-of-month', unit: 'day of the month', min: 1, max: 31, names: null }),
    Object.freeze({ key: 'month', label: 'month', unit: 'month', min: 1, max: 12, names: MONTH_ABBR }),
    Object.freeze({ key: 'dow', label: 'day-of-week', unit: 'day of the week', min: 0, max: 7, names: DAY_ABBR })
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
      return { message: 'The ' + def.label + ' field uses "#", a Quartz token (nth weekday of the month). This parser accepts standard Vixie/POSIX cron only.' };
    }
    var atoms = raw.split(/[,\-/]/);
    for (var i = 0; i < atoms.length; i++) {
      if (QUARTZ_ATOM.test(atoms[i])) {
        return { message: 'The ' + def.label + ' field uses "' + atoms[i] + '", a Quartz token. This parser accepts standard Vixie/POSIX cron only (no ?, L, W, LW, C or #).' };
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
        return fail(null, 'Unknown alias "' + text + '". Known aliases: @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly, @reboot.');
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
        return fail(null, 'Found ' + parts.length + ' fields; this parser takes 5 (minute hour day-of-month month day-of-week). A leading seconds field or a trailing year field is not supported.');
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

  global.CronExplain = { parse: parse };
}(typeof window !== 'undefined' ? window : this));
