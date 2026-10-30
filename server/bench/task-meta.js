'use strict';

/**
 * The task fields B13 adds, read the same way everywhere: a date a task was added, whether it is held out, and a
 * human time estimate with its source. `holdout` is the B1 spelling; `held_out` is the B13 one. Both mean the same.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isHeldOut(task) {
    return Boolean(task && (task.holdout === true || task.held_out === true));
}

/** "YYYY-MM-DD", or null. The definition validates it; this is the read side. */
function addedOn(task) {
    const text = String((task && task.added_on) || '').slice(0, 10);
    return DATE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}

function humanMinutes(task) {
    const n = Number(task && task.human_minutes);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

function humanMinutesSource(task) {
    const text = String((task && task.human_minutes_source) || '').trim();
    return text ? text.slice(0, 200) : null;
}

/** The first day of a "YYYY-MM" month, or null. */
function monthStart(text) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(text || ''));
    if (!m) return null;
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? `${m[1]}-${m[2]}-01` : null;
}

module.exports = { isHeldOut, addedOn, humanMinutes, humanMinutesSource, monthStart };
