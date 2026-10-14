/**
 * The renderer's only door to the desktop shell: `window.wosuNative`
 * (typed in src/native/native.ts).
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function listen(channel) {
    return (fn) => {
        const handler = (_e, ...args) => fn(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    };
}

contextBridge.exposeInMainWorld('wosuNative', {
    platform: process.platform,
    debug: process.argv.includes('--wosu-debug'),
    db: {
        get: invoke('wosu:db:get'),
        put: invoke('wosu:db:put'),
        delete: invoke('wosu:db:delete'),
        entries: invoke('wosu:db:entries'),
        keys: invoke('wosu:db:keys'),
        clear: invoke('wosu:db:clear'),
        count: invoke('wosu:db:count'),
    },
    inbox: {
        list: invoke('wosu:inbox:list'),
        read: invoke('wosu:inbox:read'),
        done: invoke('wosu:inbox:done'),
        onChanged: listen('wosu:inbox-changed'),
    },
    update: {
        check: invoke('wosu:update:check'),
        install: invoke('wosu:update:install'),
        onProgress: listen('wosu:update-progress'),
    },
    openDataDir: invoke('wosu:open-data-dir'),
    config: {
        initial: ipcRenderer.sendSync('wosu:config:get-sync'),
        set: invoke('wosu:config:set'),
        onChanged: listen('wosu:config-changed'),
    },
    relaunch: invoke('wosu:relaunch'),
    onMenu: listen('wosu:menu'),
    lazer: {
        library: invoke('wosu:lazer:library'),
        read: invoke('wosu:lazer:read'),
        running: invoke('wosu:lazer:running'),
        importBeatmapSet: invoke('wosu:lazer:importBeatmapSet'),
        importSkin: invoke('wosu:lazer:importSkin'),
        addScore: invoke('wosu:lazer:addScore'),
        createCollection: invoke('wosu:lazer:createCollection'),
        updateCollection: invoke('wosu:lazer:updateCollection'),
        deleteCollection: invoke('wosu:lazer:deleteCollection'),
        delete: invoke('wosu:lazer:delete'),
    },
    onFileSaved: listen('wosu:file-saved'),
    onOpenFile: (fn) => {
        const off = listen('wosu:open-file')(fn);
        ipcRenderer.send('wosu:open-file-ready');
        return off;
    },
    showInFolder: invoke('wosu:show-in-folder'),
    setPlaying: (playing) => ipcRenderer.send('wosu:set-playing', !!playing),
    setDockProgress: (progress, badge) => ipcRenderer.send('wosu:dock-progress', progress, badge ?? ''),
    notify: (title, body) => ipcRenderer.send('wosu:notify', title, body ?? ''),
});
