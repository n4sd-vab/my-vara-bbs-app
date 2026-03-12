const { app, BrowserWindow, ipcMain, Menu, MenuItem, dialog } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const net = require('net');
const fs = require('fs');
const { type } = require('os');

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
}

let settings = loadSettings();

let mainWindow;
let cmdSocket = null;
let dataSocket = null;
let dataBuffer = "";
let inYapp = false;   // global YAPP mode flag
let yappReceiver = null;  // will hold YappReceiver instance during YAPP transfers

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




    dataSocket.on('data', (data) => {

      console.log("RAW DATA:", data);
      console.log("HEX:", data.toString('hex'));
      console.log("BYTES:", [...data]);

      // 1. YAPP MODE OVERRIDES EVERYTHING
      try {
        if (inYapp) {
          if (!yappReceiver || typeof yappReceiver.feed !== 'function') {
            console.error("YAPP mode active but yappReceiver is not properly initialized:", yappReceiver);
            return;
          }
          // Feed raw bytes directly to YAPP receiver
          yappReceiver.feed(data);
          return;   // IMPORTANT: do NOT fall through to text logic
        }

        // 2. NORMAL BBS TEXT MODE
        dataBuffer += data.toString();   // accumulate

        let parts = dataBuffer.split('\r');

        // All complete lines except the last
        for (let i = 0; i < parts.length - 1; i++) {
          const line = parts[i].trim();
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
    console.log("YAPP FEED:", bytes.toString('hex'), [...bytes]);
    for (let b of bytes) {
      this.buffer.push(b);
      this.process();
    }
  }

  process() {
    if (this.buffer.length === 0) return;
    console.log("PROCESS STATE:", this.state, "BYTE:", this.buffer[0].toString(16));

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
    // Need at least STX + LEN
    if (this.buffer.length < 2) {
      console.log("DATA: waiting for STX + LEN...");
      return;
    }

    const stx = this.buffer[0];
    let len = this.buffer[1];

    if (stx !== 0x02) {
      console.log("DATA: unexpected STX:", stx);
      return;
    }

    if (len === 0) len = 256;

    // Need full block: STX + LEN + len bytes
    if (this.buffer.length < 2 + len) {
      console.log("DATA: waiting for full data block...", this.buffer.length, "of", 2 + len);
      return;
    }

    // Now consume STX + LEN
    this.buffer.shift(); // STX
    this.buffer.shift(); // LEN

    const data = this.buffer.splice(0, len);

    this.file.write(Buffer.from(data));
    this.received += data.length;

    mainWindow.webContents.send("yapp-progress", {
      received: this.received,
      total: this.filesize
    });

    console.log(`DATA: wrote ${data.length} bytes, total ${this.received}/${this.filesize}`);

    // ACK this block
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

/*
function saveSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
*/

ipcMain.handle("save-setting", async (_event, { key, value }) => {
    const settings = loadSettings();
    settings[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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

//ipcMain.handle("get-setting", async (_event, key) => {
//    return settings.get(key);
//});


//ipcMain.handle("addressbook-get-all", () => {
//  return db.prepare("SELECT * FROM address_book ORDER BY callsign").all();
//});

console.log("DB Path:", dbPath);


ipcMain.handle("addressbook-debug", () => {
  return db.prepare("SELECT * FROM address_book").all();
});

