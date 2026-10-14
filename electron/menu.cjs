/**
 * The macOS menu bar. Replaces Electron's default one, whose Reload
 * (Cmd+R) and Close Window (Cmd+W) would kill a play in progress.
 * Edit roles stay: without them Cmd+C/V/X/A do nothing in text boxes.
 */
const { app, Menu, shell } = require('electron');
const { DATA_DIR } = require('./storage.cjs');
const { LOG_DIR } = require('./logs.cjs');

function build(send) {
    const template = [
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { label: 'Check for Updates…', click: () => send('checkUpdates') },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'File',
            submenu: [
                { label: 'Import Beatmaps or Skins…', accelerator: 'Cmd+O', click: () => send('import') },
                { label: 'Open Replay…', accelerator: 'Shift+Cmd+O', click: () => send('openReplay') },
                { label: 'Open Replays Folder', click: () => void shell.openPath(require('node:path').join(DATA_DIR, 'Replays')) },
                { label: 'Reload osu!lazer Library', click: () => send('reloadLazer') },
                { type: 'separator' },
                { label: 'Open ~/.wosu Folder', click: () => void shell.openPath(DATA_DIR) },
                { label: 'Open Logs Folder', click: () => void shell.openPath(LOG_DIR) },
            ],
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { label: 'Toggle Fullscreen', accelerator: 'Ctrl+Cmd+F', click: () => send('fullscreen') },
                { type: 'separator' },
                { label: 'Audio Debugger', accelerator: 'Ctrl+Shift+A', click: () => send('debugAudio') },
                { label: 'Input Debugger', accelerator: 'Ctrl+Shift+P', click: () => send('debugInput') },
                { role: 'toggleDevTools', accelerator: 'Alt+Cmd+I' },
            ],
        },
        {
            role: 'window',
            submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
        },
        {
            role: 'help',
            submenu: [
                { label: 'wosu! on GitHub', click: () => void shell.openExternal('https://github.com/mostlime12195/wosu') },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { build };
