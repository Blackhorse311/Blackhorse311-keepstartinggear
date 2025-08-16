"use strict";

/**
 * KeepStartingGear (SPT 3.11.x)
 * - /client/match/local/start -> snapshot PMC equipment (+attachments, +container contents depending on config)
 * - /client/match/local/end   -> capture exit + queue decision (no mutation here)
 * - /client/game/profile/list -> perform restore if queued
 *
 * Feature toggles (see config.json):
 *  - equippedOnly: when true, the mod assumes you mainly want worn gear/weapons.
 *                  By default you should combine this with excludeSlots for containers
 *                  you don't want restored (e.g. "Backpack", "Pockets").
 *  - excludeSlots: array of slot names to exclude entirely (root + their contents)
 *  - excludeSecureContainer: convenience flag to exclude "SecuredContainer"
 *  - restoreQuickbar: restore fastPanel (1..9 hotkeys)
 *  - treatRunnerAsSuccess: do NOT restore on "Runner" exit (true by default)
 *  - restoreOn: which exit results should trigger a restore (e.g. "killed", "mia", "left")
 */

const fs = require("fs");
const path = require("path");

class KeepStartingGearMod {
    constructor() {
        this.modName = "blackhorse311-keepstartinggear";
        this.stateDir = path.join(__dirname, "..", "state");
        this.cfgPath = path.join(__dirname, "..", "config.json");
        this.cfg = {
            restoreOn: ["killed", "missinginaction", "mia", "left"],
            treatRunnerAsSuccess: true,
            logLevel: "info",
            persistSnapshotsOnDisk: true,
            dumpEndPayload: false,
            forceRestoreIfExitUnknown: false,
            equippedOnly: false,
            excludeSecureContainer: false,
            excludeSlots: [],
            restoreQuickbar: true
        };

        // A convenience list of "equip root" slotIds seen on direct children of inventory.equipment
        this.defaultEquipSlots = [
            "Headwear","Earpiece","Eyewear","FaceCover","ArmBand",
            "ArmorVest","TacticalVest",
            "Holster","Scabbard",
            "FirstPrimaryWeapon","SecondPrimaryWeapon","ThirdPrimaryWeapon",
            "PrimaryWeapon","SecondaryWeapon",
            "Backpack","Pockets","SecuredContainer"
        ];

        this.logger = null;
        this.saveServer = null;
        this.profileHelper = null;

        this._memSnapshot = new Map();  // sessionId -> snapshot
        this._raidState = new Map();    // sessionId -> { isPMC, exit, shouldRestoreQueued }
    }

    preSptLoad(container) {
        this.logger = container.resolve("WinstonLogger");
        this.saveServer = container.resolve("SaveServer");
        this.profileHelper = container.resolve("ProfileHelper");

        // config + state dir
        try {
            if (fs.existsSync(this.cfgPath)) {
                Object.assign(this.cfg, JSON.parse(fs.readFileSync(this.cfgPath, "utf-8")));
            }
        } catch {}
        try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch {}

        const staticRouter = container.resolve("StaticRouterModService");

        // ----- /start -> snapshot -----
        staticRouter.registerStaticRouter(
            `${this.modName}-start`,
            [{
                url: "/client/match/local/start",
                action: (url, info, sessionId, output) => {
                    // Default to PMC; try to read from actual PMC profile
                    let pmcSide = "";
                    try {
                        const pmc = this._getPMC(sessionId);
                        pmcSide = (pmc?.Info?.Side || "").toString().toLowerCase();
                    } catch {}
                    const isPMC = pmcSide === "usec" || pmcSide === "bear" || pmcSide === ""; // assume PMC if unknown
                    this._raidState.set(sessionId, { isPMC, exit: null, shouldRestoreQueued: false });
                    this._log("info", `[start] isPMC=${isPMC} (pmc.Info.Side='${pmcSide || "?"}')`);

                    try { this._snapshotStartingKit(sessionId); }
                    catch (e) { this._log("error", `snapshot failed: ${e?.stack || e}`); }

                    return output;
                }
            }],
            this.modName
        );

        // ----- /end -> decide + queue (no mutation yet) -----
        staticRouter.registerStaticRouter(
            `${this.modName}-end`,
            [{
                url: "/client/match/local/end",
                action: (url, info, sessionId, output) => {
                    const body = this._coerceBody(info);

                    // Optional: dump what we got
                    if (this.cfg.dumpEndPayload) {
                        try {
                            fs.writeFileSync(
                                path.join(this.stateDir, `last-end-payload-${sessionId}.json`),
                                JSON.stringify(body, null, 2)
                            );
                        } catch {}
                    }

                    // Pull exit primarily from results.result (observed in 3.11.3 payloads)
                    const exitRaw = (
                        body?.results?.result ??
                        body?.result ??
                        body?.exit ??
                        body?.exitStatus ??
                        body?.status ??
                        body?.locationExitStatus ??
                        ""
                    );
                    const exit = exitRaw.toString().toLowerCase();

                    // Infer PMC from end payload too
                    const serverId = (body?.serverId || "").toString().toLowerCase();
                    const sideEnd = (body?.results?.profile?.Info?.Side || "").toString().toLowerCase();
                    const isPMCFromServerId = serverId.includes(".pmc.");
                    const isPMCFromSide = sideEnd === "usec" || sideEnd === "bear";

                    const st = this._raidState.get(sessionId) || { isPMC: true, exit: null, shouldRestoreQueued: false };
                    const isPMCFinal = isPMCFromServerId || isPMCFromSide || st.isPMC === true;

                    const restoreList = (this.cfg.restoreOn || []).map(x => x.toLowerCase());

                    const shouldRestoreQueued =
                        isPMCFinal &&
                        (!this.cfg.treatRunnerAsSuccess || exit !== "runner") &&
                        (
                            (exit && restoreList.includes(exit)) ||
                            (!exit && this.cfg.forceRestoreIfExitUnknown)
                        );

                    st.isPMC = isPMCFinal;
                    st.exit = exit || null;
                    st.shouldRestoreQueued = shouldRestoreQueued;
                    this._raidState.set(sessionId, st);

                    this._log("info", `[end] exit='${exit || "?"}', isPMC=${isPMCFinal} (serverId='${serverId || "?"}', side='${sideEnd || "?"}'), queued=${shouldRestoreQueued}`);
                    return output;
                }
            }],
            this.modName
        );

        // ----- after (back at menu) -> perform restore if queued -----
        staticRouter.registerStaticRouter(
            `${this.modName}-after`,
            [{
                url: "/client/game/profile/list",
                action: (url, info, sessionId, output) => {
                    const st = this._raidState.get(sessionId);
                    if (!st || !st.shouldRestoreQueued) return output;

                    try {
                        this._restoreStartingKit(sessionId);
                        this._log("info", `[after] performed restore (exit='${st.exit || "?"}', isPMC=${st.isPMC}).`);
                    } catch (e) {
                        this._log("error", `restore failed in after-hook: ${e?.stack || e}`);
                    } finally {
                        st.shouldRestoreQueued = false;
                        this._raidState.set(sessionId, st);
                    }

                    return output;
                }
            }],
            this.modName
        );

        this._log("info", "Static route hooks registered (start/end/after).");
    }

    postDBLoad() {}
    postSptLoad() {}

    // -------- internals --------

    _coerceBody(info) {
        try {
            if (info == null) return {};
            if (typeof info === "string") {
                const s = info.trim();
                if (s.startsWith("{") || s.startsWith("[")) return JSON.parse(s);
                return {};
            }
            if (typeof info === "object") {
                if (typeof info.data === "string") {
                    const s = info.data.trim();
                    if (s.startsWith("{") || s.startsWith("[")) return JSON.parse(s);
                }
                if (typeof info.body === "string") {
                    const s = info.body.trim();
                    if (s.startsWith("{") || s.startsWith("[")) return JSON.parse(s);
                }
                return info.data && typeof info.data === "object" ? info.data : info;
            }
        } catch {}
        return {};
    }

    _snapshotPath(sessionId) {
        return path.join(this.stateDir, `starting-gear-${sessionId}.json`);
    }

    _snapshotStartingKit(sessionId) {
        const pmc = this._getPMC(sessionId);
        if (!pmc) { this._log("warn", `snapshot: PMC not found for ${sessionId}`); return; }

        const inv = pmc.Inventory || pmc.inventory;
        if (!inv || !Array.isArray(inv.items)) { this._log("warn", "snapshot: PMC inventory malformed."); return; }

        const items = inv.items;
        const equipmentRoot = inv.equipment || inv.Equipment;
        const fastPanel = inv.fastPanel || inv.FastPanel || {};
        if (!equipmentRoot) { this._log("warn", "snapshot: equipment root missing."); return; }

        // Decide which root slots to snapshot (based on config)
        const directChildren = items.filter(it => it.parentId === equipmentRoot);
        const restoreSlotNames = this._computeRestoreSlotNames(directChildren.map(d => d.slotId || ""));

        const allowedRoots = directChildren.filter(it => restoreSlotNames.has(it.slotId || ""));
        const subtreeIds = this._collectSubtreeFromRoots(items, allowedRoots.map(it => it._id || it.id));

        const startingItems = items
            .filter(it => subtreeIds.has((it._id || it.id)))
            .map(it => JSON.parse(JSON.stringify(it))); // deep copy

        const snapshot = {
            equipmentRoot,
            restoreSlotNames: Array.from(restoreSlotNames),
            fastPanel,
            items: startingItems
        };

        if (this.cfg.persistSnapshotsOnDisk) {
            fs.writeFileSync(this._snapshotPath(sessionId), JSON.stringify(snapshot));
        }
        this._memSnapshot.set(sessionId, snapshot);

        this._log("info", `Snapshot saved (${startingItems.length} items).`);
    }

    _restoreStartingKit(sessionId) {
        let snapshot = this._memSnapshot.get(sessionId);
        if (!snapshot && this.cfg.persistSnapshotsOnDisk) {
            const p = this._snapshotPath(sessionId);
            if (fs.existsSync(p)) snapshot = JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        if (!snapshot) { this._log("warn", "restore: no snapshot found; skipping."); return; }

        const profile = this.saveServer.getProfile(sessionId);
        if (!profile?.characters?.pmc) { this._log("error", "restore: profile/PMC undefined; cannot restore."); return; }

        const pmc = profile.characters.pmc;
        const inv = pmc.Inventory || pmc.inventory;
        if (!inv || !Array.isArray(inv.items)) { this._log("error", "restore: PMC inventory malformed."); return; }

        const items = inv.items;
        const equipmentRoot = inv.equipment || inv.Equipment;
        if (!equipmentRoot) { this._log("warn", "restore: equipment root missing."); return; }

        // Compute removal set for CURRENT equipment items in the slots we're restoring
        const directChildrenNow = items.filter(it => it.parentId === equipmentRoot);
        const restoreSlotNames = new Set(snapshot.restoreSlotNames || []);
        if (restoreSlotNames.size === 0) {
            // fallback to config if snapshot didn't store it (older snapshots)
            for (const s of this._computeRestoreSlotNames(directChildrenNow.map(d => d.slotId || ""))) restoreSlotNames.add(s);
        }

        const rootsToRemove = directChildrenNow.filter(it => restoreSlotNames.has(it.slotId || ""));
        const removalSet = this._collectSubtreeFromRoots(items, rootsToRemove.map(it => it._id || it.id));

        // Remove targeted equipment subtrees, keep everything else
        const kept = items.filter(it => !removalSet.has((it._id || it.id)));

        // Replace with snapshot equipment (dedup anything that already exists in 'kept',
		// e.g. items you moved to Pouch during the raid when Pouch is excluded)
		const keptIds = new Set(kept.map(it => it._id ?? it.id));
		const dedupSnapshot = snapshot.items.filter(it => !keptIds.has(it._id ?? it.id));
		inv.items = kept.concat(dedupSnapshot);


        // Optionally restore quickbar
        if (this.cfg.restoreQuickbar) {
            inv.fastPanel = snapshot.fastPanel || {};
        }

        this.saveServer.saveProfile(sessionId);
        this._log("info", `Restored starting kit (${snapshot.items.length} items).`);
    }

    _collectSubtreeFromRoots(items, rootIds) {
        const idOf = it => it._id || it.id;
        const childrenByParent = new Map();
        for (const it of items) {
            const p = it.parentId;
            if (!p) continue;
            if (!childrenByParent.has(p)) childrenByParent.set(p, []);
            childrenByParent.get(p).push(idOf(it));
        }

        const roots = new Set(rootIds);
        const out = new Set();
        const stack = Array.from(roots);
        for (const r of roots) out.add(r); // include the roots themselves
        while (stack.length) {
            const cur = stack.pop();
            const kids = childrenByParent.get(cur) || [];
            for (const k of kids) {
                if (!out.has(k)) { out.add(k); stack.push(k); }
            }
        }
        return out;
    }

    _computeRestoreSlotNames(currentDirectSlots) {
        // Start with the defaults or what exists now
        const allSlots = new Set([...(currentDirectSlots || []), ...this.defaultEquipSlots]);
        const excludes = new Set((this.cfg.excludeSlots || []).map(s => s.toString()));
        if (this.cfg.excludeSecureContainer) excludes.add("SecuredContainer");

        // If equippedOnly is true, we recommend excluding containers by default,
        // but we won't force it if user already provided excludes.
        if (this.cfg.equippedOnly && (this.cfg.excludeSlots || []).length === 0) {
            // Default "equipped only" excludes
            excludes.add("Backpack");
            excludes.add("Pockets");
            // (If you also want to exclude rig contents, add "TacticalVest" in config)
        }

        const included = new Set();
        for (const s of allSlots) {
            if (!s) continue;
            if (excludes.has(s)) continue;
            included.add(s);
        }
        return included;
    }

    _getPMC(sessionId) {
        try { return this.profileHelper.getPmcProfile(sessionId); }
        catch { return null; }
    }

    _log(level, msg) {
        const order = { error: 0, warn: 1, info: 2, debug: 3 };
        const want = order[(this.cfg.logLevel || "info").toLowerCase()] ?? 2;
        const have = order[level] ?? 2;
        if (have <= want) {
            const line = `[${this.modName}] ${msg}`;
            try { this.logger[level](line); } catch { try { console.log(line); } catch {} }
        }
    }
}

module.exports = { mod: new KeepStartingGearMod() };
