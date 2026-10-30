'use strict';

/**
 * The suites Bench knows by name (B12). A results file that names one of them is matched to the benchmark of that
 * name in the registry; anything else becomes a new private benchmark of the person's own.
 *
 * A suite is a name, a version and the aliases the tools use for it. The alias list is what makes "mmlu",
 * "MMLU" and "massively multitask language understanding" the same suite.
 */
const SUITES = [
    { key: 'mmlu', title: 'MMLU', aliases: ['mmlu', 'massively multitask language understanding', 'massive multitask language understanding'] },
    { key: 'mmlu_pro', title: 'MMLU-Pro', aliases: ['mmlu_pro', 'mmlu-pro', 'mmlu pro'] },
    { key: 'gsm8k', title: 'GSM8K', aliases: ['gsm8k', 'gsm-8k', 'grade school math 8k'] },
    { key: 'humaneval', title: 'HumanEval', aliases: ['humaneval', 'human_eval', 'human-eval'] },
    { key: 'hellaswag', title: 'HellaSwag', aliases: ['hellaswag'] },
    { key: 'arc_challenge', title: 'ARC-Challenge', aliases: ['arc_challenge', 'arc-challenge', 'arc challenge'] },
    { key: 'arc_easy', title: 'ARC-Easy', aliases: ['arc_easy', 'arc-easy'] },
    { key: 'truthful_qa', title: 'TruthfulQA', aliases: ['truthful_qa', 'truthful-qa', 'truthfulqa'] },
    { key: 'winogrande', title: 'WinoGrande', aliases: ['winogrande', 'winogrande_xl'] },
    { key: 'hendrycks_math', title: 'Hendrycks MATH', aliases: ['hendrycks_math', 'math', 'hendrycks-math'] },
    { key: 'gpqa', title: 'GPQA', aliases: ['gpqa', 'gpqa_main', 'gpqa_diamond'] },
    { key: 'bigbench', title: 'BIG-bench', aliases: ['bigbench', 'big_bench', 'big-bench'] },
    { key: 'tau', title: 'tau-bench', aliases: ['tau', 'tau_bench', 'tau-bench', 'taubench'] },
    { key: 'swe_bench', title: 'SWE-bench', aliases: ['swe_bench', 'swe-bench', 'swebench'] },
    { key: 'bfcl', title: 'Berkeley Function Calling Leaderboard', aliases: ['bfcl', 'bfcl_v3', 'function_calling'] },
    { key: 'mt_bench', title: 'MT-Bench', aliases: ['mt_bench', 'mt-bench', 'mtbench'] },
    { key: 'hle', title: "Humanity's Last Exam", aliases: ['hle', 'humanitys_last_exam'] },
];

/** "ARC-Challenge" -> "arcchallenge": the name without its punctuation. */
function normalize(name) {
    return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The suite a name means, or null. */
function matchSuite(name) {
    const key = normalize(name);
    if (!key) return null;
    for (const suite of SUITES) {
        if (normalize(suite.key) === key) return suite;
        for (const alias of suite.aliases) {
            if (normalize(alias) === key) return suite;
        }
    }
    return null;
}

/** The tag a benchmark of that suite carries, so a later import finds it again. */
function suiteTag(key) {
    return 'suite:' + String(key || '').toLowerCase();
}

/** The tag every imported benchmark carries. */
const IMPORT_TAG = 'imported';

module.exports = { SUITES, normalize, matchSuite, suiteTag, IMPORT_TAG };
