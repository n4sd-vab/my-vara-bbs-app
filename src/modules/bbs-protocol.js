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
    this.inReadMode = false;
    this.currentReadMsgNum = null;
    this.currentReadBody = [];
    this.readBuffer = "";
    this.readQueue = [];   // NEW — queue for auto-downloads
    this.batchQueue = [];     // array of arrays of msgNums
    this.batchActive = false;
    this.endOfFileList = false;
    this.endOfReadMode = false;
    this.whitePagesMode = false;
    this.whitePagesResults = [];
    this.wpBuffer = "";
    this.subscriptions = [];
    this.outboxMsg = false;

    this.privateToDownload = [];
    this.bulletinsToDownload = [];
  }

  setSubscriptions(list) {
    this.subscriptions = list;
    console.log("BBS Protocol: Subscriptions updated:", this.subscriptions);
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
    this.varaConnection.sendData("L \r");   // NEW messages only

    await this.waitForListModeToFinish();

    // Determine which private messages need bodies
    const rows = this.database.getPrivateMessagesForDownload();
    const toDownload = rows.map(r => r.msgNum);

    console.log("Messages to download:", toDownload);

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
      this.outboxMsg = true;
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

  /*   finishReadMode() {
      if (!this.inReadMode) return;
  
      console.log("Finishing READ MODE for message", this.currentReadMsgNum);
  
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
    } */

  /* finishReadMode() {
    console.log("Finished reading msg", this.readingMsgNum);

    this.inReadMode = false;
    this.readingMsgNum = null;
    this.currentReadBody = [];
    this.readBuffer = "";

    // Start next queued read if any
    if (this.readQueue.length > 0) {
      const next = this.readQueue.shift();
      console.log("Starting next queued read:", next);
      this.downloadMessage(next);
    }
  } */

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
      this.downloadMessage(next);
    }
  }

  // Send command: Onlyused for Direct BBS Command Entry in the UI
  sendCommand(cmd) {
    console.log("MAIN: manual command:", cmd);

    this.inReadMode = false;
    this.messageListMode = "none";
    this.currentReadBody = [];
    this.listBuffer = "";

    this.sendToRenderer("bbs:clear-message-view");
    this.sendToRenderer("bbs:command-output", cmd + "\r");

    this.commandMode = true;

    if (this.varaConnection.dataSocket) {
      this.varaConnection.sendData(cmd + "\r");
    }
  }

  /*   downloadBulletin(msgNum) {
      this.inReadMode = true;
      this.commandMode = false;
      this.readingMsgNum = msgNum;  // new
      this.currentReadMsgNum = msgNum; 
      this.currentReadBody = [];
  
      this.varaConnection.sendData(`R ${msgNum}\r`);
    } */


  /*   downloadMessage(msgNum) {
      if (this.inReadMode) {
        // Already reading something — queue this one
        this.readQueue.push(msgNum);
        return;
      }
  
      console.log("Starting read for message", msgNum);
  
      this.inReadMode = true;
      this.readingMsgNum = msgNum;
      this.currentReadBody = [];
      this.readBuffer = "";
  
      this.varaConnection.sendData(`R ${msgNum}\r`);
    } */

  downloadMessage(msgNum) {
    // Single-click = batch of one
    this.queueBatchDownload([msgNum]);
  }

  queueBatchDownload(msgNums) {
    if (!msgNums || msgNums.length === 0) return;

    this.batchQueue.push(msgNums);
    if (!this.batchActive) {
      this.startNextBatch();
    }
  }

  startNextBatch() {
    if (this.batchQueue.length === 0) {
      this.batchActive = false;
      return;
    }

    const msgNums = this.batchQueue.shift();
    console.log("Starting batch read for messages:", msgNums);

    this.batchActive = true;
    this.inReadMode = true;

    this.readBuffer = "";
    this.currentReadBody = [];

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

    // Read mode
    if (this.inReadMode) {
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
        if (this.privateToDownload.length > 0) {
          this.queueBatchDownload(this.privateToDownload);
        }

        if (this.bulletinsToDownload.length > 0) {
          this.queueBatchDownload(this.bulletinsToDownload);
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

    this.listBuffer = parts[parts.length - 1];
  }

  /* processReadModeData(data) {
    const text = data.toString();
    this.readBuffer += text;

    console.log("READ MODE: received data chunk, length =", text.length);

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
        const body = this.currentReadBody.join("\n");
        this.database.saveMessageBody(msgNum, body);

        // Notify the renderer once the body is written to the DB
        this.sendToRenderer("bbs:message-body", {
          msgNum,
          body
        });
        this.sendToRenderer("bbs:message-read", msgNum);

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
  } */

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