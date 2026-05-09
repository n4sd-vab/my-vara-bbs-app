const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');

class IpcHandlers {
  constructor(database, settings, varaConnection, bbsProtocol, yappTransfer) {
    this.database = database;
    this.settings = settings;
    this.varaConnection = varaConnection;
    this.bbsProtocol = bbsProtocol;
    this.yappTransfer = yappTransfer;

    this.setupHandlers();
  }

  setupHandlers() {
    // VARA connection handlers
    ipcMain.handle("vara-connect", async () => {
      return await this.varaConnection.connect();
    });

    ipcMain.handle("vara-send-command", async (_event, line) => {
      this.varaConnection.sendCommand(line);
    });

    ipcMain.handle("vara-send-data", async (_event, text) => {
      this.varaConnection.sendData(text);
    });

    ipcMain.handle("vara-disconnect", async () => {
      this.varaConnection.disconnect();
    });

    // Settings handlers
    ipcMain.handle("settings:get", async () => {
      return this.settings.getSettings();
    });

    ipcMain.handle("settings:set", async (_event, data) => {
      this.settings.setSettings(data);
    });

    ipcMain.handle("settings:get-one", async (_event, key) => {
      return this.settings.getSetting(key);
    });

    ipcMain.handle("settings:save", async (_event, { key, value }) => {
      this.settings.saveSetting(key, value);
    });

    // Message handlers
    ipcMain.handle("messages:get-all", () => {
      return this.database.getAllMessages();
    });

    ipcMain.handle("messages:get-by-id", (event, id) => {
      return this.database.getMessageById(id);
    });

    ipcMain.handle("messages:get-by-msgnum", (event, msgNum) => {
      return this.database.getMessageByMsgNum(msgNum);
    });

    ipcMain.handle("messages:mark-read", (event, id) => {
      this.database.markMessageRead(id);
      this.sendToRenderer("messages:read", id);
    });

    ipcMain.handle("messages:mark-saved", (_event, msgNum) => {
      this.database.markMessageSaved(msgNum);
    });

    ipcMain.handle("messages:delete", (_event, msgNum) => {
      const changes = this.database.deleteMessage(msgNum);
      if (changes > 0) {
        this.sendToRenderer("messages:deleted", msgNum);
      }
    });

    ipcMain.handle("messages:reply-to", (_event, msgNum) => {
      return this.database.getMessageByMsgNum(msgNum);
    });

    ipcMain.handle("messages:save-outbox", (_event, message) => {
      return this.database.saveOutboxMessage(message);
    });

    ipcMain.handle("messages:save", (_event, message) => {
      return this.database.saveMessage(message);
    });

    // BBS protocol handlers
    // ipcMain.handle('receive-messages', async () => {
    //   return await this.bbsProtocol.receiveMessages();
    // });

    ipcMain.handle('full-sync', async () => {
      return await this.bbsProtocol.fullSync();
    });

    ipcMain.handle("bbs:send-outbox", async () => {
      try {
        await this.bbsProtocol.sendOutboxMessages();
        return true;
      } catch (err) {
        console.error("Send failed:", err);
        throw err;
      }
    });

    ipcMain.handle("bbs:send-message", async (_event, msg) => {
      await this.bbsProtocol.uploadSingleMessage(msg);
      return true;
    });

    ipcMain.handle("bbs:receive-messages", async () => {
      console.log("IPC: bbs:receive-messages invoked");
      return await this.bbsProtocol.receiveMessages();
    });

    ipcMain.handle("bbs:get-bulletin-categories", () => {
      return this.database.getBulletinCategories();
    });

    ipcMain.handle("bbs:send-receive", async () => {
      await this.varaConnection.connect();
      await this.bbsProtocol.ensureBbsConnected();
      await this.bbsProtocol.sendOutboxMessages();

      this.bbsProtocol.sendCommand("L");
      return true;
    });

    // IPC event handlers (not handles)
    ipcMain.on("bbs-state", (_event, state) => {
      if (state.bbsLinkUp !== undefined) this.varaConnection.bbsLinkUp = state.bbsLinkUp;
      if (state.bbsPromptReady !== undefined) this.varaConnection.bbsPromptReady = state.bbsPromptReady;

      console.log("MAIN BBS STATE:", { bbsLinkUp: this.varaConnection.bbsLinkUp, bbsPromptReady: this.varaConnection.bbsPromptReady });
    });

    ipcMain.on("bbs:filter-bulletins", (event, category) => {
      const rows = this.database.getBulletinsByCategory(category);
      console.log("Filtering bulletins for category:", category, "rows:", rows.length);
      event.sender.send("bbs:bulletin-list", rows);
    });

    ipcMain.on("bbs:read-message", (event, msgNum) => {
      this.bbsProtocol.readMessage(msgNum);
    });

    ipcMain.on("bbs:send-command", (event, cmd) => {
      this.bbsProtocol.sendCommand(cmd);
    });

    // Address book handlers
    ipcMain.handle('address-book:save', (_event, entry) => {
      return this.database.saveAddressBookEntry(entry);
    });

    ipcMain.handle('address-book:get', () => {
      return this.database.getAddressBook();
    });

    ipcMain.handle("address-book:delete", (event, id) => {
      return this.database.deleteAddressBookEntry(id);
    });

    ipcMain.handle("address-book:get-one", (event, id) => {
      return this.database.getAddressBookEntry(id);
    });

    ipcMain.handle("address-book:search", (event, prefix) => {
      return this.database.searchAddressBook(prefix);
    });

    ipcMain.handle("address-book:update", (event, entry) => {
      return this.database.updateAddressBookEntry(entry);
    });

    ipcMain.handle("address-book:debug", () => {
      return this.database.debugAddressBook();
    });

    // WhitePages handlers
    ipcMain.on('whitepages-start', () => {
      this.bbsProtocol.startWhitePages();
    });

    // YAPP handlers
    ipcMain.on('yapp:receive-start', async (event, info) => {
      const { filename, directory } = info;
      this.yappTransfer.startReceive(filename, directory);
    });

    ipcMain.on("yapp-request-file-list", () => {
      this.yappTransfer.requestFileList();
    });

    ipcMain.on("yapp:send-start", (event, info) => {
      const { fileName, fileSize, fileBytes } = info;
      this.yappTransfer.startSend(fileName, fileSize, fileBytes);
    });

    ipcMain.handle("yapp-send-file", async (_event, filePath) => {
      try {
        const data = await fs.promises.readFile(filePath);
        return data;
      } catch (err) {
        console.error("Failed to read file:", err);
        return null;
      }
    });

    // Dialog handlers
    ipcMain.handle("pick-directory", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"]
      });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle("pick-file", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    });

    // Buffer utilities
    ipcMain.handle("buffer-alloc", (_e, size) => {
      return Buffer.alloc(size);
    });

    ipcMain.handle("buffer-from-array", (_e, arr) => {
      return Buffer.from(arr);
    });

    ipcMain.handle("buffer-concat", (_e, list) => {
      return Buffer.concat(list);
    });
  }

  sendToRenderer(event, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(event, data);
    }
  }
}

module.exports = IpcHandlers;