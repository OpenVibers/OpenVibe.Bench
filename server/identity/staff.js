'use strict';

/**
 * Who is staff at OpenVibe.Bench: the Network role claim on a person's session. contracts.staff.atLeast is the one
 * place the ranking lives.
 */
const { staff } = require('openvibe-contracts');

const STAFF_MIN = 'global_mod';

function isStaff(who) {
    if (!who || typeof who !== 'object' || who.kind !== 'user') return false;
    if (typeof who.role !== 'string' || !who.role) return false;
    try { return staff.atLeast(who.role, STAFF_MIN); } catch { return false; }
}

module.exports = { isStaff, STAFF_MIN };
