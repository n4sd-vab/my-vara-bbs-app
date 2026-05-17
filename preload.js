const { contextBridge, ipcRenderer } = require("electron");

//
// VARA RADIO API
//
contextBridge.exposeInMainWorld("vara", {
    connect: () => ipcRenderer.invoke("vara-connect"),
    disconnect: () => ipcRenderer.invoke("vara-disconnect"),
    sendCommand: (line) => ipcRenderer.invoke("vara-send-command", line),
    sendData: (text) => ipcRenderer.invoke("vara-send-data", text),

    onLog: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on("vara:log", listener);
        return listener;
    },
    removeLogListener: (listener) => {
        ipcRenderer.removeListener("vara:log", listener);
    }
});

//
// SETTINGS API 
//
contextBridge.exposeInMainWorld("settings", {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (data) => ipcRenderer.invoke("settings:set", data),
    saveSetting: (key, value) => ipcRenderer.invoke("settings:save", { key, value }),
    getSetting: (key) => ipcRenderer.invoke("settings:get-one", key),
    onUpdated: (callback) =>
        ipcRenderer.on("settings:updated", (_e, data) => callback(data))
});

//
// BBS / MESSAGES API
//
contextBridge.exposeInMainWorld("electronAPI", {

    //
    // UI / WINDOW EVENTS
    //
    onToggleVaraConsole: (callback) =>
        ipcRenderer.on("ui:toggle-vara-console", (_e, visible) => callback(visible)),

    onOpenBbsHelp: (callback) =>
        ipcRenderer.on("ui:open-bbs-help", callback),

    onOpenAbout: (callback) =>
        ipcRenderer.on("ui:open-about", callback),

    onToast: (callback) =>
        ipcRenderer.on("ui:toast", (_e, text) => callback(text)),

    //
    // MESSAGE LIST / DB ACCESS
    //
    getMessages: () => ipcRenderer.invoke("messages:get-all"),
    getMessageById: (id) => ipcRenderer.invoke("messages:get-by-id", id),
    getMessageByMsgNum: (msgNum) => ipcRenderer.invoke("messages:get-by-msgnum", msgNum),

    deleteMessage: (id) => ipcRenderer.invoke("messages:delete", id),

    markMessageArchived: (id) => ipcRenderer.invoke("messages:mark-archived", id),

    markMessageDownloaded: (id) => ipcRenderer.invoke("messages:mark-download", id),

    markMessageRead: (id) => ipcRenderer.invoke("messages:mark-read", id),

    onMessageDeleted: (callback) =>
        ipcRenderer.on("messages:deleted", (_e, msgNum) => callback(msgNum)),

    onMessageDownloaded: (callback) =>
        ipcRenderer.on("messages:downloaded", (_e, msgNum) => callback(msgNum)),

    onMessageArchived: (callback) =>
        ipcRenderer.on("messages:archived", (_e, msgNum) => callback(msgNum)),

    onMessageRead: (callback) =>
        ipcRenderer.on("messages:read", (_e, id) => callback(id)),

    onMessagesReceived: (callback) =>
        ipcRenderer.on("messages:received", (_e, data) => callback(data)),


    //
    // BBS COMMANDS
    //
    sendToBbs: (cmd) => ipcRenderer.send("bbs:send-command", cmd),
    sendReceive: () => ipcRenderer.send("bbs:send-receive"),
    sendOutbox: () => ipcRenderer.invoke("bbs:send-outbox"),
    sendBbsMessage: (msg) => ipcRenderer.invoke("bbs:send-message", msg),

    receiveMessages: () => ipcRenderer.invoke("bbs:receive-messages"),
    readMessage: (msgNum) => ipcRenderer.send("bbs:read-message", msgNum),

    onMessageBody: (callback) =>
        ipcRenderer.on("bbs:message-body", (_e, msg) => callback(msg)),

    filterBulletins: (category) =>
        ipcRenderer.send("bbs:filter-bulletins", category),

    getBulletinCategories: () =>
        ipcRenderer.invoke("bbs:get-bulletin-categories"),

    onBulletinList: (callback) =>
        ipcRenderer.on("bbs:bulletin-list", (_e, rows) => callback(rows)),

    // CLEAR MESSAGE VIEW
    onClearMessageView: (callback) =>
        ipcRenderer.on("bbs:clear-message-view", (_e) => callback()),

    // COMMAND OUTPUT
    onCommandOutput: (callback) =>
        ipcRenderer.on("bbs:command-output", (_e, line) => callback(line)),


    //
    // CONTEXT MENU
    //
    showMessageContextMenu: (template) =>
        ipcRenderer.send("menu:show-message-context", template),

    createMenu: (template) =>
        ipcRenderer.send("menu:create", template),

    onMenuItemClicked: (callback) =>
        ipcRenderer.on("menu:item-clicked", (_e, label) => callback(label)),


    //
    // OUTBOX / SAVED MESSAGES
    //
    saveOutboxMessage: (msg) => ipcRenderer.invoke("messages:save-outbox", msg),
    saveMessage: (msg) => ipcRenderer.invoke("messages:save", msg),


    //
    // ADDRESS BOOK
    //
    saveAddressBookEntry: (entry) =>
        ipcRenderer.invoke("address-book:save", entry),

    getAddressBook: () =>
        ipcRenderer.invoke("address-book:get"),

    getAddressBookEntry: (id) =>
        ipcRenderer.invoke("address-book:get-one", id),

    updateAddressBookEntry: (entry) =>
        ipcRenderer.invoke("address-book:update", entry),

    deleteAddressBookEntry: (id) =>
        ipcRenderer.invoke("address-book:delete", id),

    searchAddressBook: (prefix) =>
        ipcRenderer.invoke("address-book:search", prefix),

    debugAddressBook: () =>
        ipcRenderer.invoke("address-book:debug"),

    onOpenAddressBookAdd: (callback) =>
        ipcRenderer.on("address-book:open-add", callback),

    onOpenAddressBookView: (callback) =>
        ipcRenderer.on("address-book:open-view", callback),


    //
    // WHITE PAGES IMPORT
    //
    startWhitePagesMode: () =>
        ipcRenderer.send("whitepages-start"),

    onOpenWhitePagesModal: (callback) =>
        ipcRenderer.on("whitepages:open-modal", callback),

    onWhitePagesLine: (callback) =>
        ipcRenderer.on("whitepages:line", (_e, entry) => callback(entry)),


    //
    // YAPP FILE TRANSFER
    //
    startYappReceive: (info) =>
        ipcRenderer.send("yapp:receive-start", info),

    startYappSend: (info) =>
        ipcRenderer.send("yapp:send-start", info),

    onYappSendError: (callback) =>
        ipcRenderer.on("yapp:send-error", callback),

    requestYappFileList: () =>
        ipcRenderer.send("yapp:request-file-list"),

    onYappFileList: (callback) =>
        ipcRenderer.on("yapp:file-list", (_e, files) => callback(files)),

    onOpenYappReceive: (callback) =>
        ipcRenderer.on("yapp:open-receive", callback),

    onYappRecvProgress: (callback) =>
        ipcRenderer.on("yapp:recv-progress", callback),

    onYappReceiveComplete: (callback) =>
        ipcRenderer.on("yapp:receive-complete", callback),

    pickDirectory: () =>
        ipcRenderer.invoke("fs:pick-directory"),

    pickFile: () =>
        ipcRenderer.invoke("fs:pick-file"),

    onOpenYappSend: (callback) =>
        ipcRenderer.on("yapp:open-send", callback),

    onYappSendComplete: (callback) =>
        ipcRenderer.on("yapp:send-complete", callback),

    sendYappFile: (filePath) =>
        ipcRenderer.invoke("yapp:send-file", filePath),

    onYappSendProgress: (callback) =>
        ipcRenderer.on("yapp:send-progress", (_e, data) => callback(data))
});

console.log("PRELOAD LOADED");
