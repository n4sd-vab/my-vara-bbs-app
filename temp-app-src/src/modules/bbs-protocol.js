const { BrowserWindow } = require('electron');
const { parseListLine, createDateString } = require('../utils/parsers');

class BbsProtocol {
  constructor(varaConnection, databaseManager, yappTransfer, mainWindow) {
    this.varaConnection = varaConnection;
    this.database = databaseManager;
    this.yappTransfer = yappTransfer;
    this.mainWindow = mainWindow;

    // State variables
    this.messageListMode = "local";
    this.listBuffer = "";
    this.killBuffer = "";
    this.inReadMode = false;
    this.currentReadMsgNum = null;
    this.currentReadBody = [];
    this.readBuffer = "";
    this.readQueue = [];   // NEW — queue for auto-downloads
    this.batchQueue = [];     // array of arrays of msgNums
    this.batchActive = false;
    this.batchSize = 10;
    this.endOfFileList = false;
    this.endOfReadMode = false;
    this.whitePagesMode = false;
    this.whitePagesResults = [];
    this.wpBuffer = "";
    this.subscriptions = [];
    this.outboxMsg = false;
    this.commandMode = false;
    // When true, suppress automatic batch downloads after list retrievals
    this.deferBatchDownloads = false;

    this.privateToDownload = [];
    this.bulletinsToDownload = [];
  }

  setSubscriptions(list) {
    this.subscriptions = list;
    console.log("BBS Protocol: Subscriptions updated:", this.subscriptions);
    //this.sendToRenderer("ui:toast", "Bulletin subscriptions updated: " + this.subscriptions.join(", "));
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

    this.sendToRenderer("ui:toast", "Connecting to BBS...");

    this.sendConnectCommand();
    const ready = await this.waitForBbsReady();

    if (ready) {
      this.sendToRenderer("ui:toast", "Connected to BBS");
      this.batchActive = false;
      this.inReadMode = false;
      this.batchQueue = [];
    }

    return ready;
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
        if (Date.now() - start > 20000) {
          clearInterval(timer);
          reject(new Error("Timeout waiting for BBS connect"));
        }
      }, 200);
    });
  }

  async waitForPrompt(timeout = 20000) {
    const promptRegex = /^\s*de\s+[A-Z0-9-]+>\s*$/i;
    return await this.varaConnection.waitForLine(promptRegex, timeout);
  }

  // Message operations
  async receiveMessages() {
    await this.ensureBbsConnected();

    //await this.sendKillCommandIfNeeded();

    // FAST SYNC: only get NEW messages
    this.endOfFileList = false;
    this.messageListMode = "bbs";
    this.sendToRenderer("ui:toast", "Checking for new messages...");
    this.varaConnection.sendData("L \r");   // NEW messages only

    await this.waitForListModeToFinish();

    // Determine which private messages need bodies
    const rows = this.database.getPrivateMessagesForDownload();
    const toDownload = rows.map(r => r.msgNum);

    console.log("Private messages to download:", toDownload);
    this.sendToRenderer("ui:toast", `Found ${toDownload.length} new private messages to download`);

    if (toDownload.length > 0) {
      this.endOfReadMode = false;
      // this.varaConnection.sendData("R " + toDownload.join(" ") + "\r");
      for (const msgNum of toDownload) {
        this.downloadMessage(msgNum);
      }
      this.inReadMode = true;
      await this.waitForReadModeToFinish();
    }

    // Send event to refresh the message list in renderer
    this.sendToRenderer("messages:received", { downloaded: toDownload.length });

    return { downloaded: toDownload.length };
  }

  getMessageByNumber(msgNum) {
    const stmt = this.db.prepare("SELECT * FROM messages WHERE msgNum = ?");
    return stmt.get(msgNum);
  }

  async fullSync() {
    await this.ensureBbsConnected();

    // SAFETY: leave kill disabled while things are stabilizing
    // await this.sendKillCommandIfNeeded();

    // -----------------------------
    // 1. PRIVATE MESSAGE FULL SYNC
    // -----------------------------
    // Reset seenInLP = 0 for all private messages
    this.database.markPrivateMessagesSeen();  // your existing function

    this.endOfFileList = false;
    this.messageListMode = "lp";
    this.deferBatchDownloads = true;  // don't auto-download during fullSync
    this.sendToRenderer("ui:toast", "Requesting full private message list...");
    this.varaConnection.sendData("LP\r");

    await this.waitForListModeToFinish();

    this.sendToRenderer("ui:toast", "Trashing unseen private messages...");
    this.database.deleteUnseenPrivateMessages();  // your existing function

    // -----------------------------
    // 2. BULLETIN FULL SYNC
    // -----------------------------
    // Reset seenInLB = 0 for all bulletins
    this.database.markBulletinMessagesSeen();  // your existing function

    this.endOfFileList = false;
    this.messageListMode = "lb";
    this.deferBatchDownloads = true;  // still defer during fullSync
    this.sendToRenderer("ui:toast", "Requesting full bulletin list...");
    this.varaConnection.sendData("LB\r");

    await this.waitForListModeToFinish();

    this.sendToRenderer("ui:toast", "Trashing unseen bulletins...");
    this.database.deleteUnseenBulletinMessages();  // your existing function

    // Re-enable normal batch behavior after fullSync
    this.deferBatchDownloads = false;

    return { status: "full-sync-complete" };
  }

  async sendOutboxMessages() {
    const outbox = this.database.getOutboxMessages();

    if (outbox.length === 0) {
      this.sendToRenderer("ui:toast", "Outbox is empty");
      return;
    }

    for (const msg of outbox) {
      this.outboxMsg = true;
      await this.uploadSingleMessage(msg);
    }

    this.sendToRenderer("ui:toast", "Outbox messages sent");
  }

  async sendKillCommandIfNeeded() {
    const trash = this.database.getPrivateMessagesInTrash();
    if (trash.length === 0) return false;

    const batchSize = 25;

    for (let i = 0; i < trash.length; i += batchSize) {
      const batch = trash.slice(i, i + batchSize);
      const nums = batch.map(m => m.msgNum).join(" ");
      const cmd = `K ${nums}`;

      console.log("Sending K batch:", cmd);

      this.messageListMode = "kill";
      this.killBuffer = "";

      this.varaConnection.sendData(cmd + "\r");

      await this.waitForKillToFinish();
    }

    this.database.deletePrivateTrashMessages();
    return true;
  }

  async uploadSingleMessage(msg) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log("Uploading message to BBS:", msg);
        this.sendToRenderer("ui:toast", `Uploading message to BBS: ${msg.subject}`);
        await this.ensureBbsConnected();

        //await this.sendKillCommandIfNeeded();

        // Register waiters BEFORE sending SP
        const wTitle = this.varaConnection.waitForLine(/Enter Title/i);
        const wAddress = this.varaConnection.waitForLine(/Address/i);

        const prefix = msg.type === "P" ? "SP"
          : msg.type === "B" ? "SB"
            : msg.type === "T" ? "ST"
              : "SP";

        const sendcmd = `${prefix} ${msg.recipient}\r`;

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
        const date = createDateString(); //short BBS format dd-mmm
        const pDate = new Date();
        const datePosted = pDate.toISOString().slice(0, 16).replace('T', ' ') + 'Z';

        if (this.outboxMsg) {
          // Replace temporary msgNum with real one and mark as sent
          this.database.updateOutboxMessageSent(msg.id, msgNum, size, date, datePosted);
        } else {
          // Messages sent directly from compose form
          const lastInsertId = this.database.getLastInsertRowId(); // Get the last inserted message ID

          this.database.updateMessageSent(lastInsertId, msgNum, size, date, datePosted);
        }
        this.outboxMsg = false;

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

    console.log("Entering READ MODE for message", msgNum);

    this.inReadMode = true;
    if (this.varaConnection.dataSocket) {
      this.varaConnection.sendData(`R ${msgNum}\r`);
    }
  }

  finishReadMode() {
    console.log("Finished reading msg", this.readingMsgNum);

    this.inReadMode = false;
    this.promptSeen = false;
    this.lastBodyTime = null;
    this.readingMsgNum = null;
    this.currentReadBody = [];
    this.readBuffer = "";

    if (this.readQueue.length > 0) {
      const next = this.readQueue.shift();
      console.log("Starting next queued read:", next);
      this.sendToRenderer("ui:toast", `Starting download of message ${next}...`);
      this.downloadMessage(next);
    }
  }

  // Command building
  buildKillCommand(msgNums) {
    if (!msgNums || msgNums.length === 0) return null;

    const nums = msgNums.map(m => m.msgNum).join(" ");
    console.log("Built K command for messages:", nums);
    //return `K ${nums}`;
    return
  }

  // Send command: Onlyused for Direct BBS Command Entry in the UI
  sendBbsCommand(cmd) {
    console.log("MAIN: manual command:", cmd);

    this.commandMode = true;
    this.inReadMode = false;
    this.messageListMode = "none";
    this.currentReadBody = [];
    this.listBuffer = "";

    this.sendToRenderer("bbs:clear-message-view");
    this.sendToRenderer("bbs:command-output", cmd + "\r");

    if (this.varaConnection.dataSocket) {
      this.varaConnection.sendData(cmd + "\r");
    }
  }

  downloadMessage(msgNum) {
    // Single-click = batch of one
    this.queueBatchDownload([msgNum]);
  }

  queueBatchDownload(msgNums) {
    if (!msgNums || msgNums.length === 0) return;

    this.sendToRenderer("ui:toast", `Queued ${msgNums.length} messages for download`);

    for (const num of msgNums) {
      console.log("Queued for download:", num);
      this.batchQueue.push(Number(num));
    }

    if (!this.batchActive) {
      this.startNextBatch();
    }
  }

  startNextBatch() {
    if (this.batchQueue.length === 0) {
      this.batchActive = false;
      return;
    }

    // Build an array of message numbers
    const msgNums = [];

    while (msgNums.length < this.batchSize && this.batchQueue.length > 0) {
      msgNums.push(this.batchQueue.shift());
    }

    // SAFETY CHECK: If somehow empty, stop batching
    if (msgNums.length === 0) {
      this.batchActive = false;
      return;
    }

    console.log("Starting batch read for messages:", msgNums);
    this.sendToRenderer("ui:refresh-message-lists");
    this.sendToRenderer("ui:toast", `Starting download of message(s): ${msgNums.join(", ")}`);

    this.batchActive = true;
    this.inReadMode = true;

    this.readBuffer = "";
    this.currentReadBody = [];

    // Store for parser
    this.readingMsgNums = msgNums;

    // Send the R command
    this.varaConnection.sendData(`R ${msgNums.join(" ")}\r`);
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
        //this.commandMode = false;
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
      this.privateToDownload = [];
      this.bulletinsToDownload = [];
      this.processListModeData(data);
      return;
    }

    if (this.messageListMode === "kill") {
      this.processKillModeData(data);
      return;
    }

    // Read mode
    if (this.inReadMode) {
      this.commandMode = false
      this.processReadModeData(data);
      return;
    }

    if (this.commandMode) {
      let text = data.toString();

      // Convert CR to CRLF
      text = text.replace(/\r/g, "\r\n");

      this.sendToRenderer("bbs:command-output", text);
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

        // Kick off batch downloads
        if (!this.deferBatchDownloads) {
          if (this.privateToDownload.length > 0) {
            this.queueBatchDownload(this.privateToDownload);
            this.sendToRenderer("ui:toast", `Downloading ${this.privateToDownload.length} private messages`);
          }

          if (this.bulletinsToDownload.length > 0) {
            this.queueBatchDownload(this.bulletinsToDownload);
            this.sendToRenderer("ui:toast", `Downloading ${this.bulletinsToDownload.length} bulletins`);
          }
        } else {
          console.log("Batch downloads deferred by fullSync");
        }

        return;
      }

      const msgListPattern = /^\s*\d+\s+\d{1,2}-[A-Za-z]{3}\s+[A-Z$]{1,3}\s+\d+/;
      if (msgListPattern.test(line)) {
        const parsed = parseListLine(line);
        this.database.upsertMessageListEntry(parsed);

        console.log("Line added to database:", parsed);

        // Collect private messages
        if (parsed.type === "private" && !parsed.downloaded) {
          this.privateToDownload.push(parsed.msgNum);
        }

        // Collect subscribed bulletins
        if (parsed.type === "bulletin" &&
          this.subscriptions.includes(parsed.recipient) &&
          !parsed.downloaded) {

          this.bulletinsToDownload.push(parsed.msgNum);
        }

      }
    }
    this.sendToRenderer("ui:refresh-message-lists");

    this.listBuffer = parts[parts.length - 1];
  }

  processReadModeData(data) {
    if (!this.inReadMode) {
      // Safety: ignore if we're not in read mode
      return;
    }

    const text = data.toString();
    this.readBuffer += text;

    const parts = this.readBuffer.split('\r');

    for (let i = 0; i < parts.length - 1; i++) {
      const raw = parts[i];
      const line = raw.trim();

      // 1. Explicit footer: end of ONE message
      const footer = line.match(/^\[End of Message #(\d+)/i);
      if (footer) {
        const msgNum = parseInt(footer[1]);
        console.log("Explicit footer for msg", msgNum);

        this.currentReadBody.push(raw);
        const body = this.currentReadBody.join("\n");

        this.database.saveMessageBody(msgNum, body);
        this.database.markMessageDownloaded(msgNum);

        this.sendToRenderer("bbs:message-body", { msgNum, body });
        this.sendToRenderer("bbs:message-read", msgNum);

        // Prepare for possible next message in same batch
        this.currentReadBody = [];
        continue;
      }

      // 2. Prompt: end of the ENTIRE batch
      if (/^\s*de\s+[A-Z0-9\-]+>\s*$/i.test(line)) {
        console.log("Prompt detected: end of batch read");
        this.sendToRenderer("ui:refresh-message-lists");

        this.inReadMode = false;
        this.readBuffer = "";
        this.currentReadBody = [];

        // Start next batch if queued
        if (this.batchQueue.length > 0) {
          this.startNextBatch();
        } else {
          this.batchActive = false;
        }
        return;
      }

      // 3. Start of a new message header
      if (/^From:\s+(.+)/i.test(line)) {
        console.log("Start of message header");
        this.currentReadBody = [];
        this.currentReadBody.push(raw);
        continue;
      }

      // 4. Normal body line
      this.currentReadBody.push(raw);
    }

    // Keep remainder in buffer
    this.readBuffer = parts[parts.length - 1];
  }

  processKillModeData(data) {
    const text = data.toString();
    this.killBuffer += text;

    const parts = this.killBuffer.split('\r');

    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i].trim();
      if (!line) continue;

      // BPQ: "Message #### not found"
      if (/^Message\s+\d+\s+not\s+found/i.test(line)) {
        console.log("KILL:", line);
        continue;
      }

      // BPQ: "Message #### killed"
      if (/^Message\s+\d+\s+killed/i.test(line)) {
        console.log("KILL:", line);
        continue;
      }

      // BPQ prompt → K batch complete
      if (/^\s*de\s+[A-Z0-9\-]+>\s*$/i.test(line)) {
        console.log("KILL: Completed");

        this.messageListMode = "local";
        this.killBuffer = "";

        if (this.killResolve) {
          this.killResolve();
          this.killResolve = null;
        }
        return;
      }
    }

    this.killBuffer = parts[parts.length - 1];
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

  waitForKillToFinish() {
    return new Promise(resolve => {
      this.killResolve = resolve;
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