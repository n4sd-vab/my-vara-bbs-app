const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld('vara', {
    connect: () => ipcRenderer.invoke('vara-connect'),
    disconnect: () => ipcRenderer.invoke('vara-disconnect'),
    sendCommand: (line) => ipcRenderer.invoke('vara-send-command', line),
    sendData: (text) => ipcRenderer.invoke('vara-send-data', text),
    onLog: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on("log", listener);
        return listener; // return the actual listener so renderer can remove it
    },
    removeLogListener: (listener) => {
        ipcRenderer.removeListener("log", listener);
    }
});


contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings-get'),
  set: (data) => {
    ipcRenderer.invoke('settings-set', data);
    ipcRenderer.send('settings-updated', data);
  }
});


contextBridge.exposeInMainWorld("electronAPI", {

    onToggleVaraConsole: (callback) =>
        ipcRenderer.on("toggle-vara-console", (_event, visible) => callback(visible)),

    showMessageContextMenu: (data) =>
        ipcRenderer.send("show-message-context-menu", data),

    getMessages: () => ipcRenderer.invoke("getMessages"),

    getMessageById: (id) => ipcRenderer.invoke("getMessageById", id),

    sendToBbs: (cmd) => ipcRenderer.send("send-to-bbs", cmd),

    deleteMessage: (id) => ipcRenderer.invoke("deleteMessage", id),

    onMessageDeleted: (callback) =>
        ipcRenderer.on("message-deleted", (_e, msgNum) => callback(msgNum)),

    markMessageSaved: (id) => ipcRenderer.invoke("markMessageSaved", id),
    
    onMessageSaved: (callback) =>
        ipcRenderer.on("message-saved", (_e, msgNum) => callback(msgNum)),

    sendBbsState: (state) => ipcRenderer.send("bbs-state", state),

    sendOutbox: () => ipcRenderer.invoke("sendOutbox"),


    receiveMessages: () => ipcRenderer.invoke('receive-messages'),

    // onReplyToSender: (callback) =>
    //    ipcRenderer.on("reply-to-sender", (_e, data) => callback(data)),

    saveOutboxMessage: (message) => ipcRenderer.invoke("saveOutboxMessage", message),

    sendReceive: () => ipcRenderer.send("sendReceive"),

    replyToMessage: (msgNum) => ipcRenderer.invoke("replyToMessage", msgNum),
    
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

    // white pages import
    startWhitePagesMode: () => ipcRenderer.send('whitepages-start'),

    onOpenWhitePagesModal: (callback) =>
        ipcRenderer.on("open-whitepages-import", () => callback()),

    onWhitePagesLine: (callback) => ipcRenderer.on("whitepages-line", (_e, entry) => callback(entry)),

    readMessage: (msgNum) => ipcRenderer.send("bbs:read-message", msgNum),

    markMessageRead: (id) => ipcRenderer.invoke("markMessageRead", id),

    onMessageBody: (callback) => ipcRenderer.on("bbs:message-body", (event, msg) => callback(msg)),

    onOpenBbsHelp: (callback) => ipcRenderer.on("open-bbs-help", () => callback()),

    onOpenAbout: (callback) => ipcRenderer.on("open-about", () => callback()),

    startYappReceive: (info) => ipcRenderer.send('start-yapp-receive', info),

    startYappSend: (info) => ipcRenderer.send("yapp-start-send", info),

    onYappSendError: (callback) => ipcRenderer.on("yapp-send-error", callback),

    requestYappFileList: () => ipcRenderer.send('yapp-request-file-list'),
    onYappFileList: (callback) => ipcRenderer.on('yapp-file-list', (_e, files) => callback(files)),

    pickDirectory: () => ipcRenderer.invoke("pick-directory"),
    
    saveSetting: (key, value) => ipcRenderer.invoke("save-setting", { key, value }),
    getSetting: (key) => ipcRenderer.invoke("get-setting", key),

    onOpenYappReceive: (callback) => ipcRenderer.on("open-yapp-receive", () => callback()),
    onYappRecvProgress: (callback) => ipcRenderer.on("yapp-recv-progress", callback),
    onYappReceiveComplete: (callback) => ipcRenderer.on("yapp-receive-complete", callback),

    pickFile: () => ipcRenderer.invoke("pick-file"),
    onOpenYappSend: (callback) => ipcRenderer.on("open-yapp-send", callback),
    onYappSendComplete: (callback) => ipcRenderer.on("yapp-send-complete", callback),
    sendYappFile: (filePath) => ipcRenderer.invoke("yapp-send-file", filePath),

    onYappSendProgress: (callback) =>
        ipcRenderer.on("yapp-send-progress", (event, data) => callback(data)),

    

});
console.log("PRELOAD LOADED");