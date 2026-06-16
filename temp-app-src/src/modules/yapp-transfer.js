const fs = require('fs');
const path = require('path');
const EventEmitter = require("events");
const { BrowserWindow } = require('electron');

const YAPP_ACK_TIMEOUT_MS = 300000; // 5 minutes for slow simplex radio links

class YappTransfer extends EventEmitter {
  constructor(varaConnection, settingsManager) {
    super();
    this.varaConnection = varaConnection;
    this.settingsManager = settingsManager;
    this.inYapp = false;
    this.inYappSend = false;
    this.yappReceiver = null;
    this.yappSend = null;
    this.inFileList = false;
    this.fileList = [];
  }

  // YAPP Receive functionality
  startReceive(filename, directory) {
    try {
      // 1. Tell BPQ to start sending the file
      this.varaConnection.sendData(`YAPP ${filename}\r`);

      // 2. Create the YAPP receiver
      this.yappReceiver = new YappReceiver(
        this.varaConnection.sendRawBytes.bind(this.varaConnection),
        directory,
        this.settingsManager
      );

      this.inYapp = true;
      console.log("YAPP receive started for:", filename);

      /*       this.yappReceiver.on("complete", (filePath) => {
              const windows = BrowserWindow.getAllWindows();
              if (windows.length > 0) {
                windows[0].webContents.send("yapp:receive-complete", filePath);
              }
            }); */

    } catch (err) {
      console.error("Error starting YAPP receive:", err);
      this.inYapp = false;
    }
  }

  requestFileList() {
    console.log("YAPP: Requesting FILES list...");
    if (this.varaConnection.dataSocket) {
      this.inFileList = true;
      this.fileList = [];
      console.log("YAPP: inFileList = true, sending FILES");
      this.varaConnection.sendData("FILES\r");
    } else {
      console.log("YAPP: dataSocket is NULL");
    }
  }

  handleFileListText(text) {
    console.log("YAPP FILELIST: Received text chunk:", JSON.stringify(text));

    const lines = text.split("\r");

    for (const line of lines) {
      console.log("YAPP FILELIST: Line:", JSON.stringify(line));

      // Detect FILES entries
      const fileMatch = line.match(/^(.+)\s+(\d+)$/);
      if (fileMatch) {
        const name = fileMatch[1].trim();
        const size = parseInt(fileMatch[2], 10);

        console.log("YAPP FILELIST: MATCHED FILE ENTRY:", name, size);
        this.fileList.push({ name, size });
        continue;
      }

      // End of list
      if (line.trim() === "" || line.includes("BPQ") || line.includes(">")) {
        console.log("YAPP FILELIST: END OF LIST DETECTED");
        console.log("YAPP FILELIST: Final list:", this.fileList);

        this.inFileList = false;
        this.sendToRenderer("yapp:file-list", this.fileList);

        this.fileList = [];
        return;
      }
    }
  }

  // YAPP Send functionality
  startSend(fileName, fileSize, fileBytes) {
    this.inYappSend = true;
    this.yappSend = null;

    console.log("IPC: yapp-start-send received");

    if (!this.varaConnection.dataSocket) {
      this.logToRenderer("error", "Cannot start YAPP send: data socket not connected.");
      return;
    }

    this.logToRenderer("info", `Starting YAPP send: ${fileName} (${fileSize} bytes)`);

    // Convert Uint8Array → Buffer
    const buffer = Buffer.from(fileBytes);

    // Start the state machine
    this.beginYappSendStateMachine(fileName, fileSize, buffer);
  }

  beginYappSendStateMachine(fileName, fileSize, fileBytes) {
    console.log("YAPP SEND MODE ACTIVATED");

    const enq = Buffer.from([0x05, 0x01]);
    this.varaConnection.sendRawBytes(enq);

    this.lastProgressUpdate = 0;
    this.lastSendPercent = -1;
    this.pendingSendBlocks = [];
    this.confirmedSent = 0; // bytes acknowledged by remote
    this.yappSend = {
      fileName,
      fileSize,
      fileBytes,
      offset: 0,
      phase: "waitingAckEnq",
      ackTimeout: null,
      startAckTimer: this.startAckTimer.bind(this),
      finishSend: this.finishSend.bind(this),
      abortSend: this.abortSend.bind(this),
      sendNextBlock: this.sendNextBlock.bind(this)
    };

    this.sendProgressToRenderer(0, 0, fileSize);
    this.yappSend.startAckTimer();
  }

  startAckTimer() {
    clearTimeout(this.yappSend.ackTimeout);
    this.yappSend.ackTimeout = setTimeout(() => {
      this.yappSend.abortSend("ACK timeout");
    }, YAPP_ACK_TIMEOUT_MS);
  }

  sendNextBlock() {
    if (this.yappSend.offset >= this.yappSend.fileBytes.length) {
      this.yappSend.phase = "waitingAckEof";
      this.yappSend.startAckTimer();
      return;
    }

    const remaining = this.yappSend.fileBytes.length - this.yappSend.offset;
    const chunk = this.yappSend.fileBytes.slice(
      this.yappSend.offset,
      this.yappSend.offset + YAPP_BLOCK_SIZE
    );

    const isFinal = chunk.length === remaining;

    const block = buildYappDataBlock(chunk, isFinal);
    this.varaConnection.sendRawBytes(block);
    this.yappSend.startAckTimer();

    this.yappSend.offset += chunk.length;
    // Track this block as pending confirmation from remote
    this.pendingSendBlocks.push(chunk.length);
    // Debug log for pending blocks
    console.log(`YAPP SEND: queued block ${chunk.length}, pendingCount=${this.pendingSendBlocks.length}, offset=${this.yappSend.offset}`);

    const percent = Math.floor((this.yappSend.offset / this.yappSend.fileBytes.length) * 100);
    const now = Date.now();
    const shouldUpdate = percent !== this.lastSendPercent || now - this.lastProgressUpdate > 100;

    if (shouldUpdate) {
      this.lastSendPercent = percent;
      this.lastProgressUpdate = now;
      // Emit progress based on confirmed (on‑air) bytes when available.
      // Do NOT report queued offset (which can fill the modem buffer) —
      // otherwise the UI jumps to 100% before data is actually transmitted.
      const queued = this.yappSend.offset;
      const confirmed = this.confirmedSent || 0;
      this.sendProgressToRenderer(queued, confirmed, this.yappSend.fileBytes.length);
    }

    if (isFinal) {
      this.yappSend.phase = "waitingAckEof";
      this.yappSend.startAckTimer();
    } else {
      setImmediate(this.yappSend.sendNextBlock);
    }
  }

  finishSend() {
    try {
      clearTimeout(this.yappSend.ackTimeout);

      const name = this.yappSend.fileName;
      // Emit final confirmed progress and clear state
      this.sendProgressToRenderer(this.yappSend.fileSize, this.yappSend.fileSize, this.yappSend.fileSize);
      this.setInYappSend(false);
      this.pendingSendBlocks = [];
      this.confirmedSent = this.yappSend.fileSize;
      this.yappSend = null;

      this.logToRenderer("info", `YAPP file send complete: ${name}`);
      this.sendToRenderer("yapp:send-complete");
    } catch (err) {
      console.error("finishSend error:", err);
    }
  }

  abortSend(reason) {
    clearTimeout(this.yappSend.ackTimeout);
    this.setInYappSend(false);
    this.yappSend = null;

    this.logToRenderer("error", `YAPP send aborted: ${reason}`);
    this.sendToRenderer("yapp:send-error", { message: reason });
  }

  setInYappSend(val) {
    console.log("setInYappSend", val);
    if (this.inYappSend !== val) {
      this.inYappSend = val;
    }
  }

  // Progress updates
  updateRecvProgress(received, total) {
    const percent = Math.floor((received / total) * 100);

    setImmediate(() => {
      this.sendToRenderer("yapp:recv-progress", { received, total, percent });
    });
  }

  // Send both queued (bytes placed into modem buffer) and confirmed (bytes ACKed by remote)
  sendProgressToRenderer(queued, confirmed, total) {
    const pctQueued = total > 0 ? Math.floor((queued / total) * 100) : 0;
    const pctConfirmed = total > 0 ? Math.floor((confirmed / total) * 100) : 0;
    this.sendToRenderer("yapp:send-progress", {
      queued,
      confirmed,
      total,
      percentQueued: pctQueued,
      percentConfirmed: pctConfirmed
    });
  }

  // Utility methods
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

  // Handle incoming data for YAPP
  handleData(data) {
    // YAPP SEND: Handle ACKs
    if (this.inYappSend && this.yappSend) {
      const bytes = [...data];
      const code = bytes[1];
      const text = data.toString("utf8");

      if (
        text.includes("Unexpected message during YAPP Transfer") ||
        text.includes("Transfer cancelled") ||
        text.includes("Invalid Command")
      ) {
        console.log("YAPP: remote cancelled transfer via BPQ message");
        clearTimeout(this.yappSend.ackTimeout);
        this.yappSend.abortSend("Remote cancelled YAPP transfer");
        return;
      }

      if (bytes[0] === 0x15 || bytes[0] === 0x18) { // NAK - treat as fatal error
        const message = text.slice(2).split('\r')[0]; // remove "NAK " prefix and any trailing text
        console.log("YAPP: received NAK from VARA:", message);
        this.yappSend.abortSend(message || "Received NAK from VARA");
        this.inYappSend = false;
        return;
      }

      // Only treat pure ACK frames as control
      if (bytes[0] !== 0x06) {
        return;
      }

      console.log("YAPP ACK:", this.yappSend.phase, "ACK =", code);

      // If we're streaming data, process data ACKs.
      if (code === 0x03 && this.yappSend.phase === "sendingData") {
        this.yappSend.startAckTimer();
        if (this.pendingSendBlocks && this.pendingSendBlocks.length > 0) {
          const sz = this.pendingSendBlocks.shift();
          this.confirmedSent = (this.confirmedSent || 0) + sz;
          if (this.confirmedSent > this.yappSend.fileBytes.length) this.confirmedSent = this.yappSend.fileBytes.length;
          const pct = Math.floor((this.confirmedSent / this.yappSend.fileBytes.length) * 100);
          console.log(`YAPP SEND: AF received - confirmed ${sz} bytes, confirmedSent=${this.confirmedSent}/${this.yappSend.fileBytes.length} (${pct}%) pending=${this.pendingSendBlocks.length}`);
          this.sendProgressToRenderer(this.yappSend.offset, this.confirmedSent, this.yappSend.fileBytes.length);
          return;
        } else {
          console.log("YAPP SEND: AF received but no pending blocks to confirm");
          return;
        }
      }

      // 06 03 — BPQ has full file / ready for EOT
      if (code === 0x03 && this.yappSend.phase === "waitingAckEof") {
        clearTimeout(this.yappSend.ackTimeout);
        this.varaConnection.sendRawBytes(Buffer.from([0x04, 0x01]));
        this.yappSend.phase = "waitingAckEot";
        this.yappSend.startAckTimer();
        return;
      }

      // 06 01 — ENQ accepted
      if (code === 0x01 && this.yappSend.phase === "waitingAckEnq") {
        clearTimeout(this.yappSend.ackTimeout);

        const header = buildYappHeader(this.yappSend.fileName, this.yappSend.fileSize);
        this.varaConnection.sendRawBytes(header);

        this.yappSend.phase = "waitingAckHeader";
        this.yappSend.startAckTimer();
        return;
      }

      // 06 02 — header accepted, start streaming data
      if (code === 0x02 && this.yappSend.phase === "waitingAckHeader") {
        clearTimeout(this.yappSend.ackTimeout);

        this.yappSend.phase = "sendingData";
        this.yappSend.sendNextBlock();
        return;
      }

      // 06 04 — EOT ACK, done
      if (code === 0x04 && this.yappSend.phase === "waitingAckEot") {
        clearTimeout(this.yappSend.ackTimeout);
        this.yappSend.finishSend();
        return;
      }

      return;
    }

    // YAPP RECEIVE
    if (this.inYapp) {
      if (!this.yappReceiver || typeof this.yappReceiver.feed !== 'function') {
        console.error("YAPP mode active but yappReceiver is not properly initialized:", this.yappReceiver);
        return;
      }
      this.yappReceiver.feed(data);
      if (this.yappReceiver.state === 'IDLE') {
        this.inYapp = false;
      }
      return;
    }

    // FILE LIST MODE
    if (this.inFileList) {
      this.handleFileListText(data.toString());
      return;
    }
  }
}

// YAPP Constants
const YAPP_BLOCK_SIZE = 255; // or 256 with len=0

// YAPP Header and Data Block builders
function buildYappHeader(filename, fileSize) {
  const sizeStr = fileSize.toString();
  const nameLen = filename.length;

  // LEN = filename + NUL + sizeStr + NUL
  const len = nameLen + 1 + sizeStr.length + 1;

  const header = Buffer.alloc(1 + 1 + len);
  let offset = 0;

  header[offset++] = 0x01;     // SOH
  header[offset++] = len;      // LENGTH BYTE
  header.write(filename, offset);
  offset += nameLen;
  header[offset++] = 0x00;     // NUL
  header.write(sizeStr, offset);
  offset += sizeStr.length;
  header[offset++] = 0x00;     // NUL

  return header;
}

function buildYappDataBlock(chunk, isFinal) {
  const len = chunk.length;

  if (isFinal) {
    // Final block: 02 LEN DATA 03 01
    const block = Buffer.alloc(2 + len + 2);
    let o = 0;
    block[o++] = 0x02;
    block[o++] = len;
    chunk.copy(block, o);
    o += len;
    block[o++] = 0x03;
    block[o++] = 0x01;
    return block;
  }

  // Intermediate block: 02 LEN DATA
  const block = Buffer.alloc(2 + len);
  let o = 0;
  block[o++] = 0x02;
  block[o++] = len;
  chunk.copy(block, o);
  return block;
}

// YAPP Receiver Class
class YappReceiver extends EventEmitter {
  constructor(sendFn, saveDirectory, settingsManager) {
    super();
    this.send = sendFn;
    this.dir = saveDirectory;
    this.settingsManager = settingsManager;
    this.state = "WAIT_SI";
    this.buffer = [];
    this.file = null;
    this.filename = "";
    this.filesize = 0;
    this.received = 0;
  }

  feed(bytes) {
    // Push the entire chunk at once
    this.buffer.push(...bytes);
    console.log("BYTES RECEIVED:", bytes.length, "Buffer length now:", this.buffer.length);
    // Process as much as possible from this chunk
    while (true) {
      const before = this.buffer.length;
      this.process();
      const after = this.buffer.length;
      console.log(`YAPP Receiver: processed data, buffer length before=${before}, after=${after}`);
      // If no bytes were consumed, stop
      if (after === before) break;
    }
  }

  process() {
    if (this.buffer.length === 0) return;

    switch (this.state) {
      case "WAIT_SI":
        if (this.buffer[0] === 0x05) { // ENQ
          this.buffer.shift();
          this.sendRR();
          this.state = "WAIT_HEADER";
        }
        else if (this.buffer[0] === 0x01) { // SOH without ENQ
          console.log("YAPP: SOH received without ENQ — starting new header");
          this.state = "WAIT_HEADER";
        }
        break;

      case "WAIT_HEADER":
        if (this.buffer[0] === 0x01) { // SOH
          const headerComplete = this.parseHeader();
          if (headerComplete) {
            this.state = "RECEIVE_DATA";
          }
        }
        break;

      case "RECEIVE_DATA":
        if (this.buffer[0] === 0x02) { // STX
          this.parseDataPacket();
        } else if (this.buffer[0] === 0x03) { // ETX
          this.buffer.shift();
          this.finishFile();
          this.state = "DONE";
        }
        break;

      case "DONE":
        if (this.buffer.length === 0) break;

        const b = this.buffer[0];

        if (b === 0x04) {          // EOT
          console.log("DONE: EOT received");
          this.buffer.shift();   // consume EOT
          this.sendAT();         // tell BPQ we're done with YAPP

          console.log("YAPP session complete - returning to normal mode");

          // Notify renderer (this closes the modal and triggers caller cleanup)
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send("yapp:receive-complete", this.fullPath);
          }

          // Open viewer window if image
          if (this.fullPath) {
            const ext = path.extname(this.fullPath).toLowerCase();
            if ([".png", ".gif", ".jpg", ".jpeg"].includes(ext)) {
              const win = new BrowserWindow({
                width: 700,
                height: 650,
                title: this.filename || "YAPP Image",
              });
              win.setMenu(null);
              win.loadURL(`file://${this.fullPath}`);
            }
          }

          // Return to idle state
          this.state = "IDLE";
        }
        else if (b === 0x01) {     // SI
          console.log("DONE: SI received, ignoring (staying in DONE until EOT)");
          this.buffer.shift();   // just discard, stay in DONE
        }
        else if (b === 0x06) {     // VARA echo ACK
          console.log("DONE: VARA echo ACK, discarding");
          this.buffer.shift();
        }
        else {
          console.log("DONE: unexpected byte", b, "discarding");
          this.buffer.shift();
        }
        break;

      case "IDLE":
        // Ignore stray SI bytes — they are NOT a new YAPP session
        if (this.buffer[0] === 0x01) {
          console.log("IDLE: stray SI ignored");
          this.buffer.shift();
          break;
        }

        // Only ENQ (0x05) starts a new YAPP session
        if (this.buffer[0] === 0x05) {
          console.log("IDLE: ENQ received — starting new YAPP session");
          this.resetForNextFile();
          this.buffer.shift();
          this.state = "WAIT_HEADER";
        }
        break;
    }
  }

  resetForNextFile() {
    this.buffer = [];
    this.file = null;
    this.filename = "";
    this.filesize = 0;
    this.received = 0;
  }

  parseHeader() {
    // Find the LAST SOH (0x01) in the buffer
    const sohIndex = this.buffer.lastIndexOf(0x01);
    if (sohIndex === -1) {
      console.log("HEADER: no SOH yet");
      return false;
    }

    // Need at least SOH + LEN
    if (this.buffer.length < sohIndex + 2) {
      console.log("HEADER: waiting for LEN after SOH...");
      return false;
    }

    const len = this.buffer[sohIndex + 1];

    // Need full header: SOH + LEN + len bytes
    if (this.buffer.length < sohIndex + 2 + len) {
      console.log("HEADER: waiting for full header bytes...");
      return false;
    }

    // Drop everything up to this SOH
    this.buffer.splice(0, sohIndex); // discard leading bytes (including old 0x01 from ENQ)
    this.buffer.shift();             // SOH
    this.buffer.shift();             // LEN

    const headerBytes = this.buffer.splice(0, len);

    const headerString = new TextDecoder().decode(new Uint8Array(headerBytes));
    console.log("HEADER RECEIVED:", JSON.stringify(headerString));

    const parts = headerString.split("\0");
    this.filename = parts[0] || "";
    this.filesize = parseInt(parts[1] || "0", 10);

    console.log("Parsed filename:", this.filename);
    console.log("Parsed filesize:", this.filesize);

    if (!this.filename) {
      console.log("HEADER: empty filename, NOT opening file");
      return false;
    }

    const settings = this.settingsManager ? this.settingsManager.getSettings() : {};
    const defaultDir = path.join(require('electron').app.getPath("documents"), "YAPP");
    const receiveDir = this.dir || settings.yappReceiveDir || defaultDir;

    fs.mkdirSync(receiveDir, { recursive: true });
    const filePath = path.join(receiveDir, this.filename);
    this.filePath = filePath;

    console.log("Opening file:", filePath);
    this.file = fs.createWriteStream(filePath);
    this.fullPath = filePath;

    this.sendRF();
    return true;
  }

  parseDataPacket() {
    if (this.buffer.length < 2) {
      return;
    }

    const stx = this.buffer[0];
    let len = this.buffer[1];

    if (stx !== 0x02) {
      return;
    }

    if (len === 0) len = 256;

    if (this.buffer.length < 2 + len) {
      return;
    }

    this.buffer.shift();
    this.buffer.shift();

    const data = this.buffer.splice(0, len);

    this.file.write(Buffer.from(data));
    this.received += data.length;

    // Update progress
    const percent = Math.floor((this.received / this.filesize) * 100);
    setImmediate(() => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send("yapp:recv-progress", { received: this.received, total: this.filesize, percent });
      }
    });

    this.sendAF();
  }

  finishFile() {
    this.file.close();
    this.sendAF();
  }

  sendRR() { console.log("SENDING RR (ACK 01)"); this.send(Buffer.from([0x06, 0x01])); }
  sendRF() { console.log("SENDING RF (NAK 02)"); this.send(Buffer.from([0x06, 0x02])); }
  sendAF() { console.log("SENDING AF (ACK 03)"); this.send(Buffer.from([0x06, 0x03])); }
  sendAT() { console.log("SENDING AT (EOT 04)"); this.send(Buffer.from([0x06, 0x04])); }
}

module.exports = YappTransfer;