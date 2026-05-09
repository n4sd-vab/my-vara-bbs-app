const { BrowserWindow } = require('electron');
const { parseListLine, createDateString } = require('../utils/parsers');

class BbsProtocol {
  constructor(varaConnection, databaseManager, yappTransfer) {
    this.varaConnection = varaConnection;
    this.database = databaseManager;
    this.yappTransfer = yappTransfer;

    // State variables
    this.messageListMode = "local";
    this.listBuffer = "";
    this.inReadMode = false;
    this.currentReadMsgNum = null;
    this.currentReadBody = [];
    this.readBuffer = "";
    this.endOfFileList = false;
    this.endOfReadMode = false;
    this.whitePagesMode = false;
    this.whitePagesResults = [];
    this.wpBuffer = "";
  }

  // Connection and status
  async ensureConnected() {
    if (!this.varaConnection.isConnected()) {
      await this.varaConnection.connect();
    }
    return true;
  }

  async ensureBbsConnected() {
    const status = this.varaConnection.getBbsStatus();
    if (status.bbsLinkUp && status.bbsPromptReady) return true;

    this.sendConnectCommand();
    return await this.waitForBbsReady();
  }

  sendConnectCommand() {
    if (!this.varaConnection.cmdSocket) {
      console.error("sendConnectCommand: cmdSocket is not connected");
      return;
    }

    const settings = this.varaConnection.settingsManager.getSettings();
    const myCall = settings.myCall || "";
    const bbsCall = settings.bbsCall || "";
    const digi1 = settings.digi1 || "";
    const digi2 = settings.digi2 || "";

    let cmd = `CONNECT ${myCall} ${bbsCall}`;
    if (digi1) cmd += ` VIA ${digi1}`;
    if (digi2) cmd += ` ${digi2}`;

    console.log("MAIN: Sending CONNECT:", cmd);
    this.varaConnection.sendCommand(cmd);
  }

  async waitForBbsReady() {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const status = this.varaConnection.getBbsStatus();
        if (status.bbsLinkUp && status.bbsPromptReady) {
          clearInterval(timer);
          resolve(true);
        }
        if (Date.now() - start > 15000) {
          clearInterval(timer);
          reject(new Error("Timeout waiting for BBS connect"));
        }
      }, 200);
    });
  }

  // Message operations
  async receiveMessages() {
    await this.ensureBbsConnected();

    // FAST SYNC: only get NEW messages
    this.endOfFileList = false;
    this.messageListMode = "bbs";
    this.varaConnection.sendData("L\r");   // NEW messages only

    await this.waitForListModeToFinish();

    // Determine which private messages need bodies
    const rows = this.database.getPrivateMessagesForDownload();
    const toDownload = rows.map(r => r.msgNum);

    if (toDownload.length > 0) {
      this.endOfReadMode = false;
      this.varaConnection.sendData("R " + toDownload.join(" ") + "\r");
      await this.waitForReadModeToFinish();
    }

    // Send event to refresh the message list in renderer
    this.sendToRenderer("messages:received", { downloaded: toDownload.length });

    return { downloaded: toDownload.length };
  }

  async fullSync() {
    await this.ensureBbsConnected();

    // 1. PRIVATE MESSAGE FULL SYNC (LP)
    this.database.markPrivateMessagesSeen();

    this.endOfFileList = false;
    this.messageListMode = "lp";
    this.varaConnection.sendData("LP\r");

    await this.waitForListModeToFinish();

    this.database.deleteUnseenPrivateMessages();

    // 2. BULLETIN FULL SYNC (LB)
    this.database.markBulletinMessagesSeen();

    this.endOfFileList = false;
    this.messageListMode = "lb";
    this.varaConnection.sendData("LB\r");

    await this.waitForListModeToFinish();

    this.database.deleteUnseenBulletinMessages();

    return { status: "full-sync-complete" };
  }

  async sendOutboxMessages() {
    const outbox = this.database.getOutboxMessages();

    if (outbox.length === 0) {
      this.sendToRenderer("toast", "Outbox is empty");
      return;
    }

    for (const msg of outbox) {
      await this.uploadSingleMessage(msg);
    }

    this.sendToRenderer("toast", "Outbox messages sent");
  }

  async uploadSingleMessage(msg) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log("Uploading message to BBS:", msg);
        await this.ensureBbsConnected();

        // Register waiters BEFORE sending SP
        const wTitle = this.varaConnection.waitForLine(/Enter Title/i);
        const wAddress = this.varaConnection.waitForLine(/Address/i);
        const sendcmd = msg.type === "P" ? `SP ${msg.recipient}\r` : `SB ${msg.recipient}\r`;

        this.varaConnection.sendData(sendcmd);

        // Wait for whichever comes first
        await Promise.race([wTitle, wAddress]);

        // Now wait specifically for Enter Title
        await wTitle;

        // Send title
        this.varaConnection.sendData(`${msg.subject}\r`);

        // Wait for Enter Message Text
        await this.varaConnection.waitForLine(/Enter Message Text/i);

        // Send body
        for (const line of msg.body.split(/\r?\n/)) {
          this.varaConnection.sendData(line + "\r");
        }

        // End message
        this.varaConnection.sendData("/ex\r");

        // Wait for Message: ### Size: ###  At: ####
        const result = await this.varaConnection.waitForLine(/Message:\s+(\d+).*Size:\s+(\d+)/i);

        const match = result.match(/Message:\s+(\d+).*Size:\s+(\d+)/i);
        const msgNum = match[1];
        const size = match[2];

        // Update DB
        const date = createDateString();
        this.database.updateOutboxMessageSent(msg.id, msgNum, size, date);

        resolve();

      } catch (err) {
        console.error("Upload failed:", err);
        reject(err);
      }
    });
  }

  // Read mode handling
  readMessage(msgNum) {
    this.currentReadMsgNum = msgNum;
    this.currentReadBody = [];
    this.readBuffer = "";

    this.inReadMode = true;
    if (this.varaConnection.dataSocket) {
      this.varaConnection.sendData(`R ${msgNum}\r`);
    }
  }

  finishReadMode() {
    if (!this.inReadMode) return;

    this.inReadMode = false;

    const body = this.currentReadBody.join("\n");
    console.log("READ MODE END for message", this.currentReadMsgNum);
    console.log("READ MODE: accumulated body length =", this.currentReadBody.length);

    this.database.saveMessageBody(this.currentReadMsgNum, body);

    this.sendToRenderer("bbs:message-body", {
      msgNum: this.currentReadMsgNum,
      body
    });
    this.sendToRenderer("bbs:message-read", this.currentReadMsgNum);

    this.currentReadBody = [];
    this.readBuffer = "";
  }

  // Send command
  sendCommand(cmd) {
    console.log("MAIN: sending to DATA port:", cmd);
    if (cmd.startsWith("L")) {
      this.messageListMode = "bbs";
      this.listBuffer = "";
    }
    if (this.varaConnection.dataSocket) {
      this.varaConnection.sendData(cmd + "\r");
    }
  }

  // WhitePages handling
  startWhitePages() {
    this.whitePagesMode = true;
    this.whitePagesResults = [];
  }

  // Data processing
  processData(data) {
    // Detect BBS prompt
    const lines = data.toString().split('\r');
    for (const raw of lines) {
      const line = raw.trim();
      if (/^\s*de\s+[A-Z0-9\-]+>\s*$/i.test(line)) {
        this.varaConnection.bbsPromptReady = true;
        console.log("DATA: BBS prompt detected");
      }
    }

    // Handle YAPP data first
    if (this.yappTransfer.inYapp || this.yappTransfer.inYappSend || this.yappTransfer.inFileList) {
      this.yappTransfer.handleData(data);
      return;
    }

    // WhitePages mode
    if (this.whitePagesMode) {
      this.processWhitePagesData(data);
      return;
    }

    // Message list mode
    if (this.messageListMode === "bbs" || this.messageListMode === "lp" || this.messageListMode === "lb") {
      this.processListModeData(data);
      return;
    }

    // Read mode
    if (this.inReadMode) {
      this.processReadModeData(data);
      return;
    }

    // Normal BBS text mode
    this.processNormalData(data);
  }

  processWhitePagesData(data) {
    this.wpBuffer += data.toString();

    const parts = this.wpBuffer.split('\r');

    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i].trim();

      if (!line) continue;

      if (/^de\s+[A-Za-z0-9]{3,6}>$/.test(line)) {
        console.log("WhitePages: End of listing detected");
        this.whitePagesMode = false;
        this.wpBuffer = "";
        return;
      }

      if (/^[A-Z0-9]{3,6}\s+\S+/.test(line)) {
        const { parseWhitePagesLine } = require('../utils/parsers');
        const entry = parseWhitePagesLine(line);
        this.whitePagesResults.push(entry);
        this.sendToRenderer("whitepages:line", entry);
      }
    }

    this.wpBuffer = parts[parts.length - 1];
  }

  processListModeData(data) {
    const text = data.toString();
    this.listBuffer += text;

    const parts = this.listBuffer.split('\r');

    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i].trim();
      if (!line) continue;

      if (/^\s*de\s+[A-Z0-9\-]+>/i.test(line)) {
        this.messageListMode = "local";
        this.listBuffer = "";
        this.endOfFileList = true;
        this.sendToRenderer("bbs:list-end");
        return;
      }

      const msgListPattern = /^\s*\d+\s+\d{1,2}-[A-Za-z]{3}\s+[A-Z$]{1,3}\s+\d+/;
      if (msgListPattern.test(line)) {
        const parsed = parseListLine(line);
        this.database.upsertMessageListEntry(parsed);
        console.log("Line added to database:", parsed);
      }
    }

    this.listBuffer = parts[parts.length - 1];
  }

  processReadModeData(data) {
    const text = data.toString();
    this.readBuffer += text;

    const parts = this.readBuffer.split('\r');

    for (let i = 0; i < parts.length - 1; i++) {
      const raw = parts[i];
      const line = raw.trim();

      console.log("READ MODE line:", JSON.stringify(line));

      // End of message (explicit footer)
      const footer = line.match(/^\[End of Message #(\d+)/i);
      if (footer) {
        const msgNum = parseInt(footer[1]);
        console.log("END detected: explicit footer for msg", msgNum);

        this.currentReadBody.push(line);
        this.database.saveMessageBody(msgNum, this.currentReadBody.join("\n"));
        this.currentReadBody = [];
        continue;
      }

      // End of read mode (prompt)
      if (/^\s*de\s+[A-Z0-9\-]+>\s*$/i.test(line)) {
        console.log("END detected: prompt-only line");
        this.endOfReadMode = true;
        this.inReadMode = false;
        this.currentReadMsgNum = null;
        this.currentReadBody = [];
        this.readBuffer = "";
        return;
      }

      // Start of next message (From:)
      const nextStart = line.match(/^From:\s+(.+)/i);
      if (nextStart) {
        console.log("START of next message (From: line)");
        this.currentReadBody = [];
        this.currentReadBody.push(line);
        continue;
      }

      // Normal body line
      this.currentReadBody.push(raw);
    }

    this.readBuffer = parts[parts.length - 1];
  }

  processNormalData(data) {
    this.varaConnection.dataBuffer += data.toString();

    const parts = this.varaConnection.dataBuffer.split('\r');

    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i];
      this.logToRenderer('data', line);
      this.varaConnection.notifyLineListeners(line);
    }

    this.varaConnection.dataBuffer = parts[parts.length - 1];
  }

  // Utility methods
  waitForListModeToFinish() {
    return new Promise(resolve => {
      const check = () => {
        if (this.endOfFileList === true) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  waitForReadModeToFinish() {
    return new Promise(resolve => {
      const check = () => {
        if (this.endOfReadMode === true) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  logToRenderer(type, msg) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('vara:log', { type, msg });
    }
  }

  sendToRenderer(event, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(event, data);
    }
  }
}

module.exports = BbsProtocol;