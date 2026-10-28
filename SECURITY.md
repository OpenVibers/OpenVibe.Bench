# Security policy

OpenVibe is run in the open, and we want to hear about security problems before anyone else does.

## Reporting a vulnerability

Email **contact@openvibe.network** with "security" in the subject. Please include what you found, where (URL,
repository, file), how to reproduce it, and what an attacker could do with it. Do not open a public GitHub issue for
a vulnerability, and do not test against other people's accounts, data or streams.

We reply within 7 days, keep you updated while we fix it, and credit you when the fix ships if you would like.

## Scope

Every OpenVibe service and site (openvibe.live, openvibe.network, openvibe.meme, openvibe.today, openvibe.tools,
openvibe.media, openvibe.community, openvibe.games and the other openvibe.* domains) and every repository under
github.com/OpenVibers. Machine-readable contact details are at `/.well-known/security.txt` on each site.

## What OpenVibe.Meme holds

- Public entries: the title, kind, AI-written summary, status, times and revision. An entry is the network's record,
  not a person's row, so it is not exported or erased with an account.
- Public citations: a verbatim quote from public speech, its sha256, the canonical public URL and the source ids
  (chat message id, VOD/clip id, Rundown segment id). No private VOD bytes, thumbnails or metadata are kept.
- A person's weekly votes, saved caption lines and reports. These are exported and erased with an account.
- Network session tokens only in httpOnly cookies (`meme_at`, `meme_rt`); no token is stored in the database,
  rendered into a page or logged.

VOD 5709 and clip 483 are a fixed deny list: no title, thumbnail or quote from either is ever stored, and a
citation naming them is dropped before it is written. A citation URL is re-read daily; a 404 marks it gone.

A caption is plain text lines on a template; v1 never accepts, renders or stores an image uploaded by a person.
The `/internal/events` account route is loopback only and refuses a proxied request; nginx answers 404 for
`/internal` and `/metrics`.

## Supported versions

Only the current `main` branch, which is what runs in production, receives fixes.
