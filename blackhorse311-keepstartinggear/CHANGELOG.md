Changelog
1.1.3

Fix – Secure Container restore: Resolved the edge case where restoring gear could clash with the game’s inventory processing, leading to secure‑container items not being kept or to parent/child re‑parenting issues. Restore now happens using a late “after” hook so the game finishes its post‑raid updates before we put your kit back.

Safer late restore path: Uses the post‑menu route to minimize conflicts with insurance/mail and other mods that touch inventory right after a raid.

Exit handling polish: Exit result matching is now case‑insensitive and honors your restoreOn list. Runner exits are treated as success by default (treatRunnerAsSuccess: true), so no restore occurs unless you override it.

Config clarity: Documented how equippedOnly acts as a convenience preset that excludes Backpack + Pockets (and how to add more via excludeSlots). excludeSecureContainer remains a simple on/off switch if you want to avoid restoring it entirely. See the Configuration table above. 

Diagnostics: Cleaner logs at info level; set logLevel: "debug" to see snapshot counts, exit decisions, and when a restore is queued/performed. Optional on‑disk snapshots (persistSnapshotsOnDisk) and raw end payload dumps (dumpEndPayload) remain available for troubleshooting. 

1.1.2

Interim build: Hooked start/end routes and introduced snapshotting + basic restore, but could skip restore when the game returned exit='unknown' depending on settings. Superseded by 1.1.3’s late‑restore approach and exit handling improvements.

1.1.1

Initial release for SPT 3.11.x: Snapshot equipped PMC kit at raid start; restore it on death‑like exits; optional quickbar restore; configurable slot exclusions.