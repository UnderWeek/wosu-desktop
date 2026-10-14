/**
 * Writing to osu!lazer's library ("store in osu!lazer" mode): beatmap
 * sets, skins, scores (with .osr replays) and collections go into its
 * client.realm and content-addressed file store, shaped the way lazer's
 * own importers write them.
 *
 * Safety rules, all enforced here:
 * - never while lazer runs (two Realm cores writing one file corrupts it):
 *   every call fails with code LAZER_RUNNING instead;
 * - client.realm is backed up before each write (two newest kept in
 *   ~/.wosu/backups) and restored if the file's format version changed;
 * - files are written before the records that point at them.
 */
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { unzipSync } = require('fflate');
const { DATA_DIR } = require('./storage.cjs');
const lazer = require('./lazer.cjs');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 2;
/** lazer's BeatmapOnlineStatus.None: imported, online state not looked up yet (lazer fills it in). */
const STATUS_NONE = -3;
const RULESETS = ['osu', 'taiko', 'fruits', 'mania'];

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

class LazerRunningError extends Error {
    constructor() {
        super('osu!lazer is running: close it to save to its library');
        this.code = 'LAZER_RUNNING';
    }
}

/** lazer's process is the "osu!" executable of osu!.app. */
function lazerRunning() {
    if (process.env.WOSU_LAZER_ASSUME_CLOSED) return Promise.resolve(false);
    return new Promise(resolve => {
        execFile('/usr/bin/pgrep', ['-x', 'osu!'], (err, out) => resolve(!err && String(out).trim().length > 0));
    });
}

/** The 2-byte file format version in a Realm file's header ("T-DB" then the versions). */
function formatVersion(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const b = Buffer.alloc(24);
        fs.readSync(fd, b, 0, 24, 0);
        if (b.toString('latin1', 16, 20) !== 'T-DB') return null;
        return `${b[20]}.${b[21]}`;
    } finally {
        fs.closeSync(fd);
    }
}

async function backup(realmPath) {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `client-${new Date().toISOString().replace(/[:.]/g, '-')}.realm`);
    await fsp.copyFile(realmPath, dest);
    const old = (await fsp.readdir(BACKUP_DIR)).filter(n => /^client-.*\.realm$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await fsp.rm(path.join(BACKUP_DIR, n), { force: true });
    return dest;
}

/** Content-addressed store: files/a/ab/<sha256>. Existing files are left alone. */
async function storeFile(dir, bytes) {
    const hash = sha256(bytes);
    const p = lazer.filePath(dir, hash);
    if (!fs.existsSync(p)) {
        await fsp.mkdir(path.dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, bytes);
        await fsp.rename(tmp, p);
    }
    return hash;
}

let queue = Promise.resolve();

/**
 * Run `fn(realm, Realm)` inside one write transaction on lazer's real
 * database. Serialized, guarded and backed up (see the file header).
 */
function withRealm(fn) {
    const run = queue.then(async () => {
        if (await lazerRunning()) throw new LazerRunningError();
        const dir = lazer.lazerDir();
        const realmPath = path.join(dir, 'client.realm');
        if (!fs.existsSync(realmPath)) throw new Error(`osu!lazer's database was not found in ${dir}`);
        const before = formatVersion(realmPath);
        const saved = await backup(realmPath);
        const Realm = require('realm');
        let result;
        const realm = await Realm.open({ path: realmPath });
        try {
            realm.write(() => {
                result = fn(realm, Realm);
            });
        } finally {
            realm.close();
        }
        const after = formatVersion(realmPath);
        if (after !== before) {
            // lazer could not open a file in a newer format: put the old one back.
            await fsp.copyFile(saved, realmPath);
            throw new Error(`Realm changed the database format (${before} → ${after}); restored the backup`);
        }
        lazer.invalidate();
        return result;
    });
    queue = run.catch(() => {});
    return run;
}

const files = (realm, entries) => entries.map(({ name, hash }) => ({
    Filename: name,
    File: realm.create('File', { Hash: hash }, 'modified'),
}));

/** lazer's ComputeHash: SHA-256 of the hashable files' contents, in file name order. */
function setHash(entries, isHashable) {
    const parts = entries.filter(e => isHashable(e.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!parts.length) return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const h = crypto.createHash('sha256');
    for (const p of parts) h.update(p.bytes);
    return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Beatmap sets
// ---------------------------------------------------------------------------

/**
 * Import an .osz. `info.beatmaps` is the game's parse of each .osu (the
 * game already understands the format): file, ruleset index, difficulty
 * name and settings, metadata, counts, length, BPM, online ids.
 * Returns the set's ID (an existing one when lazer already has it).
 */
async function importBeatmapSet(osz, info) {
    const dir = lazer.lazerDir();
    const unpacked = unzipSync(new Uint8Array(osz));
    const entries = Object.entries(unpacked)
        .filter(([name]) => !name.endsWith('/'))
        .map(([name, bytes]) => ({ name: name.replace(/\\/g, '/'), bytes }));
    if (!entries.length) throw new Error('The archive is empty');
    const hash = setHash(entries, n => /\.osu$/i.test(n));
    if (await lazerRunning()) throw new LazerRunningError();
    for (const e of entries) e.hash = await storeFile(dir, e.bytes);
    const byName = new Map(entries.map(e => [e.name.toLowerCase(), e]));

    return withRealm((realm, Realm) => {
        const live = s => !s.DeletePending;
        const existing = realm.objects('BeatmapSet').filtered('Hash == $0', hash).find(live)
            ?? (info.onlineId > 0 ? realm.objects('BeatmapSet').filtered('OnlineID == $0', info.onlineId).find(live) : undefined);
        if (existing) return { id: String(existing.ID), existed: true };

        const now = new Date();
        const set = realm.create('BeatmapSet', {
            ID: new Realm.BSON.UUID(),
            OnlineID: info.onlineId > 0 ? info.onlineId : -1,
            DateAdded: now,
            DateSubmitted: null,
            DateRanked: null,
            Beatmaps: [],
            Files: files(realm, entries),
            Status: STATUS_NONE,
            DeletePending: false,
            Hash: hash,
            Protected: false,
        });
        for (const b of info.beatmaps) {
            const file = byName.get(String(b.file).toLowerCase());
            if (!file) continue;
            const ruleset = realm.objectForPrimaryKey('Ruleset', RULESETS[b.mode] ?? 'osu');
            if (!ruleset) continue;
            const m = b.metadata;
            const metadata = realm.create('BeatmapMetadata', {
                Title: m.title ?? '',
                TitleUnicode: m.titleUnicode ?? '',
                Artist: m.artist ?? '',
                ArtistUnicode: m.artistUnicode ?? '',
                Author: { OnlineID: m.creatorId > 0 ? m.creatorId : 1, Username: m.creator ?? '', CountryCode: 'Unknown' },
                Source: m.source ?? '',
                Tags: m.tags ?? '',
                UserTags: [],
                PreviewTime: Math.round(m.previewTime ?? -1),
                AudioFile: m.audioFile ?? '',
                BackgroundFile: m.backgroundFile ?? '',
            });
            const beatmap = realm.create('Beatmap', {
                ID: new Realm.BSON.UUID(),
                DifficultyName: b.version ?? '',
                Ruleset: ruleset,
                Difficulty: {
                    DrainRate: b.hp, CircleSize: b.cs, OverallDifficulty: b.od, ApproachRate: b.ar,
                    SliderMultiplier: b.sliderMultiplier, SliderTickRate: b.sliderTickRate,
                },
                Metadata: metadata,
                UserSettings: { Offset: 0 },
                BeatmapSet: set,
                Status: STATUS_NONE,
                OnlineID: b.onlineId > 0 ? b.onlineId : -1,
                Length: b.length,
                BPM: b.bpm,
                Hash: file.hash,
                // lazer computes the star rating itself (its background processor picks up -1).
                StarRating: -1,
                MD5Hash: b.md5,
                OnlineMD5Hash: '',
                LastLocalUpdate: null,
                LastOnlineUpdate: null,
                Hidden: false,
                EndTimeObjectCount: b.endTimeObjectCount,
                TotalObjectCount: b.totalObjectCount,
                LastPlayed: null,
                BeatDivisor: b.beatDivisor || 4,
                EditorTimestamp: null,
            });
            set.Beatmaps.push(beatmap);
        }
        if (!set.Beatmaps.length) throw new Error('No difficulty in the archive could be added');
        return { id: String(set.ID), existed: false };
    });
}

// ---------------------------------------------------------------------------
// Skins
// ---------------------------------------------------------------------------

async function importSkin(osk, info) {
    const dir = lazer.lazerDir();
    const unpacked = unzipSync(new Uint8Array(osk));
    const entries = Object.entries(unpacked)
        .filter(([name]) => !name.endsWith('/'))
        .map(([name, bytes]) => ({ name: name.replace(/\\/g, '/'), bytes }));
    if (!entries.length) throw new Error('The skin archive is empty');
    const hash = setHash(entries, n => /\.(ini|json)$/i.test(n));
    if (await lazerRunning()) throw new LazerRunningError();
    for (const e of entries) e.hash = await storeFile(dir, e.bytes);
    return withRealm((realm, Realm) => {
        const existing = realm.objects('Skin').filtered('Hash == $0 AND DeletePending == false', hash)[0];
        if (existing) return { id: String(existing.ID), existed: true };
        const skin = realm.create('Skin', {
            ID: new Realm.BSON.UUID(),
            Name: info.name || 'Imported skin',
            Creator: info.author || 'Unknown',
            InstantiationInfo: 'osu.Game.Skinning.LegacySkin, osu.Game',
            Hash: hash,
            Protected: false,
            Files: files(realm, entries),
            DeletePending: false,
        });
        return { id: String(skin.ID), existed: false };
    });
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** lazer's ScoreRank. */
const RANKS = { F: -1, D: 0, C: 1, B: 2, A: 3, S: 4, SH: 5, X: 6, XH: 7 };

/**
 * A local score with its .osr. Statistics use lazer's HitResult names;
 * MaximumStatistics is left empty so lazer derives it from the beatmap.
 */
async function addScore(osr, s) {
    const dir = lazer.lazerDir();
    if (await lazerRunning()) throw new LazerRunningError();
    const replayHash = await storeFile(dir, new Uint8Array(osr));
    return withRealm((realm, Realm) => {
        const beatmap = realm.objects('Beatmap').filtered('MD5Hash == $0', s.beatmapMd5).find(b => b.BeatmapSet && !b.BeatmapSet.DeletePending);
        if (!beatmap) throw new Error('osu!lazer does not have this beatmap');
        // Score format and client of lazer's own newest local score, so lazer doesn't reprocess ours.
        const newest = realm.objects('Score').sorted('Date', true)[0];
        const user = newest?.User ? { OnlineID: newest.User.OnlineID, Username: newest.User.Username, CountryCode: newest.User.CountryCode } : { OnlineID: 1, Username: s.player || 'Guest', CountryCode: 'Unknown' };
        const score = realm.create('Score', {
            ID: new Realm.BSON.UUID(),
            BeatmapInfo: beatmap,
            ClientVersion: newest?.ClientVersion ?? '',
            BeatmapHash: beatmap.Hash,
            Ruleset: realm.objectForPrimaryKey('Ruleset', 'osu'),
            Files: files(realm, [{ name: 'replay.osr', hash: replayHash }]),
            Hash: replayHash,
            DeletePending: false,
            TotalScore: Math.round(s.score),
            TotalScoreWithoutMods: Math.round(s.score),
            TotalScoreVersion: newest?.TotalScoreVersion ?? 30000019,
            LegacyTotalScore: null,
            BackgroundReprocessingFailed: false,
            MaxCombo: s.maxCombo,
            Accuracy: s.accuracy,
            Date: new Date(s.date),
            PP: null,
            OnlineID: -1,
            LegacyOnlineID: -1,
            User: user,
            Mods: JSON.stringify((s.mods ?? []).map(acronym => ({ acronym }))),
            Statistics: JSON.stringify(s.statistics ?? {}),
            MaximumStatistics: '{}',
            Pauses: [],
            Rank: RANKS[s.grade] ?? 0,
            Combo: s.combo ?? 0,
            IsLegacyScore: false,
        });
        return { id: String(score.ID) };
    });
}

// ---------------------------------------------------------------------------
// Collections and deletion
// ---------------------------------------------------------------------------

function uuid(Realm, id) {
    return new Realm.BSON.UUID(String(id));
}

function createCollection(name, md5s) {
    return withRealm((realm, Realm) => {
        const c = realm.create('BeatmapCollection', { ID: new Realm.BSON.UUID(), Name: name, BeatmapMD5Hashes: [...new Set(md5s)], LastModified: new Date() });
        return { id: String(c.ID) };
    });
}

/** Rename and/or replace the members of a collection. */
function updateCollection(id, patch) {
    return withRealm((realm, Realm) => {
        const c = realm.objectForPrimaryKey('BeatmapCollection', uuid(Realm, id));
        if (!c) throw new Error('osu!lazer no longer has this collection');
        if (typeof patch.name === 'string') c.Name = patch.name;
        if (Array.isArray(patch.md5s)) {
            c.BeatmapMD5Hashes.splice(0, c.BeatmapMD5Hashes.length);
            for (const m of new Set(patch.md5s)) c.BeatmapMD5Hashes.push(m);
        }
        c.LastModified = new Date();
        return { id };
    });
}

function deleteCollection(id) {
    return withRealm((realm, Realm) => {
        const c = realm.objectForPrimaryKey('BeatmapCollection', uuid(Realm, id));
        if (c) realm.delete(c);
        return { id };
    });
}

/** lazer's soft delete: DeletePending, purged (files too) by lazer on its next start. */
function softDelete(type, id) {
    if (!['BeatmapSet', 'Skin', 'Score'].includes(type)) return Promise.reject(new Error('bad type'));
    return withRealm((realm, Realm) => {
        const o = realm.objectForPrimaryKey(type, uuid(Realm, id));
        if (o && !o.Protected) o.DeletePending = true;
        return { id };
    });
}

function wrapError(fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (e) {
            // IPC keeps only the message: carry the code in it.
            throw new Error(e.code === 'LAZER_RUNNING' ? `LAZER_RUNNING: ${e.message}` : e.message);
        }
    };
}

function registerIpc(ipcMain) {
    ipcMain.handle('wosu:lazer:running', () => lazerRunning());
    ipcMain.handle('wosu:lazer:importBeatmapSet', (_e, osz, info) => wrapError(importBeatmapSet)(osz, info));
    ipcMain.handle('wosu:lazer:importSkin', (_e, osk, info) => wrapError(importSkin)(osk, info));
    ipcMain.handle('wosu:lazer:addScore', (_e, osr, s) => wrapError(addScore)(osr, s));
    ipcMain.handle('wosu:lazer:createCollection', (_e, name, md5s) => wrapError(createCollection)(name, md5s));
    ipcMain.handle('wosu:lazer:updateCollection', (_e, id, patch) => wrapError(updateCollection)(id, patch));
    ipcMain.handle('wosu:lazer:deleteCollection', (_e, id) => wrapError(deleteCollection)(id));
    ipcMain.handle('wosu:lazer:delete', (_e, type, id) => wrapError(softDelete)(type, id));
}

module.exports = { registerIpc, importBeatmapSet, importSkin, addScore, createCollection, updateCollection, deleteCollection, softDelete, lazerRunning, formatVersion };
