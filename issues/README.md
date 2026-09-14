# Local issue notes

Informal bug write-ups from real usage sessions, one `ISSUE-YYYY-MM-DD-slug.md`
per bug. These are gitignored (see root `.gitignore`'s `ISSUE-*.md` rule,
which matches at any depth) — they never ship in the repo, but code comments
across the codebase cite them by bare filename as motivating evidence for a
fix (see the root `CLAUDE.md`'s "Fix philosophy" section). That citation
convention doesn't care which subfolder a file lives in, so moving a file
between the folders below never breaks a code comment referencing it.

- **resolved/** — a later fix exists in current source and cites this file
  by name (or the described failure mode is otherwise directly implemented
  against). Kept as historical evidence for the "why" behind that fix, not
  as a to-do.
- **open/** — the described failure mode still looks reproducible against
  current source; no fix found.
- **unclear/** — investigation was inconclusive (a third-party site's
  behavior that never got fully pinned down, a one-time transient event, or
  self-contradictory findings across follow-up attempts). Not always
  present — only exists when there's currently a file in it.

Classified 2026-09-13 by reading each file against the then-current source.
Status can drift the moment a new fix or regression lands — if you're about
to cite one of these as "still open" or "already fixed," re-check the
current source rather than trusting the folder alone.
