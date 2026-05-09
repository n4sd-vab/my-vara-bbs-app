const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class SettingsManager {
  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'settings.json');
    this.settings = this.loadSettings();
    this.appSettings = this.loadSettings(); // initial load
  }

  loadSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
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

  saveSettings(settings) {
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
    // Reload settings in main process
    this.settings = this.loadSettings();
    // Notify renderer of updated settings
    const { mainWindow } = require('../main'); // Circular dependency, but okay for now
    if (mainWindow) {
      mainWindow.webContents.send("settings:updated", settings);
    }
  }

  getSettings() {
    return this.loadSettings();
  }

  setSettings(data) {
    const settings = this.loadSettings();
    const newSettings = { ...settings, ...data };
    this.saveSettings(newSettings);
  }

  getSetting(key) {
    const settings = this.loadSettings(); // load fresh copy
    return settings[key];
  }

  saveSetting(key, value) {
    const settings = this.loadSettings();
    settings[key] = value;
    this.saveSettings(settings);
  }

  updateAppSettings(newSettings) {
    this.appSettings = newSettings;
  }

  getAppSettings() {
    return this.appSettings;
  }
}

module.exports = SettingsManager;