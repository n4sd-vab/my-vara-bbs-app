const { app, BrowserWindow, Menu, MenuItem } = require('electron');
const path = require('path');

// Import our modules
const DatabaseManager = require('./modules/database');
const SettingsManager = require('./modules/settings');
const VaraConnection = require('./modules/vara-connection');
const YappTransfer = require('./modules/yapp-transfer');
const BbsProtocol = require('./modules/bbs-protocol');
const IpcHandlers = require('./modules/ipc-handlers');

// Global variables
let mainWindow;
let prefWindow;

// Initialize managers
const database = new DatabaseManager();
const settings = new SettingsManager();
const varaConnection = new VaraConnection(settings, (data) => bbsProtocol.processData(data));
const yappTransfer = new YappTransfer(varaConnection, settings);
const bbsProtocol = new BbsProtocol(varaConnection, database, yappTransfer);
const ipcHandlers = new IpcHandlers(database, settings, varaConnection, bbsProtocol, yappTransfer);

// Menu template
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
          mainWindow.webContents.send("address-book:open-add");
        }
      },
      {
        label: "Address Book View",
        click: () => {
          mainWindow.webContents.send("address-book:open-view");
        }
      },
      {
        label: "WhitePages Import",
        click: () => {
          mainWindow.webContents.send("whitepages:open-modal");
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
        checked: settings.getSetting('showVaraConsole'),
        click: (menuItem) => {
          settings.saveSetting('showVaraConsole', menuItem.checked);
          mainWindow.webContents.send("ui:toggle-vara-console", menuItem.checked);
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
          mainWindow.webContents.send("yapp:open-receive");
        }
      },
      {
        label: "Send File",
        click: () => {
          mainWindow.webContents.send("yapp:open-send");
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
          mainWindow.webContents.send("ui:open-bbs-help");
        }
      },
      {
        label: "About",
        click: () => {
          mainWindow.webContents.send("ui:open-about");
        }
      }
    ]
  }
];

const menu = Menu.buildFromTemplate(menuTemplate);
Menu.setApplicationMenu(menu);

// Window creation functions
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
}

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
      preload: path.join(__dirname, '..', 'preload.js')
    }
  });

  prefWindow.loadFile('preferences.html');

  prefWindow.on('closed', () => {
    prefWindow = null;
  });
}

// App event handlers
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

console.log("DB Path:", path.join(app.getPath('userData'), 'bbs.db'));