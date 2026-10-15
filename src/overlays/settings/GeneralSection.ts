import type { Game } from '../../app/Game';
import { desktopUpdater, isDesktop, lazerLibrary, openDataFolder } from '../../native/desktop';
import { Colors } from '../../ui/theme';
import { buttonRow, checkboxRow, textRow } from './rows';
import type { SectionDef, SubsectionDef } from './types';

const REPO = isDesktop ? 'https://github.com/UnderWeek/wosu-desktop' : 'https://github.com/mostlime12195/wosu';

const SHORTCUTS = [
    'Ctrl+O — settings',
    'Ctrl+D — beatmap listing',
    'Ctrl+N — notifications',
    'F6 — now playing',
    'F1 / F2 — mods / random (song select)',
    'Alt + wheel, Alt+↑/↓ — volume',
    'Ctrl+Shift+F — FPS counter',
    'F11 or Alt+Enter — fullscreen',
    'F12 — screenshot',
].join('\n');

export function generalSection(game: Game): SectionDef {
    const renderer = game.app.rendererKind === 'webgpu' ? 'WebGPU' : 'WebGL';
    return {
        id: 'general',
        title: 'General',
        icon: 'gear',
        subsections: [
            {
                title: 'About',
                rows: [
                    textRow(`wosu! · build ${__BUILD_INFO__} · rendering with ${renderer}`, { color: Colors.white, size: 14, keywords: 'version build' }).row,
                    textRow(isDesktop ? 'An unofficial, open-source osu!std client.' : 'An unofficial, open-source osu!std client that runs entirely in your browser.', { keywords: 'about' }).row,
                    buttonRow('View source on GitHub', () => window.open(REPO, '_blank', 'noopener'), { icon: 'codeBranch', color: Colors.gray4, keywords: 'github source code' }),
                    textRow(`osu! is a trademark of ppy Pty Ltd. ${isDesktop ? '' : 'Beatmaps come from community mirrors (SayoBot, Mino, NeriNyan). '}PixiJS (MIT), Exo 2 (OFL), Font Awesome Free (CC BY 4.0 / OFL), Signalsmith Stretch (MIT).${isDesktop ? ' BASS (Un4seen Developments, non-commercial use).' : ''}`, { color: Colors.gray9, size: 12, keywords: 'credits licences licenses' }).row,
                ],
            },
            ...(isDesktop ? [desktopSubsection(), lazerSubsection()] : []),
            {
                title: 'Shortcuts',
                rows: [textRow(SHORTCUTS, { keywords: 'keyboard shortcuts hotkeys fps' }).row],
            },
        ],
    };
}

/** Desktop app only: the data folder and one-click updates. */
function desktopSubsection(): SubsectionDef {
    const status = textRow('', { color: Colors.grayA, size: 12, keywords: 'update version' });
    const show = (text: string) => {
        status.block.content = text;
        status.row.onLayoutChange?.();
    };
    const describe = () => {
        const info = desktopUpdater?.info;
        if (!info) return 'Not checked for updates yet.';
        if (info.error) return `Version ${info.current}. ${info.error}.`;
        if (info.available) return `Version ${info.current}. Update ${info.latest} is available.`;
        return `Version ${info.current}. You are up to date.`;
    };
    show(describe());
    let busy = false;
    const update = async () => {
        const updater = desktopUpdater;
        if (!updater || busy) return;
        busy = true;
        try {
            show('Checking for updates…');
            await updater.checkInteractive();
            show(describe());
        } finally {
            busy = false;
        }
    };
    return {
        title: 'Desktop',
        rows: [
            textRow('Beatmaps, skins, scores and settings are stored in ~/.wosu. Put .osz/.osk files (or extracted osu! beatmap/skin folders) into ~/.wosu/Songs and ~/.wosu/Skins and they are imported automatically.', { keywords: 'folder files storage songs skins' }).row,
            buttonRow('Open ~/.wosu folder', openDataFolder, { icon: 'folderOpen', color: Colors.gray4, keywords: 'folder files storage songs skins' }),
            status.row,
            buttonRow('Check for updates and install', () => void update(), { icon: 'download', keywords: 'update upgrade version' }),
        ],
    };
}

/** Desktop app only: osu!lazer's library, read in place. */
function lazerSubsection(): SubsectionDef {
    const lazer = lazerLibrary!;
    const status = textRow(lazer.status.value, { color: Colors.grayA, size: 12, keywords: 'lazer library' });
    const off = lazer.status.bind(v => {
        status.block.content = v;
        status.row.onLayoutChange?.();
    });
    status.row.on('destroyed', off);
    return {
        title: 'osu!lazer',
        rows: [
            checkboxRow('Show the osu!lazer library', lazer.enabled, {
                keywords: 'lazer library beatmaps skins import',
                description: "Beatmaps and skins from osu!lazer appear here and are read from lazer's own files: nothing is copied. Deleting one in wosu! only hides it.",
            }),
            checkboxRow('Store in osu!lazer', lazer.storeInLazer, {
                keywords: 'lazer store save storage database write beatmaps skins scores replays collections',
                description: "New beatmaps, skins, scores (with replays) and collections are saved into osu!lazer's library instead of ~/.wosu, and deleting here deletes there. Settings stay in ~/.wosu. osu!lazer must be closed while saving; its database is backed up to ~/.wosu/backups before every write.",
            }),
            buttonRow("Move wosu!'s beatmaps, skins and scores into osu!lazer", () => void lazer.migrateLocal(), {
                icon: 'upload', color: Colors.gray4, keywords: 'lazer move migrate transfer',
                visibleWhen: lazer.storeInLazer,
            }),
            status.row,
            buttonRow('Reload osu!lazer library', () => void lazer.sync(), { icon: 'refresh', color: Colors.gray4, keywords: 'lazer reload refresh' }),
            buttonRow('Show hidden osu!lazer items again', () => void lazer.unhideAll(), { color: Colors.gray4, keywords: 'lazer restore hidden' }),
        ],
    };
}
