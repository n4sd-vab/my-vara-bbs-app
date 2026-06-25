const net = require('net');
const { BrowserWindow } = require('electron');

class VaraConnection {
  constructor(settingsManager, dataCallback = null) {
    this.settingsManager = settingsManager;
    this.dataCallback = dataCallback;
    this.cmdSocket = null;
    this.dataSocket = null;
    this.bbsLinkUp = false;
    this.bbsPromptReady = false;
    this.cmdBuffer = "";
    this.dataBuffer = "";
    this.lineWaiters = [];
    this._lastBufferSent = null;
    this._lastBufferSentTime = 0;
  }

  async connect() {
    if (this.isConnected()) {
      this.logToRenderer('info', 'Already connected to VARA');
      return true;
    }

    if (this.cmdSocket && this.cmdSocket.destroyed) this.cmdSocket = null;
    if (this.dataSocket && this.dataSocket.destroyed) this.dataSocket = null;
    if (this.cmdSocket || this.dataSocket) {
      this.disconnect();
    }

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

      const settings = this.settingsManager.getSettings();

      // Command socket
      this.cmdSocket = net.createConnection({ host: settings.varaIP, port: settings.varaCmdPort }, () => {
        this.logToRenderer('info', `Connected to VARA command port ${settings.varaCmdPort}`);
        done();
      });

      this.cmdSocket.on('data', (data) => {
        this.cmdBuffer += data.toString();

        const parts = this.cmdBuffer.split(/\r\n|\r|\n/);

        // Process all complete lines
        for (let i = 0; i < parts.length - 1; i++) {
          const trimmed = parts[i].trim();
          if (!trimmed) continue;

          // Avoid noisy logging for BUFFER lines; log other command lines
          if (!/^BUFFER\s+/i.test(trimmed)) {
            this.logToRenderer('cmd', trimmed);
          }

          if (/^CONNECTED\b/i.test(trimmed)) {
            this.bbsLinkUp = true;
            console.log("CMD: Link up");
          }

          if (/^DISCONNECTED\b/i.test(trimmed)) {
            this.bbsLinkUp = false;
            this.bbsPromptReady = false;
            console.log("CMD: Link down");
          }

          if (/^WRONG\b/i.test(trimmed)) {
            console.log("CMD: WRONG (modem error)");
            this.bbsLinkUp = false;  // temp fix for modem errors - treat as link down until we get a CONNECTED again
            this.bbsPromptReady = false;  // BBS won't be responsive after a modem error, so treat as prompt not ready until we get a CONNECTED again
          }

          // Detect BUFFER reports from VARA command port and forward to renderer (throttled)
          const bufMatch = trimmed.match(/^BUFFER\s+(\d+)/i);
          if (bufMatch) {
            const bufferVal = parseInt(bufMatch[1], 10);
            const now = Date.now();
            // Throttle updates to at most once per 200ms unless the value changes
            if (this._lastBufferSent !== bufferVal || (now - this._lastBufferSentTime) > 200) {
              this._lastBufferSent = bufferVal;
              this._lastBufferSentTime = now;
              try {
                const wins = BrowserWindow.getAllWindows();
                if (wins.length > 0) wins[0].webContents.send('vara:buffer', { buffer: bufferVal });
              } catch (err) {
                console.error('Failed to forward BUFFER to renderer:', err);
              }
            }
          }
        }

        // Save incomplete tail
        this.cmdBuffer = parts[parts.length - 1];
      });

      this.cmdSocket.on('error', (err) => {
        this.logToRenderer('error', `Command socket error: ${err.message}`);
        done(err);
      });

      this.cmdSocket.on('close', () => {
        this.logToRenderer('info', 'Command socket closed');
      });
      // End of command socket setup


      // -------------------------------------------------------------
      // Data socket
      // -------------------------------------------------------------
      this.dataSocket = net.createConnection({ host: settings.varaIP, port: settings.varaDataPort }, () => {
        this.logToRenderer('info', `Connected to VARA data port ${settings.varaDataPort}`);
        done();
      });

      this.dataSocket.on('data', (data) => {
        // Call the data callback if provided
        if (this.dataCallback) {
          this.dataCallback(data);
        } else {
          // Fallback: accumulate in buffer
          this.dataBuffer += data.toString();
        }
      });

      this.dataSocket.on('error', (err) => {
        this.logToRenderer('error', `Data socket error: ${err.message}`);
        done(err);
      });

      this.dataSocket.on('close', () => {
        this.logToRenderer('info', 'Data socket closed');
      });
    });
  }

  disconnect() {
    if (this.cmdSocket) this.cmdSocket.end();
    if (this.dataSocket) this.dataSocket.end();
    this.cmdSocket = null;
    this.dataSocket = null;
    this.bbsLinkUp = false;
    this.bbsPromptReady = false;
  }

  isConnected() {
    return this.cmdSocket && !this.cmdSocket.destroyed &&
      this.dataSocket && !this.dataSocket.destroyed;
  }

  sendCommand(command) {
    if (!this.cmdSocket) {
      throw new Error('Not connected to command port');
    }
    this.cmdSocket.write(command.endsWith('\r\n') ? command : command + '\r\n');
  }

  sendData(data) {
    if (!this.dataSocket) {
      throw new Error('Not connected to data port');
    }
    this.dataSocket.write(data);
  }

  sendToRenderer(event, data) {
    const focused = BrowserWindow.getFocusedWindow();
    const windows = BrowserWindow.getAllWindows();
    const targetWindow =
      (focused && (focused.getParentWindow() || focused)) ||
      windows.find(w => !w.getParentWindow()) ||
      windows[0];

    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send(event, data);
    }
  }

  sendRawBytes(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      buffer = Buffer.from(buffer);
    }
    try {
      this.dataSocket.write(buffer);
    } catch (err) {
      console.error("sendRawBytes error:", err);
    }
  }

  waitForLine(regex, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { regex, resolve };
      this.lineWaiters.push(waiter);

      setTimeout(() => {
        const idx = this.lineWaiters.indexOf(waiter);
        if (idx !== -1) this.lineWaiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for: ${regex}`));
      }, timeout);
    });
  }

  // V.22 - change to give waiters first chance to consume the line, and if no waiter consumes it, 
  // then pass to BBS protocol parser    
  notifyLineListeners(line) {
    // 1. Give waiters FIRST chance to consume the line
    for (let i = 0; i < this.lineWaiters.length; i++) {
      const waiter = this.lineWaiters[i];
      if (waiter.regex.test(line)) {
        this.lineWaiters.splice(i, 1);
        waiter.resolve(line);
        return;   // <-- IMPORTANT: do NOT pass to parser
      }
    }

    // 2. If no waiter consumed it, pass to BBS protocol parser
    if (this.bbsProtocol && this.bbsProtocol.handleLine) {
      this.bbsProtocol.handleLine(line);
    }
  }

  logToRenderer(type, msg) {
    const focused = BrowserWindow.getFocusedWindow();
    const windows = BrowserWindow.getAllWindows();
    const targetWindow =
      (focused && (focused.getParentWindow() || focused)) ||
      windows.find(w => !w.getParentWindow()) ||
      windows[0];

    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send('vara:log', { type, msg });
    }
  }

  getBbsStatus() {
    return {
      bbsLinkUp: this.bbsLinkUp,
      bbsPromptReady: this.bbsPromptReady
    };
  }
}

module.exports = VaraConnection;