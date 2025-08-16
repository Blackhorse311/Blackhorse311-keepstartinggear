# Blackhorse311 — Keep Starting Gear (SPT 3.11.x)

Keep the **PMC gear you entered the raid with** if you **die**. The mod snapshots your equipped kit on raid start and restores it when you return to the main menu after a death-like exit.

- Hooks the game via HTTP route hooks (no fragile service overrides)
- Robust exit detection (`results.result`) and PMC detection (profile side + `.Pmc.` in `serverId`)
- Restore happens **after** SPT finishes post-raid work, so nothing overwrites it
- Configurable: restore only certain equipment slots, exclude secure container, restore quickbar, more

Tested on **SPT 3.11.3** using payloads where exit is in `results.result` and PMC side in `profile.Info.Side`.

---

## Installation

1. Extract this folder into `SPT/user/mods/`.
2. Start **SPT.Server.exe**, then **SPT.Launcher.exe**, click **Play**.
3. In server logs you should see:
   - `Static route hooks registered (start/end/after).`
   - On raid start: `[start] isPMC=true ...` + `Snapshot saved (NN items).`
   - On death: `[end] exit='killed' ... queued=true`
   - Back at menu: `[after] performed restore ...` + `Restored starting kit (NN items).`

---

## What it restores

- Your **equipped PMC items** that were under the `equipment` root when the raid started (weapons, armor, clothing, containers depending on config).
- Optionally your **quickbar/fastPanel** (1..9 hotkeys).

It does **not** touch stash, XP, quests, etc.

---

## Configuration (`config.json`)

| Key | Type | Default | Description |
|---|---|---:|---|
| `restoreOn` | string[] | `["killed","missinginaction","mia","left"]` | Exit results that trigger a restore. |
| `treatRunnerAsSuccess` | boolean | `true` | If `true`, **Runner** exit will **not** restore. |
| `logLevel` | `"warn" \| "info" \| "debug"` | `"warn"` | Amount of logging. |
| `persistSnapshotsOnDisk` | boolean | `true` | Also write snapshot files under `state/`. |
| `dumpEndPayload` | boolean | `false` | Dump raw `/end` body to `state/last-end-payload-<sid>.json` (debug). |
| `forceRestoreIfExitUnknown` | boolean | `false` | Restore even if exit is missing/unknown. |
| `equippedOnly` | boolean | `false` | Convenience mode that **defaults** to excluding container slots (`Backpack`, `Pockets`). Combine with `excludeSlots` for finer control. |
| `excludeSecureContainer` | boolean | `false` | Exclude `SecuredContainer` from restore. |
| `excludeSlots` | string[] | `[]` | Names of **root equipment slots** to exclude entirely (root + all contents). Examples: `"Backpack"`, `"Pockets"`, `"TacticalVest"`, `"SecuredContainer"`. |
| `restoreQuickbar` | boolean | `true` | Restore fastPanel (1..9 hotkeys). |

**Notes**

- *Equipped‑only:* If you want **no backpack** restoration, set `equippedOnly: true` (which excludes `Backpack` + `Pockets` by default). If you also wish to exclude rig contents, add `"TacticalVest"` to `excludeSlots`.
- Slot names are taken from the `slotId` on **direct children** of `Inventory.equipment` (e.g. `Headwear`, `ArmorVest`, `TacticalVest`, `Backpack`, `Pockets`, `SecuredContainer`, `Holster`, `FirstPrimaryWeapon`, etc.).

---

## Compatibility

- Designed for **SPT 3.11.x** (tested 3.11.3).
- Uses **StaticRouterModService** to hook only three endpoints: `/client/match/local/start`, `/client/match/local/end`, `/client/game/profile/list`.
- Avoids replacing `LocationLifecycleService`, making it more resilient to updates and other mods.

---

## Known limitations

- Only applies to **PMC raids** (intended design). SCAV is ignored.
- Insurance / mail systems still function normally. Restoring your starting gear does not cancel insurance processing.

---

## Uninstall

Delete the folder `user/mods/blackhorse311-keepstartinggear`. No permanent changes are made besides your saved profile updates.

---

## Credits

- **Blackhorse311** — author  
- **GPT‑5 Pro** — AI assist (design, debugging, docs)
- **SPT Mods User: LIKLY** - For giving me the idea to make one for SPT 3.11

---

## License

[MIT](./LICENSE)
