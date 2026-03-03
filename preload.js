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
    
    onOpenAddressBookAdd: (callback) =>
        ipcRenderer.on("open-address-book-add", () => callback()),

    // address book helpers
    saveAddressBookEntry: (entry) => ipcRenderer.invoke('address-book-save', entry),

    onOpenAddressBookView: (callback) =>
        ipcRenderer.on("open-address-book-view", () => callback()),

    getAddressBook: () => ipcRenderer.invoke('address-book-get'),

    searchAddressBook: (prefix) => ipcRenderer.invoke("addressbook-search", prefix),

    debugAddressBook: () => ipcRenderer.invoke("addressbook-debug"),

    deleteAddressBookEntry: (id) => ipcRenderer.invoke("addressbook-delete", id),

    getAddressBookEntry: (id) => ipcRenderer.invoke("addressbook-get-one", id),

    updateAddressBookEntry: (entry) => ipcRenderer.invoke("addressbook-update", entry),

    onOpenBbsHelp: (callback) => ipcRenderer.on("open-bbs-help", () => callback())

});
