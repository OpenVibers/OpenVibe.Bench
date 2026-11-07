-- phase: migrate
-- Every benchmark that existed before sharing is registered once, so canView has a row for all of them.
--
--   visibility public                         → public (Everyone)
--   visibility unlisted                       → link
--   visibility unlisted with a share token    → private (the token-only benchmark keeps its restriction)
--   visibility private                        → private (Only me)
--
-- The owner is created_by. A project-owned or service benchmark gets Bench itself, which nobody
-- can sign in as.
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'bench', 'benchmark', b.id,
    CASE
        WHEN b.created_by LIKE 'usr\_%' THEN jsonb_build_object('type', 'user', 'id', b.created_by)
        WHEN b.created_by LIKE 'gst\_%' THEN jsonb_build_object('type', 'guest', 'id', b.created_by)
        ELSE jsonb_build_object('type', 'service', 'id', 'bench')
    END,
    CASE
        WHEN b.visibility = 'public' THEN 'public'
        WHEN b.visibility = 'unlisted' AND b.share_token_hash IS NULL THEN 'link'
        ELSE 'private'
    END
FROM bench_benchmarks b
ON CONFLICT (service, kind, resource_id) DO NOTHING;
