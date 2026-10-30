-- phase: expand
-- B11: a person's own prompts as a private benchmark (spec "Your own prompts", 2026-10-30).
--
-- A benchmark is private until its owner shares it. `visibility` gains `private`; the check is widened, never
-- narrowed, so an older writer that only knows public and unlisted keeps working.
--
-- An unlisted share carries a long random token in its link. Only the token's SHA-256 is stored: a database read
-- never yields a working link. The token is checked in constant time (server/bench/registry.js) and cleared when
-- the benchmark becomes private or public, so an old link stops working.
ALTER TABLE bench_benchmarks DROP CONSTRAINT bench_benchmarks_visibility;
ALTER TABLE bench_benchmarks ADD CONSTRAINT bench_benchmarks_visibility
    CHECK (visibility IN ('public', 'unlisted', 'private'));

ALTER TABLE bench_benchmarks ADD COLUMN share_token_hash text;
ALTER TABLE bench_benchmarks ADD CONSTRAINT bench_benchmarks_share_token_hash
    CHECK (share_token_hash IS NULL OR share_token_hash ~ '^[0-9a-f]{64}$');
-- At most one benchmark per token, so a hash collision cannot make a link ambiguous.
CREATE UNIQUE INDEX bench_benchmarks_share_token ON bench_benchmarks (share_token_hash)
    WHERE share_token_hash IS NOT NULL;
