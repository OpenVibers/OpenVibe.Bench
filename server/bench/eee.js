'use strict';

/**
 * Every Eval Ever (B2): importing the EEE datastore as external results, and exporting Bench's own runs as EEE.
 *
 * Import. The EEE datastore (github.com/evaleval/every_eval_ever, HF evaleval/EEE_datastore) is a public, MIT
 * collection of eval records in one JSON shape (`eval.schema.json`). A record is read from the datastore's own JSON
 * files, its licence is checked before anything is stored, and each evaluation result becomes one `bench_eee_records`
 * row: the model (a join name with the maker prefix and a date/channel suffix dropped, the rule of Report's
 * `server/data/ai-join.js`), the harness and its version, the task and its version, few-shot, the metric, the score
 * and the source link. The rows are *external*: they never enter Bench's ratings, boards or medians.
 *
 * A weekly job walks the datastore with a cursor in `bench_eee_syncs`, so a stopped run resumes where it stopped, and
 * one run is bounded in files and records.
 *
 * Export. A public Bench run is served as an EEE `evaluation_run` record from `exportRecords` (the route is
 * /api/v1/datasets/eee), with the per-sample scores on a companion endpoint where Bench keeps them.
 */
const { ImportError } = require('./importers/limits');

const DATASET = 'evaleval/EEE_datastore';
const REPO = 'https://github.com/evaleval/every_eval_ever';
const DATASET_URL = 'https://huggingface.co/datasets/' + DATASET;
const SCHEMA_VERSION = '0.3.0';

const SOURCE = {
    key: 'eee',
    title: 'Every Eval Ever',
    repo: REPO,
    dataset: DATASET_URL,
    schema_version: SCHEMA_VERSION,
    // The datastore's own dataset card is read at import time. There is no guessed fallback: a card that cannot be
    // read leaves the licence unknown, and a record may still state its own licence in additional_details.
    licence_url: DATASET_URL + '/blob/main/README.md',
};

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const json = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v;
};
const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const details = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * The join rule: a maker prefix is dropped, but the version is not. "openai/gpt-5.1-2026-08" and
 * "openai/gpt-5.1-2026-09" are two models, not one family row. The family is a separate field.
 */
function bareModel(v) {
    return String(v || '').toLowerCase().replace(/^[^/]+\//, '').trim();
}

/** The family of a model id: the id without a date, channel or "latest" suffix. Never the stored identity. */
function modelFamilyOf(v) {
    return bareModel(v).replace(/[-_@:](\d{4}-?\d{2}(?:-?\d{2})?|latest|free)$/, '');
}

/** A licence that forbids redistribution is not imported. An empty or "unknown" one is not a licence either. */
const NON_REDISTRIBUTABLE = /all rights reserved|proprietary|no (re)?distribution|not for (re)?distribution|research only|evaluation only|internal only|confidential|closed|^unknown$|^none$|^n\/?a$/i;
const UNKNOWN_LICENCE = /^(unknown|none|n\/?a|unlicensed|not stated|unspecified)$/i;
const licenceIsUnknown = (value) => value == null || !String(value).trim() || UNKNOWN_LICENCE.test(String(value).trim());
function allowsRedistribution(licence) {
    const text = String(licence == null ? '' : licence).trim();
    if (!text) return false;
    return !NON_REDISTRIBUTABLE.test(text);
}

/** The first licence a record states about itself, or the datastore's own. */
function recordLicenceOf(doc) {
    const meta = details(doc && doc.source_metadata);
    const direct = [meta.licence, meta.license, details(meta.additional_details).licence, details(meta.additional_details).license];
    for (const value of direct) {
        if (typeof value === 'string' && value.trim()) return { licence: value.trim(), source: 'record' };
    }
    const results = Array.isArray(doc && doc.evaluation_results) ? doc.evaluation_results : [];
    for (const result of results) {
        const data = details(result && result.source_data);
        const extra = details(data.additional_details);
        for (const value of [data.licence, data.license, extra.licence, extra.license]) {
            if (typeof value === 'string' && value.trim()) return { licence: value.trim(), source: 'record' };
        }
    }
    return null;
}

function firstText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/** Few-shot: the schema has no typed field, so the sources put it in additional_details. */
function fewShotOf(result, doc) {
    const places = [
        details(result && result.source_data && result.source_data.additional_details),
        details(result && result.generation_config && result.generation_config.additional_details),
        details(result && result.generation_config && result.generation_config.generation_args),
        details(doc && doc.source_metadata && doc.source_metadata.additional_details),
    ];
    for (const place of places) {
        for (const key of ['num_fewshot', 'few_shot', 'n_shot', 'fewshot', 'num_shots', 'shots']) {
            const value = num(place[key]);
            if (value != null) return Math.max(0, Math.round(value));
        }
    }
    return null;
}

function seedOf(result, doc) {
    const places = [
        details(result && result.generation_config && result.generation_config.generation_args),
        details(result && result.generation_config && result.generation_config.additional_details),
        details(doc && doc.source_metadata && doc.source_metadata.additional_details),
    ];
    for (const place of places) {
        for (const key of ['seed', 'random_seed']) {
            const value = place[key];
            if (value != null && String(value).trim()) return String(value).trim().slice(0, 40);
        }
    }
    return '';
}

function taskVersionOf(result) {
    const data = details(result && result.source_data);
    const extra = details(data.additional_details);
    return firstText(extra.task_version, extra.version, extra.task_revision, extra.revision, data.version);
}

/** The link back to where this record was reported, preferring a stated URL over the datastore's own path. */
function sourceUrlOf(doc, result, path) {
    const meta = details(doc && doc.source_metadata);
    const extra = details(meta.additional_details);
    const data = details(result && result.source_data);
    const dataExtra = details(data.additional_details);
    const candidates = [
        extra.source_url, extra.url, extra.paper_url,
        meta.source_organization_url,
        dataExtra.source_url, dataExtra.url,
        ...(Array.isArray(data.url) ? data.url : []),
        data.hf_repo ? 'https://huggingface.co/datasets/' + data.hf_repo : '',
        path ? DATASET_URL + '/blob/main/' + path : '',
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
    }
    return DATASET_URL;
}

/**
 * Read one EEE record into the rows it would store. It throws when the document is not an EEE record; a result
 * without a score is dropped (invalid), and a result whose stated licence forbids redistribution is dropped
 * (licence). An unread or unknown licence is kept with a null licence and `republishable: false`, so the record can
 * be read and shown as unknown but is never republished until the licence is known.
 */
function normalizeRecord(doc, { fallbackLicence = null, fallbackLicenceUrl = SOURCE.licence_url, fallbackLicenceReason = '', path = '' } = {}) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new ImportError(422, 'bench.eee_not_object', 'That file is not an EEE record.');
    }
    const resultsIn = Array.isArray(doc.evaluation_results) ? doc.evaluation_results : null;
    if (!resultsIn || !resultsIn.length) {
        throw new ImportError(422, 'bench.eee_no_results', 'That EEE record holds no evaluation results.');
    }
    const meta = details(doc.source_metadata);
    const sourceType = meta.source_type === 'evaluation_run' ? 'evaluation_run' : 'documentation';
    const relationship = ['first_party', 'third_party', 'collaborative', 'other'].includes(meta.evaluator_relationship)
        ? meta.evaluator_relationship : 'other';
    const library = details(doc.eval_library);
    const modelInfo = details(doc.model_info);
    const modelRaw = firstText(modelInfo.id, modelInfo.name);
    const model = bareModel(modelRaw) || modelRaw || 'unknown';
    const modelFamily = modelFamilyOf(modelRaw) || model;
    const developer = firstText(modelInfo.developer, modelRaw.includes('/') ? modelRaw.split('/')[0] : '');
    const stated = recordLicenceOf(doc);
    let licence = stated ? stated.licence : fallbackLicence;
    let licenceSource = stated ? 'record' : (fallbackLicence == null ? 'unknown' : 'datastore');
    let licenceReason = stated ? '' : String(fallbackLicenceReason || '');
    let licenceRead = Boolean(stated) || !licenceIsUnknown(fallbackLicence);
    if (licenceIsUnknown(licence)) {
        licence = null;
        licenceSource = 'unknown';
        licenceRead = false;
        if (!licenceReason) {
            licenceReason = stated
                ? 'the record states its licence as unknown'
                : 'the source licence could not be read';
        }
    }
    const republishable = allowsRedistribution(licence);
    const eeeId = firstText(doc.evaluation_id, modelRaw) || 'unknown';

    const record = {
        eee_id: eeeId,
        source_name: firstText(meta.source_name),
        source_type: sourceType,
        source_org: firstText(meta.source_organization_name),
        evaluator_relationship: relationship,
        licence,
        licence_source: licenceSource,
        licence_reason: licenceReason,
        licence_read: licenceRead,
        republishable,
        model,
        model_family: modelFamily,
        model_raw: modelRaw,
        developer,
        harness_name: firstText(library.name, meta.source_name, 'unknown'),
        harness_version: firstText(library.version, 'unknown'),
        retrieved_at: num(doc.retrieved_timestamp),
        // The provenance a reader needs, not a second copy of every evaluation result on every row.
        provenance: {
            schema_version: doc.schema_version == null ? null : String(doc.schema_version),
            evaluation_id: eeeId,
            retrieved_timestamp: doc.retrieved_timestamp == null ? null : String(doc.retrieved_timestamp),
            source_metadata: meta,
            model_info: modelInfo,
            eval_library: library,
        },
    };

    const results = [];
    for (const result of resultsIn) {
        if (!result || typeof result !== 'object') {
            results.push({ dropped: 'invalid', reason: 'a result is not an object' });
            continue;
        }
        const score = num(result.score_details && result.score_details.score);
        if (score == null) {
            results.push({ dropped: 'invalid', reason: 'a result has no score' });
            continue;
        }
        const metric = details(result.metric_config);
        const metricId = firstText(metric.metric_id, metric.metric_name, 'score');
        const metricName = firstText(metric.metric_name, metric.metric_id, 'score');
        const task = firstText(result.evaluation_name, result.evaluation_result_id) || 'unknown';
        // A stated licence that forbids redistribution still stops the record at the door. An unknown licence does
        // not: the row is kept, marked not republishable, so it can be shown as unknown.
        if (licence != null && !republishable) {
            results.push({ dropped: 'licence', reason: 'licence does not allow redistribution: ' + licence });
            continue;
        }
        results.push({
            allowed: true,
            task,
            task_version: taskVersionOf(result),
            few_shot: fewShotOf(result, doc),
            seed: seedOf(result, doc),
            metric_id: metricId,
            metric_name: metricName,
            lower_is_better: typeof metric.lower_is_better === 'boolean' ? metric.lower_is_better : null,
            score,
            score_min: num(metric.min_score),
            score_max: num(metric.max_score),
            evaluation_at: num(result.evaluation_timestamp != null ? result.evaluation_timestamp : doc.evaluation_timestamp),
            source_url: sourceUrlOf(doc, result, path),
            licence,
            republishable,
        });
    }
    return { record, results };
}

/**
 * The datastore's own licence, read from its dataset card. A card that cannot be read is unknown: the result has a
 * null licence, `read: false` and the reason, never a guessed MIT.
 */
async function datastoreLicence(fetchImpl = globalThis.fetch) {
    const url = SOURCE.licence_url;
    try {
        const res = await fetchImpl(url);
        if (!res || !res.ok) {
            const status = res && res.status ? ' (' + res.status + ')' : '';
            return { licence: null, url, read: false, reason: 'the dataset card could not be read' + status };
        }
        const text = await res.text();
        const line = String(text).split('\n').map((l) => l.trim()).find((l) => /^license:\s*/i.test(l));
        if (line) {
            const licence = line.replace(/^license:\s*/i, '').replace(/^["']|["']$/g, '').trim();
            if (licence && !licenceIsUnknown(licence)) return { licence, url, read: true, reason: '' };
        }
        return { licence: null, url, read: false, reason: 'the dataset card states no licence' };
    } catch (err) {
        return { licence: null, url, read: false, reason: 'the dataset card could not be read' };
    }
}

function wireExternal(row) {
    if (!row) return null;
    // A licence that was not actually read is not a licence, even when an old row carries a guessed value.
    const licence = row.licence_read ? (row.licence || null) : null;
    const licenceReason = row.licence_reason || (row.licence_read ? '' : 'the source licence was not read');
    return {
        id: row.id,
        external: true,
        eee_id: row.eee_id,
        source_type: row.source_type,
        source: {
            name: row.source_name,
            organization: row.source_org,
            url: row.source_url,
            relationship: row.evaluator_relationship,
        },
        licence,
        licence_label: licence || 'Licence unknown',
        licence_url: row.licence_url,
        licence_source: row.licence_source,
        licence_reason: licenceReason,
        licence_read: Boolean(row.licence_read),
        republishable: Boolean(row.republishable) && licence != null,
        model: row.model,
        model_family: row.model_family,
        model_raw: row.model_raw,
        developer: row.developer,
        harness: { name: row.harness_name, version: row.harness_version },
        task: row.task,
        task_version: row.task_version,
        few_shot: row.few_shot == null ? null : num(row.few_shot),
        seed: row.seed || '',
        metric: { id: row.metric_id, name: row.metric_name, lower_is_better: row.lower_is_better },
        score: row.score == null ? null : num(row.score),
        score_min: row.score_min == null ? null : num(row.score_min),
        score_max: row.score_max == null ? null : num(row.score_max),
        evaluation_at: row.evaluation_at ? iso(row.evaluation_at) : null,
        retrieved_at: row.retrieved_at ? iso(row.retrieved_at) : null,
        provenance: json(row.provenance, {}),
        created_at: iso(row.created_at),
    };
}

function createEee({ s, fetchImpl = globalThis.fetch, log = console, config = null, now = Date.now } = {}) {
    const db = s.db;
    const baseUrl = String((config && config.baseUrl) || '').replace(/\/+$/, '');

    async function getJson(url) {
        const res = await fetchImpl(url);
        if (!res || !res.ok) throw new Error('the source answered ' + (res && res.status) + ' for ' + url);
        return res.json();
    }

    async function storeRecord(doc, { path = '', readAt = s.iso(), fallbackLicence = null, fallbackLicenceUrl = SOURCE.licence_url, fallbackLicenceReason = '' } = {}) {
        const parsed = normalizeRecord(doc, { fallbackLicence, fallbackLicenceUrl, fallbackLicenceReason, path });
        const counts = { read: parsed.results.length, kept: 0, droppedLicence: 0, droppedInvalid: 0, reasons: {} };
        const note = (reason) => { counts.reasons[reason] = (counts.reasons[reason] || 0) + 1; };
        for (const result of parsed.results) {
            if (result.dropped === 'licence') { counts.droppedLicence += 1; note(result.reason); continue; }
            if (result.dropped) { counts.droppedInvalid += 1; note(result.reason); continue; }
            await db.exec(
                `INSERT INTO bench_eee_records
                    (id, eee_id, source_name, source_type, source_url, source_org, evaluator_relationship, licence,
                     licence_url, licence_source, licence_reason, licence_read, republishable, model, model_family,
                     model_raw, developer, harness_name, harness_version, task, task_version, few_shot, seed, metric_id,
                     metric_name, lower_is_better, score, score_min, score_max, evaluation_at, retrieved_at, provenance,
                     created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                     $21, $22, $23, $24, $25, $26, $27, $28, $29, $30::timestamptz, $31::timestamptz, $32::jsonb, $33::timestamptz)
                 ON CONFLICT (eee_id, task, metric_id, metric_name) DO UPDATE SET
                     score = EXCLUDED.score, score_min = EXCLUDED.score_min, score_max = EXCLUDED.score_max,
                     licence = EXCLUDED.licence, licence_url = EXCLUDED.licence_url, licence_source = EXCLUDED.licence_source,
                     licence_reason = EXCLUDED.licence_reason, licence_read = EXCLUDED.licence_read,
                     republishable = EXCLUDED.republishable, model = EXCLUDED.model, model_family = EXCLUDED.model_family,
                     source_url = EXCLUDED.source_url, harness_version = EXCLUDED.harness_version,
                     task_version = EXCLUDED.task_version, few_shot = EXCLUDED.few_shot, seed = EXCLUDED.seed,
                     retrieved_at = EXCLUDED.retrieved_at, provenance = EXCLUDED.provenance`,
                [s.newId('ber'), parsed.record.eee_id, parsed.record.source_name, parsed.record.source_type,
                    result.source_url, parsed.record.source_org, parsed.record.evaluator_relationship,
                    parsed.record.licence, parsed.record.licence_source === 'record' ? result.source_url : fallbackLicenceUrl,
                    parsed.record.licence_source, parsed.record.licence_reason, parsed.record.licence_read,
                    parsed.record.republishable, parsed.record.model, parsed.record.model_family,
                    parsed.record.model_raw, parsed.record.developer, parsed.record.harness_name,
                    parsed.record.harness_version, result.task, result.task_version, result.few_shot, result.seed,
                    result.metric_id, result.metric_name, result.lower_is_better, result.score, result.score_min,
                    result.score_max,
                    result.evaluation_at == null ? null : new Date(result.evaluation_at * 1000).toISOString(),
                    parsed.record.retrieved_at == null ? null : new Date(parsed.record.retrieved_at * 1000).toISOString(),
                    JSON.stringify(parsed.record.provenance), readAt],
            );
            counts.kept += 1;
        }
        return counts;
    }

    /** The external records, newest first, with `external: true` and their provenance. Never a Bench rating. */
    async function listRecords({ model = null, family = null, task = null, sourceType = null, republishableOnly = false, limit = 100, offset = 0 } = {}) {
        const where = [];
        const params = [];
        const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
        if (model) add('model = ?', String(model));
        if (family) add('model_family = ?', String(family));
        if (task) add('task = ?', String(task));
        if (sourceType) add('source_type = ?', String(sourceType));
        if (republishableOnly) where.push('republishable = true');
        params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
        const limitAt = params.length;
        params.push(Math.max(0, Number(offset) || 0));
        const rows = await db.many(
            `SELECT * FROM bench_eee_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY created_at DESC, id LIMIT $${limitAt} OFFSET $${params.length}`,
            params,
        );
        return rows.map(wireExternal);
    }

    async function countRecords({ model = null, family = null, task = null, sourceType = null, republishableOnly = false } = {}) {
        const where = [];
        const params = [];
        const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
        if (model) add('model = ?', String(model));
        if (family) add('model_family = ?', String(family));
        if (task) add('task = ?', String(task));
        if (sourceType) add('source_type = ?', String(sourceType));
        if (republishableOnly) where.push('republishable = true');
        const row = await db.maybe(`SELECT COUNT(*)::int AS n FROM bench_eee_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params);
        return num(row && row.n) || 0;
    }

    async function latestSync() {
        const row = await db.maybe('SELECT * FROM bench_eee_syncs ORDER BY started_at DESC LIMIT 1');
        return row ? wireSync(row) : null;
    }

    function wireSync(row) {
        const defaultLicence = row.licence_read ? (row.default_licence || null) : null;
        return {
            id: row.id,
            status: row.status,
            cursor: json(row.cursor, {}),
            collections: num(row.collections) || 0,
            files_seen: num(row.files_seen) || 0,
            records_read: num(row.records_read) || 0,
            records_kept: num(row.records_kept) || 0,
            dropped_licence: num(row.dropped_licence) || 0,
            dropped_invalid: num(row.dropped_invalid) || 0,
            dropped_reason: json(row.dropped_reason, {}),
            default_licence: defaultLicence,
            default_licence_label: defaultLicence || 'Licence unknown',
            licence_read: Boolean(row.licence_read),
            licence_reason: row.licence_reason || '',
            licence_url: row.licence_url || '',
            error: row.error || '',
            started_at: iso(row.started_at),
            updated_at: iso(row.updated_at),
            finished_at: iso(row.finished_at),
        };
    }

    async function listCollections() {
        const url = 'https://huggingface.co/api/datasets/' + DATASET + '/tree/main/data?recursive=false';
        const body = await getJson(url);
        if (!Array.isArray(body)) throw new Error('the datastore tree is not a list');
        return body
            .filter((entry) => entry && entry.type === 'directory' && entry.path)
            .map((entry) => String(entry.path).replace(/^data\//, ''))
            .sort();
    }

    async function listFiles(collection) {
        const url = 'https://huggingface.co/api/datasets/' + DATASET + '/tree/main/data/' + encodeURIComponent(collection) + '?recursive=true&limit=1000';
        const body = await getJson(url);
        if (!Array.isArray(body)) throw new Error('the collection tree is not a list');
        return body
            .filter((entry) => entry && entry.type === 'file' && /\.json$/i.test(entry.path || ''))
            .map((entry) => String(entry.path))
            .sort();
    }

    function rawUrl(path) {
        return DATASET_URL + '/resolve/main/' + path.split('/').map(encodeURIComponent).join('/');
    }

    /**
     * One bounded pass of the weekly job. It resumes the newest running sync (or starts one), walks the datastore's
     * collections and JSON files from the cursor, and stops at `maxFiles` files or `maxRecords` results. The next
     * pass continues from the same cursor. Nothing is fetched when the job is disabled.
     */
    async function sync({ maxFiles = 200, maxRecords = 5000, collections = null } = {}) {
        const licence = await datastoreLicence(fetchImpl);
        let row = await db.maybe("SELECT * FROM bench_eee_syncs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1");
        if (!row) {
            const id = s.newId('bes');
            row = await db.maybe(
                `INSERT INTO bench_eee_syncs (id, status, cursor, default_licence, licence_url, licence_reason, licence_read, started_at, updated_at)
                 VALUES ($1, 'running', '{}'::jsonb, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz) RETURNING *`,
                [id, licence.licence, licence.url, licence.reason, licence.read, s.iso()],
            );
        }
        const cursor = json(row.cursor, {});
        let collectionIndex = Number.isInteger(cursor.collection) ? cursor.collection : 0;
        let fileIndex = Number.isInteger(cursor.file) ? cursor.file : 0;
        let filesSeen = num(row.files_seen) || 0;
        let recordsRead = num(row.records_read) || 0;
        let recordsKept = num(row.records_kept) || 0;
        let droppedLicence = num(row.dropped_licence) || 0;
        let droppedInvalid = num(row.dropped_invalid) || 0;
        const reasons = { ...json(row.dropped_reason, {}) };
        let names;
        let error = '';
        let status = 'running';
        try {
            names = Array.isArray(collections) && collections.length ? collections.map(String).sort() : await listCollections();
            let inThisPass = 0;
            while (collectionIndex < names.length && inThisPass < maxFiles && recordsRead < maxRecords) {
                const paths = await listFiles(names[collectionIndex]);
                while (fileIndex < paths.length && inThisPass < maxFiles && recordsRead < maxRecords) {
                    const path = paths[fileIndex];
                    let doc;
                    try {
                        doc = await getJson(rawUrl(path));
                    } catch (err) {
                        // A single unreadable file is a skipped record, not the end of the pass.
                        droppedInvalid += 1;
                        reasons['could not read ' + path] = (reasons['could not read ' + path] || 0) + 1;
                        fileIndex += 1;
                        inThisPass += 1;
                        filesSeen += 1;
                        continue;
                    }
                    const out = await storeRecord(doc, { path, readAt: s.iso(), fallbackLicence: licence.licence, fallbackLicenceUrl: licence.url, fallbackLicenceReason: licence.reason });
                    recordsRead += out.read;
                    recordsKept += out.kept;
                    droppedLicence += out.droppedLicence;
                    droppedInvalid += out.droppedInvalid;
                    for (const [reason, count] of Object.entries(out.reasons)) reasons[reason] = (reasons[reason] || 0) + count;
                    fileIndex += 1;
                    inThisPass += 1;
                    filesSeen += 1;
                }
                if (fileIndex >= paths.length) { collectionIndex += 1; fileIndex = 0; }
            }
            if (collectionIndex >= names.length) status = 'finished';
        } catch (err) {
            status = 'failed';
            error = String((err && err.message) || err).slice(0, 500);
            log.warn('[OpenVibe.Bench] the EEE sync stopped:', error);
        }
        const nextCursor = JSON.stringify({ collection: collectionIndex, file: fileIndex });
        const updated = await db.maybe(
            `UPDATE bench_eee_syncs SET status = $1, cursor = $2::jsonb, collections = $3, files_seen = $4,
                 records_read = $5, records_kept = $6, dropped_licence = $7, dropped_invalid = $8,
                 dropped_reason = $9::jsonb, default_licence = $10, licence_url = $11, licence_reason = $12,
                 licence_read = $13, error = $14, updated_at = $15::timestamptz,
                 finished_at = CASE WHEN $1 = 'running' THEN NULL ELSE $15::timestamptz END
             WHERE id = $16 RETURNING *`,
            [status, nextCursor, names ? names.length : 0, filesSeen, recordsRead, recordsKept, droppedLicence,
                droppedInvalid, JSON.stringify(reasons), licence.licence, licence.url, licence.reason, licence.read,
                error, s.iso(), row.id],
        );
        return wireSync(updated);
    }

    // ── Export: Bench's own runs as EEE `evaluation_run` records ───────────────────────────────────────────────

    /** One public Bench run as an EEE aggregate record. Top-level extras are not allowed by the schema, so the
     *  Bench-specific facts live in the nested `additional_details` maps. */
    function eeeRecordOf(run, tasks) {
        const createdAt = iso(run.created_at) || s.iso();
        const retrieved = String(Math.floor((Date.parse(createdAt) || now()) / 1000));
        const settings = json(run.settings, {});
        const harness = json(run.harness, {});
        const route = json(run.route, {});
        const benchmarkRef = `${run.benchmark_id}@${run.benchmark_version}`;
        const sampleCount = Array.isArray(tasks) ? tasks.length : 0;
        const samplesUrl = baseUrl ? `${baseUrl}/api/v1/datasets/eee/runs/${run.id}.samples.jsonl` : null;
        const developer = firstText(route.maker, route.provider_name, (route.model && String(route.model).includes('/')) ? String(route.model).split('/')[0] : '');
        const generationArgs = {};
        if (settings.temperature != null) generationArgs.temperature = num(settings.temperature);
        if (settings.max_tokens != null && num(settings.max_tokens) > 0) generationArgs.max_tokens = num(settings.max_tokens);
        const result = {
            evaluation_result_id: `${run.id}:${run.benchmark_id}`,
            evaluation_name: `openvibe.bench.${run.benchmark_kind || 'run'}`,
            source_data: {
                dataset_name: String(run.benchmark_title || run.benchmark_id),
                source_type: 'other',
                additional_details: {
                    benchmark_id: String(run.benchmark_id),
                    benchmark_version: String(run.benchmark_version),
                    benchmark_ref: benchmarkRef,
                    task_count: String(sampleCount),
                    ...(samplesUrl ? { samples_url: samplesUrl } : {}),
                },
            },
            metric_config: {
                metric_id: 'openvibe-bench.score',
                metric_name: 'Score',
                metric_kind: 'score',
                metric_unit: 'points',
                lower_is_better: false,
                score_type: 'continuous',
                min_score: 0,
                max_score: 100,
            },
            score_details: {
                score: num(run.score),
                ...(sampleCount ? { uncertainty: { num_samples: sampleCount } } : {}),
            },
            generation_config: {
                generation_args: generationArgs,
                additional_details: {
                    ...(settings.seed != null ? { seed: String(settings.seed) } : {}),
                    ...(settings.few_shot != null ? { few_shot: String(settings.few_shot) } : {}),
                    ...(settings.effort != null ? { effort: String(settings.effort) } : {}),
                },
            },
        };
        return {
            schema_version: SCHEMA_VERSION,
            evaluation_id: `openvibe-bench/${run.id}`,
            evaluation_timestamp: createdAt,
            retrieved_timestamp: retrieved,
            source_metadata: {
                source_name: 'OpenVibe.Bench',
                source_type: 'evaluation_run',
                source_organization_name: 'OpenVibe',
                ...(baseUrl ? { source_organization_url: baseUrl } : {}),
                evaluator_relationship: 'third_party',
                additional_details: {
                    run_id: String(run.id),
                    provenance: String(run.provenance || ''),
                    benchmark: benchmarkRef,
                    provider: String(run.provider || ''),
                },
            },
            eval_library: {
                name: firstText(harness.name, 'openvibe-bench'),
                version: firstText(harness.version, 'unknown'),
            },
            model_info: {
                name: String(run.model || 'unknown'),
                // The run's own model id is the versioned one; an alias in route.model must not replace it.
                id: String(run.model || route.model || 'unknown'),
                ...(developer ? { developer } : {}),
                ...(run.provider ? { inference_platform: String(run.provider) } : {}),
                additional_details: {
                    deployment_type: 'externally_managed',
                    model_availability: 'unknown',
                    bench_model: String(run.model || ''),
                    bench_provider: String(run.provider || ''),
                },
            },
            evaluation_results: [result],
        };
    }

    /** Public Bench runs as EEE records, newest last, paged. `limit` is capped so one request stays small. */
    async function exportRecords({ offset = 0, limit = 500 } = {}) {
        const take = Math.max(1, Math.min(1000, Number(limit) || 500));
        const skip = Math.max(0, Number(offset) || 0);
        const runs = await db.many(
            `SELECT r.*, b.title AS benchmark_title, b.kind AS benchmark_kind
             FROM bench_runs r JOIN bench_benchmarks b ON b.id = r.benchmark_id
             WHERE b.visibility = 'public' AND r.provenance = 'verified' AND r.score IS NOT NULL
             ORDER BY r.created_at, r.id LIMIT $1 OFFSET $2`,
            [take, skip],
        );
        if (!runs.length) return [];
        const tasks = await db.many(
            'SELECT * FROM bench_run_tasks WHERE run_id = ANY($1::text[]) ORDER BY created_at, id',
            [runs.map((run) => String(run.id))],
        );
        const byRun = new Map();
        for (const task of tasks) {
            if (!byRun.has(task.run_id)) byRun.set(task.run_id, []);
            byRun.get(task.run_id).push(task);
        }
        return runs.map((run) => eeeRecordOf(run, byRun.get(run.id) || []));
    }

    async function exportCount() {
        const row = await db.maybe(
            "SELECT COUNT(*)::int AS n FROM bench_runs r JOIN bench_benchmarks b ON b.id = r.benchmark_id WHERE b.visibility = 'public' AND r.provenance = 'verified' AND r.score IS NOT NULL",
        );
        return num(row && row.n) || 0;
    }

    async function exportLines(options = {}) {
        const records = await exportRecords(options);
        return records.length ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '';
    }

    /** The per-sample (instance-level) lines of one public run: Bench's per-task scores and where its answer is. */
    async function samplesOf(runId) {
        const run = await db.maybe(
            `SELECT r.*, b.title AS benchmark_title, b.kind AS benchmark_kind
             FROM bench_runs r JOIN bench_benchmarks b ON b.id = r.benchmark_id
             WHERE r.id = $1 AND b.visibility = 'public' AND r.provenance = 'verified'`,
            [String(runId || '')],
        );
        if (!run) return null;
        const tasks = await db.many('SELECT * FROM bench_run_tasks WHERE run_id = $1 ORDER BY created_at, id', [run.id]);
        const evaluationId = `openvibe-bench/${run.id}`;
        return {
            run,
            lines: tasks.map((task) => JSON.stringify({
                evaluation_id: evaluationId,
                model_id: String(run.model || 'unknown'),
                sample_id: String(task.task_id),
                task_id: String(task.task_id),
                score: task.score == null ? null : num(task.score),
                cost_usd: num(task.cost_usd),
                ms: num(task.ms),
                tokens: num(task.tokens),
                ...(task.transcript_url ? { transcript_url: String(task.transcript_url) } : {}),
                artifacts: json(task.artifacts, []),
                created_at: iso(task.created_at),
            })),
        };
    }

    return {
        SOURCE, sync, storeRecord, listRecords, countRecords, latestSync,
        exportRecords, exportLines, exportCount, samplesOf,
        listCollections, listFiles, normalizeRecord,
    };
}

module.exports = {
    createEee, normalizeRecord, allowsRedistribution, recordLicenceOf, bareModel, modelFamilyOf,
    datastoreLicence, wireExternal, SOURCE, DATASET, DATASET_URL, SCHEMA_VERSION,
};
