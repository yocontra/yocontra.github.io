# Migrations

Numbers are reserved per workstream, so parallel work never collides:

| File                                 | Owner                                            |
| ------------------------------------ | ------------------------------------------------ |
| `0001_init.sql`, `0002_sessions.sql` | existing (ranked gauntlet)                       |
| `0003_*.sql`                         | stream A: accounts, passkeys, tokens             |
| `0004_*.sql`                         | stream C: wallet (`profiles`), ledger, inventory |
| `0005_*.sql`                         | stream B: matches, ghosts, pair stats            |
| `0006_*.sql`                         | stream F: Frontier deposits and lobby state      |
| `0007_budget.sql`                    | lead: usage meter for the spend cap              |
| `0011_ledger_standoff_kinds.sql`     | stream B: `duel_draw`/`duel_froze` ledger kinds  |

A stream that needs a second migration takes the next free number above 0010 and notes it here.
Never edit a migration after it has been applied anywhere.

`0011` rebuilds `ledger` (SQLite can't alter a CHECK): every row is copied with its id, amounts,
balances and keys, and the AUTOINCREMENT high-water mark is carried over. Apply it before deploying
the Worker that books the new kinds.

`0012` (lead, from the server-gaps pass) rebuilds `ledger` again to add `dye_job`, `name_change`
and `house_round` (same copy-and-carry-over procedure as `0011`). It also adds `earnings_monthly`
(backfilled from the ledger), `most_wanted_winners`, `house_rounds`, `name_holds`, `name_changes`,
`blocks`, `reports`, `moderation_log`, `batch_guard`, and `profiles.away_seen_at`. Apply it before
deploying the Worker that serves the Most Wanted board, dyes, name changes and moderation.

`0013_turnstile_day.sql` (server pass) adds `accounts.turnstile_day`, the last UTC day the account
passed Turnstile. The web refresh route asks for a Turnstile token on the first refresh of each UTC
day. Apply it before deploying the Worker that reads the column.
