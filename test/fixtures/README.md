# Fixtures, and their licences

These files are real, small samples from the public sources the importers read. They are test data, not part of
Bench's data.

- `eee/record.json` — one record from Every Eval Ever (EvalEval coalition), taken verbatim from
  `every_eval_ever/tests/data/98ea850e-7019-4728-a558-8b1819ec47c2.json` in
  <https://github.com/evaleval/every_eval_ever>. The EEE datastore and its records are published under the
  dataset card's MIT licence (<https://huggingface.co/datasets/evaleval/EEE_datastore>); the repository is
  Apache-2.0.
- `imports/lighteval-results.json` — a subset of
  `tests/reference_scores/SmolLM2-1.7B-Instruct-results-accelerate.json` from
  <https://github.com/huggingface/lighteval> (MIT). Four task entries are kept verbatim; the rest are removed.
- `imports/helm-results.json` — the real `stats.json` and `run_spec.json` of
  `commonsense-dataset=hellaswag,method=multiple_choice_joint,model=eleutherai_pythia-1b-v0` from
  <https://github.com/stanford-crfm/helm> (Apache-2.0), combined under `{ stats, run_spec }` as the importer reads
  them. They were reached through the EEE repository's test data.
- `imports/{inspect,harbor,lm-eval,promptfoo}-*.json` — the earlier B12 fixtures; their sources are named in the
  tests.
