const { app, BrowserWindow, ipcMain, Menu, MenuItem } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

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
      varaIP: "192.168.1.12",
      varaCmdPort: 8300,
      varaDataPort: 8301,
      showVaraConsole: true
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
  }
];


const menu = Menu.buildFromTemplate(menuTemplate);
Menu.setApplicationMenu(menu);


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
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
  const parts = line.trim().split(/\s+/);
  const msgNum = parts[0];

  return `
        <div class="msgRow" data-msg="${msgNum}">
            <span class="msgNum">${msgNum}</span>
            ${parts.slice(1).join(" ")}
        </div>
    `;
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
      dataBuffer += data.toString();   // accumulate

      let parts = dataBuffer.split('\r');

      // All complete lines except the last
      for (let i = 0; i < parts.length - 1; i++) {
        const line = parts[i].trim();
        if (line.length > 0) {
          logToRenderer('data', line);
        }
      }

      // Save the incomplete tail (if any)
      dataBuffer = parts[parts.length - 1];
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

ipcMain.handle('settings-get', () => settings);

ipcMain.handle('settings-set', (_event, data) => {
  settings = { ...settings, ...data };
  saveSettings(settings);
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

