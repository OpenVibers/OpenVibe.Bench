-- phase: expand
-- B9: battles, the gallery and the honest ratings.
--
-- A battle vote is a human_pairwise judgement with two extras: the kind's own question (games: which is more fun;
-- design: which looks more finished) and the answer to it. The network fingerprint is a hash of the voter's address,
-- never the address itself: it is only there to limit votes per network. The style of an output (its length and how
-- much markup it wears) is measured once, when the entry lands, so the ratings can control for it later.

ALTER TABLE bench_judgements ADD COLUMN question text;
ALTER TABLE bench_judgements ADD COLUMN answer text;
ALTER TABLE bench_judgements ADD COLUMN net_hash text;
CREATE INDEX bench_judgements_net ON bench_judgements (net_hash, at DESC) WHERE net_hash IS NOT NULL;

ALTER TABLE bench_entries ADD COLUMN style_length integer;
ALTER TABLE bench_entries ADD COLUMN style_markup integer;

-- A pair a person has been shown. The unique pair keeps the promise that nobody sees the same pair twice.
CREATE TABLE bench_battle_seen (
    id         text COLLATE "C" PRIMARY KEY,          -- bbs_ + ULID
    subject    text NOT NULL,                         -- the person
    pair_key   text NOT NULL,                         -- the two entry ids, sorted and joined
    round_id   text NOT NULL REFERENCES bench_rounds (id) ON DELETE CASCADE,
    kind_id    text NOT NULL REFERENCES bench_kinds (id),
    a_entry    text NOT NULL,                         -- the entry shown as pane A
    b_entry    text NOT NULL,                         -- the entry shown as pane B
    net_hash   text,                                 -- the network fingerprint, for the per-network limit
    voted_at   timestamptz,                          -- when the person cast the vote
    at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_battle_seen_id CHECK (id ~ '^bbs_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_battle_seen_pair UNIQUE (subject, pair_key)
);
CREATE INDEX bench_battle_seen_subject ON bench_battle_seen (subject, at DESC);
CREATE INDEX bench_battle_seen_net ON bench_battle_seen (net_hash, at DESC) WHERE net_hash IS NOT NULL;
