const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vara', {
    connect: () => ipcRenderer.invoke('vara-connect'),
    disconnect: () => ipcRenderer.invoke('vara-disconnect'),
    sendCommand: (line) => ipcRenderer.invoke('vara-send-command', line),
    sendData: (text) => ipcRenderer.invoke('vara-send-data', text),
    onLog: (callback) => ipcRenderer.on('log', (_event, data) => callback(data))
});

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings-get'),
  set: (data) => ipcRenderer.invoke('settings-set', data)
});

contextBridge.exposeInMainWorld("electronAPI", {
    onToggleVaraConsole: (callback) =>
        ipcRenderer.on("toggle-vara-console", (_event, visible) => callback(visible)),

    showMessageContextMenu: (data) =>
        ipcRenderer.send("show-message-context-menu", data),

    onReplyToSender: (callback) =>
        ipcRenderer.on("reply-to-sender", (_e, data) => callback(data)),
    
    onOpenAddressBook: (callback) =>
    ipcRenderer.on("open-address-book", () => callback())

});
