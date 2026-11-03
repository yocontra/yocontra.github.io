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

A stream that needs a second migration takes the next free number above 0010 and notes it here.
Never edit a migration after it has been applied anywhere.
