const { contextBridge, ipcRenderer } = require("electron");

// Central dispatcher to avoid creating many ipcRenderer listeners (prevents memory leak warnings)
const _channelCallbacks = new Map();
function _subscribe(channel, callback) {
    if (!_channelCallbacks.has(channel)) {
        _channelCallbacks.set(channel, []);
        ipcRenderer.on(channel, (_e, data) => {
            const list = _channelCallbacks.get(channel) || [];
            for (const cb of list.slice()) {
                try { cb(data); } catch (err) { console.error('Handler error for', channel, err); }
            }
        });
    }
    _channelCallbacks.get(channel).push(callback);
    return () => {
        const arr = _channelCallbacks.get(channel);
        if (!arr) return;
        const idx = arr.indexOf(callback);
        if (idx >= 0) arr.splice(idx, 1);
    };
}

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

// Forms API
/* contextBridge.exposeInMainWorld("formsAPI", {
  openICS213Form: () => ipcRenderer.send("open-ics213-form")
}); */


//
// BBS / MESSAGES API
//
contextBridge.exposeInMainWorld("electronAPI", {

    //
    // UI / WINDOW EVENTS
    //
    onToggleVaraConsole: (callback) =>
        ipcRenderer.on("ui:toggle-vara-console", (_e, visible) => callback(visible)),

    onOpenPreferences: (callback) =>
        ipcRenderer.on("ui:open-preferences", callback),

    onOpenBbsHelp: (callback) =>
        ipcRenderer.on("ui:open-bbs-help", callback),

    onOpenAbout: (callback) =>
        ipcRenderer.on("ui:open-about", callback),

    // Toast notifications from main
    onToast: (callback) =>
        ipcRenderer.on("ui:toast", (_e, text) => callback(text)),

    // Use for sending toast requests from renderer to main (e.g. from settings page)
    showToast: (text) => ipcRenderer.send("ui:toast", text),

    // Forms can request opening the compose modal in the main window
    openComposeFromForm: (payload) =>
        ipcRenderer.send("forms:compose-message", payload),

    onComposeFromForm: (callback) =>
        _subscribe("forms:compose-message", callback),
    

    //
    // MESSAGE LIST / DB ACCESS
    //
    getMessages: () => ipcRenderer.invoke("messages:get-all"),
    getMessageById: (id) => ipcRenderer.invoke("messages:get-by-id", id),
    getMessageByMsgNum: (msgNum) => ipcRenderer.invoke("messages:get-by-msgnum", msgNum),

    deleteMessage: (id) => ipcRenderer.invoke("messages:delete", id),

    deleteMultipleMessages: (msgNums) =>
        ipcRenderer.invoke("messages:delete-multiple", msgNums),

    // markMessageArchived: (id) => ipcRenderer.invoke("messages:mark-archived", id),
    moveMessageToFolder: (msgNum, folder) =>
        ipcRenderer.invoke("messages:move-to-folder", msgNum, folder),

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

    // New event for message moved to folder
    onMessageMoved: (callback) =>
        ipcRenderer.on("messages:moved", (_event, data) => callback(data)),

    emptyTrash: () => ipcRenderer.invoke("messages:empty-trash"),

    onTrashEmptied: (callback) =>
        ipcRenderer.on("messages:trash-emptied", (_e, count) => callback(count)),

    syncMessagesWithBbs: (type, rows) =>
        ipcRenderer.invoke("messages:sync-with-bbs", type, rows),

    //
    // BBS COMMANDS
    //
    sendToBbs: (cmd) => ipcRenderer.send("bbs:send-command", cmd),
    sendReceive: () => ipcRenderer.send("bbs:send-receive"),
    sendOutbox: () => ipcRenderer.invoke("bbs:send-outbox"),
    sendBbsMessage: (msg) => ipcRenderer.invoke("bbs:send-message", msg),

    receiveMessages: () => ipcRenderer.invoke("bbs:receive-messages"),
    readMessage: (msgNum) => ipcRenderer.send("bbs:read-message", msgNum),

    queueBatchDownload: (msgNums) => ipcRenderer.invoke("bbs:queue-batch-download", msgNums),

    onMessageBody: (callback) =>
        ipcRenderer.on("bbs:message-body", (_e, msg) => callback(msg)),

    filterBulletins: (category) =>
        ipcRenderer.send("bbs:filter-bulletins", category),

    filterBulletinsSender: (sender) =>
        ipcRenderer.send("bbs:filter-bulletins-sender", sender),

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

    onBbsPromptReady: (callback) =>
        _subscribe("bbs:prompt-ready", callback),


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
        ipcRenderer.on("yapp:recv-progress", (_e, data) => callback(data)),

    onYappReceiveComplete: (callback) =>
        ipcRenderer.on("yapp:receive-complete", callback),

    pickDirectory: () =>
        ipcRenderer.invoke("fs:pick-directory"),

    pickFile: () =>
        ipcRenderer.invoke("fs:pick-file"),

    readTextFile: (filePath) =>
        ipcRenderer.invoke("fs:read-text-file", filePath),

    saveFile: (payload) =>
        ipcRenderer.invoke("fs:save-file", payload),

    onOpenYappSend: (callback) =>
        ipcRenderer.on("yapp:open-send", callback),

    onYappSendComplete: (callback) =>
        ipcRenderer.on("yapp:send-complete", callback),

    sendYappFile: (filePath) =>
        ipcRenderer.invoke("yapp:send-file", filePath),

    onYappSendProgress: (callback) =>
        _subscribe("yapp:send-progress", callback),

    onYappSendStatus: (callback) =>
        _subscribe("yapp:send-status", callback),

    onVaraBuffer: (callback) =>
        _subscribe("vara:buffer", callback)

});

console.log("PRELOAD LOADED");
