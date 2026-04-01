const { app, BrowserWindow, ipcMain, Menu, MenuItem, dialog } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const net = require('net');
const fs = require('fs');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

const dbPath = path.join(app.getPath('userData'), 'bbs.db');

const db = new Database(dbPath);
initializeDatabase();


function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {
      myCall: "",
      bbsCall: "",
      nodeCall: "",
      digi1: "",
      digi2: "",
      varaIP: "",
      varaCmdPort: "",
      varaDataPort: "",
      showVaraConsole: true,
      yappReceiveDir: ""
    };
  }
}

let prefWindow = null;

function createPreferencesWindow() {
  if (prefWindow) {
    prefWindow.focus();
    return;
  }

  prefWindow = new BrowserWindow({
    width: 400,
    height: 500,
    title: "Preferences",
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  prefWindow.loadFile('preferences.html');

  prefWindow.on('closed', () => {
    prefWindow = null;
  });
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  //reload settings in main process
  settings = loadSettings();

  // Notify renderer of updated settings
  if (mainWindow) {
    mainWindow.webContents.send("settings-updated", settings);
  }
  //TODO: consider also sending specific events for important individual settings (e.g., VARA console toggle) instead of a generic "settings-updated"

}

let settings = loadSettings();

let mainWindow;
let cmdSocket = null;
let dataSocket = null;
let dataBuffer = "";
let inYapp = false;   // global YAPP mode flag
let yappReceiver = null;  // will hold YappReceiver instance during YAPP transfers
let inFileList = false;  // flag to indicate we're currently receiving a file list from the BBS
let fileList = [];

let inYappSend = false;
let yappSend = null; // holds the sender state machine instance



const menuTemplate = [
  {
    label: "File",
    submenu: [
      { role: "quit" }
    ]
  },
  {
    label: "Settings",
    submenu: [
      {
        label: "Preferences",
        click: () => {
          createPreferencesWindow();
        }
      },
      {
        label: "Address Book Add",
        click: () => {
          mainWindow.webContents.send("open-address-book-add");
        }
      },
      {
        label: "Address Book View",
        click: () => {
          mainWindow.webContents.send("open-address-book-view");
        }
      }
    ]

  },
  {
    label: "View",
    submenu: [
      {
        label: "Show VARA Console",
        type: "checkbox",
        checked: settings.showVaraConsole,
        click: (menuItem) => {
          settings.showVaraConsole = menuItem.checked;
          saveSettings(settings);
          mainWindow.webContents.send("toggle-vara-console", menuItem.checked);
        }

      }
    ]
  },
  {
    label: "YAPP",
    submenu: [
      {
        label: "Receive File",
        click: () => {
          mainWindow.webContents.send("open-yapp-receive");
        }
      },
      {
        label: "Send File",
        click: () => {
          mainWindow.webContents.send("open-yapp-send");
        }
      }
    ]

  },
  {
    label: "Help",
    submenu: [
      {
        label: "BBS Command Reference",
        click: () => {
          mainWindow.webContents.send("open-bbs-help");
        }
      },
      {
        label: "About",
        click: () => {
          mainWindow.webContents.send("open-about");
        }
      }
    ]
  }
];


const menu = Menu.buildFromTemplate(menuTemplate);
Menu.setApplicationMenu(menu);


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
}

function initializeDatabase() {
  db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY,
            msgNum INTEGER,
            type TEXT,
            date TEXT,
            sender TEXT,
            recipient TEXT,
            at TEXT,
            subject TEXT,
            body TEXT,
            read INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS address_book (
            id INTEGER PRIMARY KEY,
            callsign TEXT UNIQUE,
            name TEXT,
            location TEXT,
            homebbs TEXT,
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY,
            timestamp TEXT,
            direction TEXT,
            content TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_messages_msgNum ON messages(msgNum);

        CREATE INDEX IF NOT EXISTS idx_address_callsign ON address_book(callsign);

    `);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Helper: send log lines to renderer
 */
function logToRenderer(type, msg) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('log', { type, msg });
  }
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function formatBbsLine(line) {
  // Do NOT trim the whole line — it removes leading spacing used for alignment
  const parts = line.split(/\s+/);   // still splits on whitespace, but we will re-pad

  const msgNum = parts[0] || "";
  const date = (parts[1] || "");
  const status = (parts[2] || "").padStart(8);
  const size = (parts[3] || "").padStart(8);
  const to = (parts[4] || "").padStart(8);
  const at = (parts[5] || "").padStart(8);
  const from = (parts[6] || "").padStart(8);
  const subject = parts.slice(7).join(" "); // subject can be long

  return `
        <div class="msgRow" data-msg="${msgNum}">
            <span class="msgRow">${msgNum}</span>
            <span class="msgRow">${date}</span>
            <span class="msgRow">${status}</span>
            <span class="msgRow">${size}</span>
            <span class="msgRow">${to}</span>
            <span class="msgRow">${at}</span>
            <span class="msgRow">${from}</span>
            <span class="msgRow">${subject}</span>
        </div>
    `;
}

function sendRawBytes(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  try {
    dataSocket.write(buffer);
  } catch (err) {
    console.error("sendRawBytes error:", err);
  }
}

function handleFileListText(text) {
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
      fileList.push({ name, size });
      continue;
    }

    // End of list
    if (line.trim() === "" || line.includes("BPQ") || line.includes(">")) {
      console.log("YAPP FILELIST: END OF LIST DETECTED");
      console.log("YAPP FILELIST: Final list:", fileList);

      inFileList = false;
      mainWindow.webContents.send("yapp-file-list", fileList);

      fileList = [];
      return;
    }
  }
}

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

const YAPP_BLOCK_SIZE = 255; // or 256 with len=0

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


function computeChecksum(buffer) {
  let checksum = 0;
  for (const byte of buffer) {
    checksum = (checksum + byte) & 0xff;
  }
  return checksum;
}

function updateRecvProgress(received, total) {
  const percent = Math.floor((received / total) * 100);

  setImmediate(() => {
    if (mainWindow && mainWindow.webContents) {
      console.log(`YAPP Progress: received ${received} of ${total} bytes (${percent}%)`);

      mainWindow.webContents.send("yapp-recv-progress", {received, total, percent});
    }
  });
}

function sendProgressToRenderer(sent, total) {
  if (!mainWindow) return;

  mainWindow.webContents.send("yapp-send-progress", {
    sent,
    total,
    percent: Math.floor((sent / total) * 100)
  });
}
/**
 * Connect to VARA FM command and data ports
 */
ipcMain.handle('vara-connect', async () => {
  return new Promise((resolve, reject) => {
    let pending = 2;
    let hadError = false;

    const done = (err) => {
      if (err && !hadError) {
        hadError = true;
        reject(err);
      } else {
        pending--;
        if (pending === 0 && !hadError) resolve(true);
      }
    };

    // Command socket
    cmdSocket = net.createConnection({ host: settings.varaIP, port: settings.varaCmdPort }, () => {
      logToRenderer('info', `Connected to VARA command port ${settings.varaCmdPort}`);
      done();
    });

    cmdSocket.on('data', (data) => {
      logToRenderer('cmd', data.toString());
      
      //Check for BUFFER messages during YAPP send
      if (yappSend && yappSend.phase === "sendingData") {
        const line = data.toString("utf8");

        if (line.startsWith("BUFFER")) {
          const parts = line.split(" ");
          const remaining = parseInt(parts[1], 10);
          const total = yappSend.fileBytes.length;

          const sent = total - remaining;
          const percent = Math.floor((sent / total) * 100);

          mainWindow.webContents.send("yapp-send-progress", {
            sent,
            total,
            percent
          });
        }
      }
    });

    cmdSocket.on('error', (err) => {
      logToRenderer('error', `Command socket error: ${err.message}`);
      done(err);
    });

    cmdSocket.on('close', () => {
      logToRenderer('info', 'Command socket closed');
    });

    // Data socket
    dataSocket = net.createConnection({ host: settings.varaIP, port: settings.varaDataPort }, () => {
      logToRenderer('info', `Connected to VARA data port ${settings.varaDataPort}`);
      done();
    });

    // ---------------- VARA DATA SOCKET ----------------
    dataSocket.on('data', (data) => {
      if (inYappSend && !yappSend) {
        // We are in YAPP mode but state machine not initialized yet
        // Ignore all text until state machine starts
        return;
      }

      //console.log("RAW DATA:", data);
      //console.log("HEX:", data.toString('hex'));
      //console.log("ascii:", data.toString('ascii'));
      //console.log("BYTES:", [...data]);
      //console.log("DATA SOCKET RECEIVED:", data);
      console.log("inYappSend =", inYappSend);

      try {
        if (inYappSend && yappSend) {
          const bytes = [...data];
          const code = bytes[1];
          const text = data.toString("utf8");

          if (
            text.includes("Unexpected message during YAPP Transfer") ||
            text.includes("Transfer cancelled") ||
            text.includes("Invalid Command")
            //text.includes("already exists")
          ) {
            console.log("YAPP: remote cancelled transfer via BPQ message");
            clearTimeout(yappSend.ackTimeout);
            yappSend.abortSend("Remote cancelled YAPP transfer");
            return;
          }

          if (bytes[0] === 0x15 || bytes[0] === 0x18) { // NAK - treat as fatal error
            const message = text.slice(2).split('\r')[0]; // remove "NAK " prefix and any trailing text
            console.log("YAPP: received NAK from VARA:", message);
            yappSend.abortSend(message || "Received NAK from VARA");
            inYappSend=false;
            return;
          }

          // Only treat pure ACK frames as control
          if (bytes[0] !== 0x06) {
            return;
          }

          console.log("YAPP ACK:", yappSend.phase, "ACK =", code);

          // 06 01 — ENQ accepted
          if (code === 0x01 && yappSend.phase === "waitingAckEnq") {
            clearTimeout(yappSend.ackTimeout);

            const header = buildYappHeader(yappSend.fileName, yappSend.fileSize);
            sendRawBytes(header);

            yappSend.phase = "waitingAckHeader";
            yappSend.startAckTimer();
            return;
          }

          // 06 02 — header accepted, start streaming data
          if (code === 0x02 && yappSend.phase === "waitingAckHeader") {
            clearTimeout(yappSend.ackTimeout);

            yappSend.phase = "sendingData";
            yappSend.sendNextBlock();
            return;
          }

          // 06 03 — EOF ACK (BPQ has full file)
          if (code === 0x03) {
            clearTimeout(yappSend.ackTimeout);

            // Send EOT (single byte)
            sendRawBytes(Buffer.from([0x04, 0x01]));

            yappSend.phase = "waitingAckEot";
            yappSend.startAckTimer();
            return;
          }

          // 06 04 — EOT ACK, done
          if (code === 0x04 && yappSend.phase === "waitingAckEot") {
            clearTimeout(yappSend.ackTimeout);
            yappSend.finishSend();
            return;
          }

          return;
        }
        // -------------------------
        // 2. YAPP RECEIVE MODE
        // -------------------------
        if (inYapp) {
          if (!yappReceiver || typeof yappReceiver.feed !== 'function') {
            console.error("YAPP mode active but yappReceiver is not properly initialized:", yappReceiver);
            return;
          }
          yappReceiver.feed(data);
          return;   // do NOT fall through to text logic
        }

        // -------------------------
        // 3. FILE LIST MODE
        // -------------------------
        if (inFileList) {
          handleFileListText(data.toString());
          return;   // do NOT fall through to normal text logic
        }

        // -------------------------
        // 4. NORMAL BBS TEXT MODE
        // -------------------------
        if (inYappSend) return;   // suppress BBS text while sending YAPP

        dataBuffer += data.toString();   // accumulate

        const parts = dataBuffer.split('\r');

        // All complete lines except the last
        for (let i = 0; i < parts.length - 1; i++) {
          const line = parts[i];
          logToRenderer('data', line);
        }

        // Save the incomplete tail (if any)
        dataBuffer = parts[parts.length - 1];

      } catch (err) {
        console.error("Error processing data socket input:", err);
      }
    });

    dataSocket.on('error', (err) => {
      logToRenderer('error', `Data socket error: ${err.message}`);
      done(err);
    });

    dataSocket.on('close', () => {
      logToRenderer('info', 'Data socket closed');
    });
  });
});

//----------------------YAPP SEND LOGIC----------------------//
function setInYappSend(val) {
  console.log("setInYappSend", val);
  if (inYappSend !== val) {
    inYappSend = val;
  }
}

function beginYappSendStateMachine(fileName, fileSize, fileBytes) {
  console.log("YAPP SEND MODE ACTIVATED");

  const enq = Buffer.from([0x05, 0x01]);
  sendRawBytes(enq);

  yappSend = {
    fileName,
    fileSize,
    fileBytes,
    offset: 0,
    phase: "waitingAckEnq",
    ackTimeout: null,
    startAckTimer,
    finishSend,
    abortSend,
    sendNextBlock
  };

  yappSend.startAckTimer();

  function startAckTimer() {
    clearTimeout(yappSend.ackTimeout);
    yappSend.ackTimeout = setTimeout(() => {
      yappSend.abortSend("ACK timeout");
    }, 20000);
  }

  let lastProgressUpdate = 0;

  function sendNextBlock() {
    if (yappSend.offset >= yappSend.fileBytes.length) {
      yappSend.phase = "waitingAckEof";
      yappSend.startAckTimer();
      return;
    }

    const remaining = yappSend.fileBytes.length - yappSend.offset;
    const chunk = yappSend.fileBytes.slice(
      yappSend.offset,
      yappSend.offset + YAPP_BLOCK_SIZE
    );

    const isFinal = chunk.length === remaining;

    const block = buildYappDataBlock(chunk, isFinal);
    sendRawBytes(block);

    yappSend.offset += chunk.length;

    const now = Date.now();
    if (now - lastProgressUpdate > 100) {
      sendProgressToRenderer(yappSend.offset, yappSend.fileBytes.length);
      lastProgressUpdate = now;
    }

    if (!isFinal) {
      setImmediate(sendNextBlock);   // ← THIS IS THE FIX
    }
  }

  function finishSend() {
    try {
      clearTimeout(yappSend.ackTimeout);

      const name = yappSend.fileName;
      setInYappSend(false);
      yappSend = null;

      logToRenderer("info", `YAPP file send complete: ${name}`);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("yapp-send-complete");
      }
    } catch (err) {
      console.error("finishSend error:", err);
    }
  }

  function abortSend(reason) {
    clearTimeout(yappSend.ackTimeout);
    setInYappSend(false);
    yappSend = null;

    logToRenderer("error", `YAPP send aborted: ${reason}`);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("yapp-send-error", { message: reason });
    }
  }
}
//----------------------YAPP RECEIVE LOGIC----------------------//

// Is this needed
const YappState = {
  IDLE: "IDLE",
  HEADER: "HEADER",
  DATA: "DATA",
  EOF: "EOF",
  DONE: "DONE"
};

class YappReceiver {
  constructor(sendFn, saveDirectory) {
    this.send = sendFn;
    this.dir = saveDirectory;
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
    //console.log("PROCESS STATE:", this.state, "BYTE:", this.buffer[0].toString(16));

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
          inYapp = false;
          mainWindow.webContents.send("yapp-receive-complete");
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
        if (this.buffer[0] === 0x01) { // SI
          console.log("NEW YAPP SESSION STARTING");
          this.resetForNextFile();
          this.buffer.shift();
          this.state = "WAIT_SI";
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

    const fs = require("fs");
    const path = require("path");
    //const filePath = path.join(this.dir, this.filename);

    const settings = loadSettings();  // load fresh copy
    const receiveDir = settings.yappReceiveDir || path.join(app.getPath("documents"), "YAPP");

    const filePath = path.join(receiveDir, this.filename);

    console.log("Opening file:", filePath);
    this.file = fs.createWriteStream(filePath);

    this.sendRF();
    return true;
  }

  parseDataPacket() {
    if (this.buffer.length < 2) {
      //console.log("DATA: waiting for STX + LEN...");
      return;
    }

    const stx = this.buffer[0];
    let len = this.buffer[1];

    if (stx !== 0x02) {
      //console.log("DATA: unexpected STX:", stx);
      return;
    }

    if (len === 0) len = 256;

    if (this.buffer.length < 2 + len) {
      //console.log("DATA: waiting for full data block...", this.buffer.length, "of", 2 + len);
      return;
    }

    this.buffer.shift();
    this.buffer.shift();

    const data = this.buffer.splice(0, len);

    this.file.write(Buffer.from(data));
    this.received += data.length;

    //console.log(`DATA: wrote ${data.length} bytes, total ${this.received}/${this.filesize}`);

    updateRecvProgress(this.received, this.filesize);

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
//---------------------------------------------------------------------------//
// END OF YAPP Receiver IMPLEMENTATION
//---------------------------------------------------------------------------//


/**
 * Send a command line to VARA command port
 */
ipcMain.handle('vara-send-command', async (_event, line) => {
  if (!cmdSocket) {
    throw new Error('Not connected to command port');
  }
  cmdSocket.write(line.endsWith('\r\n') ? line : line + '\r\n');
});

/**
 * Send data (e.g., email text) to VARA data port
 */
ipcMain.handle('vara-send-data', async (_event, text) => {
  if (!dataSocket) {
    throw new Error('Not connected to data port');
  }
  dataSocket.write(text);
});

ipcMain.handle('vara-disconnect', async () => {
  if (cmdSocket) cmdSocket.end();
  if (dataSocket) dataSocket.end();
});

ipcMain.handle("settings-get", async () => {
  return loadSettings();
});

ipcMain.handle("settings-set", async (_event, data) => {
  const settings = loadSettings();
  const newSettings = { ...settings, ...data };
  fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
});

ipcMain.handle("get-setting", async (_event, key) => {
  const settings = loadSettings();   // load fresh copy
  return settings[key];
});

ipcMain.handle("save-setting", async (_event, { key, value }) => {
  const settings = loadSettings();
  settings[key] = value;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on("bbs-send", (event, cmd) => {
  console.log("MAIN: sending to DATA port:", cmd);
  console.log("Sending BBS command:", cmd, "via DATA socket");
  if (dataSocket) dataSocket.write(cmd + "\r");
});

ipcMain.on("show-message-context-menu", (event, data) => {
  const menu = new Menu();

  menu.append(new MenuItem({
    label: "Reply to Sender",
    click: () => {
      event.sender.send("reply-to-sender", data);
    }
  }));

  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

ipcMain.on('start-yapp-receive', async (event, info) => {
  const { filename, directory } = info;

  try {
    // 1. Tell BPQ to start sending the file
    dataSocket.write(`YAPP ${filename}\r`);

    // 2. Create the YAPP receiver
    yappReceiver = new YappReceiver(sendRawBytes, directory);

    console.log("Receiver created. sendRawBytes type:", typeof sendRawBytes);
    console.log("Receiver.send type:", typeof yappReceiver.send);

    inYapp = true;

    console.log("YAPP receive started for:", filename);

  } catch (err) {
    console.error("Error starting YAPP receive:", err);
    inYapp = false;
  }
});

ipcMain.on("yapp-request-file-list", () => {

  console.log("YAPP: Requesting FILES list...");
  if (dataSocket) {
    inFileList = true;
    fileList = [];
    console.log("YAPP: inFileList = true, sending FILES");
    dataSocket.write("FILES\r");
  } else {
    console.log("YAPP: dataSocket is NULL");
  }
});

// Address book IPC handlers
ipcMain.handle('address-book-save', (_event, entry) => {
  const stmt = db.prepare(`INSERT OR REPLACE INTO address_book
        (callsign, name, location, homebbs, notes)
        VALUES (@callsign, @name, @location, @homebbs, @notes)`);
  stmt.run(entry);
});

ipcMain.handle('address-book-get', () => {
  const stmt = db.prepare(`SELECT * FROM address_book ORDER BY callsign`);
  return stmt.all();
});

ipcMain.handle("addressbook-delete", (event, id) => {
  db.prepare("DELETE FROM address_book WHERE id = ?").run(id);
});

ipcMain.handle("addressbook-get-one", (event, id) => {
  return db.prepare("SELECT * FROM address_book WHERE id = ?").get(id);
});

ipcMain.handle("addressbook-update", (event, entry) => {
  db.prepare(`
        UPDATE address_book
        SET callsign = ?, name = ?, location = ?, homebbs = ?, notes = ?
        WHERE id = ?
    `).run(entry.callsign, entry.name, entry.location, entry.homebbs, entry.notes, entry.id);
});

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

// Buffer utilities for YAPP send/receive
ipcMain.handle("buffer-alloc", (_e, size) => {
  return Buffer.alloc(size);
});

ipcMain.handle("buffer-from-array", (_e, arr) => {
  return Buffer.from(arr);
});

ipcMain.handle("buffer-concat", (_e, list) => {
  return Buffer.concat(list);
});

//----------------------YAPP SEND LOGIC----------------------//
// This is the main entry point for starting a YAPP send operation. 
// It receives the file info and bytes from the renderer, 
// then initiates the YAPP send state machine.
// ----------------------------------------------------------//

ipcMain.on("yapp-start-send", (event, info) => {
  //inYappSend = true;
  setInYappSend(true);
  yappSend = null;

  console.log("IPC: yapp-start-send received", { stack: new Error().stack });

  const { fileName, fileSize, fileBytes } = info;

  if (!dataSocket) {
    logToRenderer("error", "Cannot start YAPP send: data socket not connected.");
    return;
  }

  logToRenderer("info", `Starting YAPP send: ${fileName} (${fileSize} bytes)`);

  // Convert Uint8Array → Buffer
  const buffer = Buffer.from(fileBytes);

  // Start the state machine
  beginYappSendStateMachine(fileName, fileSize, buffer);
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

console.log("DB Path:", dbPath);

ipcMain.handle("addressbook-debug", () => {
  return db.prepare("SELECT * FROM address_book").all();
});
