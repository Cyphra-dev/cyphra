---
"@cyphra/cli": minor
---

New `cyphra db seed` command: runs the `"seed"` shell command from `cyphra.json` (for example `"tsx seed.ts"`) from the project root, with the CLI's environment and `node_modules/.bin` on `PATH`, and exits with its exit code. New `cyphra migrate reset`: drops every constraint and index (keeping the default LOOKUP indexes), deletes all data in batches (including migration records), reapplies every migration and runs the seed (`--skip-seed` to skip). It asks for confirmation (`--yes` / `-y` to skip, refused in a non-interactive shell without it) and refuses databases that do not look local (encrypted `+s` / `+ssc` schemes, Aura hosts, dotted host names, non-loopback IPs) unless `--force` is passed. New `cyphra generate --watch` (and `cyphra dev --watch`): regenerates the client when the schema file changes, debounced, printing schema errors without exiting; it watches the schema's directory so editors that save by renaming are picked up.
