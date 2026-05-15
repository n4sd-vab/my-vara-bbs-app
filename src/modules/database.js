const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

class DatabaseManager {
  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'bbs.db');
    this.db = new Database(dbPath);
    this.initializeDatabase();
  }

  initializeDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        msgNum INTEGER,
        date TEXT,
        datePosted TEXT,
        typeCode TEXT,
        type TEXT,
        size INTEGER,
        recipient TEXT,
        at TEXT,
        sender TEXT,
        subject TEXT,
        body TEXT,
        downloaded INTEGER DEFAULT 0,
        read INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0,
        outbox INTEGER DEFAULT 0,
        sent INTEGER DEFAULT 0,
        category TEXT,
        seenInLM INTEGER DEFAULT 0,
        seenInLP INTEGER DEFAULT 0,
        seenInLB INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS address_book (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        callsign TEXT UNIQUE,
        homebbs TEXT,
        name TEXT,
        zipcode TEXT,
        address TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        direction TEXT,
        content TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msgNum ON messages(msgNum);
      CREATE INDEX IF NOT EXISTS idx_address_callsign ON address_book(callsign);
    `);
  }

  // Message operations
  upsertMessageListEntry(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (msgNum, date, datePosted,typeCode, type, size, recipient, at, sender, subject, downloaded, read, archived, deleted)
      VALUES (@msgNum, @date, @datePosted, @typeCode, @type, @size, @recipient, @at, @sender, @subject, 0, 0, 0, 0)
      ON CONFLICT(msgNum) DO UPDATE SET
        date=@date,
        sender=@sender,
        recipient=@recipient,
        subject=@subject
    `);
    stmt.run(msg);

    if (msg.type === "private") {
      // Mark this message as seen in the latest LM
      this.db.prepare(`
        UPDATE messages SET seenInLM = 1 WHERE msgNum = ?
      `).run(msg.msgNum);
      
    } else if (msg.type === "bulletin") {
      // Mark this message as seen in the latest LB
      this.db.prepare(`
        UPDATE messages SET seenInLB = 1 WHERE msgNum = ?
      `).run(msg.msgNum);
    }
  }

  saveMessageBody(msgNum, body) {
    this.db.prepare(`
      UPDATE messages SET body = ?, downloaded = 1 WHERE msgNum = ?
    `).run(body, msgNum);
  }

  saveOutboxMessage(msg) {
    const date = new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      timeZone: 'UTC'
    });
    const formattedDate = formatter.format(date).replace(' ', '-');

    const typeCode = msg.type;
    const type = msg.type === "P" ? "private" : "bulletin";

    const stmt = this.db.prepare(`
      INSERT INTO messages (msgNum, date, typeCode, type, recipient, sender, subject, body, outbox, sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `);
    stmt.run(msg.msgNum, formattedDate, typeCode, type, msg.recipient, msg.sender, msg.subject, msg.body);

    return true;
  }

  saveMessage(msg) {
    const date = new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      timeZone: 'UTC'
    });
    const formattedDate = formatter.format(date).replace(' ', '-');

    const typeCode = msg.type;
    const type = msg.type === "P" ? "private" : "bulletin";

    const stmt = this.db.prepare(`
      INSERT INTO messages (msgNum, date, typeCode, type, recipient, sender, subject, body, downloaded, read, archived, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
    `);
    stmt.run(msg.msgNum, formattedDate, typeCode, type, msg.recipient, msg.sender, msg.subject, msg.body);

    return true;
  }

  getAllMessages() {
    return this.db.prepare("SELECT * FROM messages WHERE deleted=0").all();
  }

  getMessageById(id) {
    return this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);
  }

  getMessageByMsgNum(msgNum) {
    return this.db.prepare("SELECT * FROM messages WHERE msgNum=?").get(msgNum);
  }

  markMessageRead(id) {
    this.db.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(id);
  }

  markMessageArchived(msgNum) {
    this.db.prepare("UPDATE messages SET archived = 1 WHERE msgNum = ?").run(msgNum);
  }

  markMessageDownloaded(msgNum) {
    this.db.prepare("UPDATE messages SET downloaded = 1 WHERE msgNum = ?").run(msgNum);
  }

  deleteMessage(msgNum) {
    const numMsg = parseInt(msgNum, 10);
    if (isNaN(numMsg)) {
      console.error("deleteMessage: Invalid msgNum - not a number:", msgNum);
      return;
    }
    const result = this.db.prepare("UPDATE messages SET deleted = 1 WHERE msgNum = ?").run(numMsg);
    return result.changes;
  }

  getOutboxMessages() {
    return this.db.prepare("SELECT * FROM messages WHERE outbox = 1 AND deleted = 0 AND sent = 0").all();
  }

  updateOutboxMessageSent(id, msgNum, size, date) {
    this.db.prepare(`
      UPDATE messages
      SET msgNum = ?, size = ?, sent = 1, outbox = 0, date = ?
      WHERE id = ?
    `).run(msgNum, size, date, id);
  }

  getPrivateMessagesForDownload() {
    return this.db.prepare(`
      SELECT msgNum FROM messages
      WHERE type='private' AND deleted=0 AND downloaded = 0
    `).all();
  }

  markPrivateMessagesSeen() {
    this.db.prepare("UPDATE messages SET seenInLP = 1 WHERE type='private'").run();
  }

  deleteUnseenPrivateMessages() {
    this.db.prepare(`
      UPDATE messages
      SET deleted = 1
      WHERE type='private' AND seenInLP = 1 AND downloaded = 0
    `).run();
  }

  markBulletinMessagesSeen() {
    this.db.prepare("UPDATE messages SET seenInLB = 1 WHERE type='bulletin'").run();
  }

  deleteUnseenBulletinMessages() {
    this.db.prepare(`
      UPDATE messages
      SET deleted = 1
      WHERE type='bulletin' AND seenInLB = 0 AND downloaded = 0
    `).run();
  }

  getBulletinCategories() {
    return this.db.prepare(`
      SELECT TRIM(recipient) AS category, COUNT(*) AS count
      FROM messages
      WHERE type='bulletin'
      GROUP BY TRIM(recipient)
      ORDER BY category ASC
    `).all();
  }

  getBulletinsByCategory(category) {
    if (category === "ALL") {
      return this.db.prepare(`
        SELECT * FROM messages
        WHERE type='bulletin'
        ORDER BY msgNum DESC
      `).all();
    } else {
      return this.db.prepare(`
        SELECT * FROM messages
        WHERE type='bulletin' AND TRIM(recipient) = ?
        ORDER BY msgNum DESC
      `).all(category);
    }
  }

  // Address book operations
  saveAddressBookEntry(entry) {
    if (entry.preserveNotes) {
      // WP import: do NOT overwrite notes
      this.db.prepare(`
        INSERT INTO address_book (callsign, homebbs, name, zipcode, address)
        VALUES (@callsign, @homebbs, @name, @zipcode, @address)
        ON CONFLICT(callsign) DO UPDATE SET
          homebbs = excluded.homebbs,
          name = excluded.name,
          zipcode = excluded.zipcode,
          address = excluded.address
      `).run(entry);
    } else {
      // Manual edit: update everything including notes
      this.db.prepare(`
        INSERT INTO address_book (callsign, homebbs, name, zipcode, address, notes)
        VALUES (@callsign, @homebbs, @name, @zipcode, @address, @notes)
        ON CONFLICT(callsign) DO UPDATE SET
          homebbs = excluded.homebbs,
          name = excluded.name,
          zipcode = excluded.zipcode,
          address = excluded.address,
          notes = excluded.notes
      `).run(entry);
    }
    return { success: true, entry };
  }

  getAddressBook() {
    return this.db.prepare(`SELECT * FROM address_book ORDER BY callsign`).all();
  }

  deleteAddressBookEntry(id) {
    this.db.prepare("DELETE FROM address_book WHERE id = ?").run(id);
    return { success: true, id };
  }

  getAddressBookEntry(id) {
    return this.db.prepare("SELECT * FROM address_book WHERE id = ?").get(id);
  }

  searchAddressBook(prefix) {
    const query = `${prefix}%`;
    return this.db.prepare("SELECT * FROM address_book WHERE callsign LIKE ? OR name LIKE ? ORDER BY callsign").all(query, query);
  }

  updateAddressBookEntry(entry) {
    this.db.prepare(`
      UPDATE address_book
      SET callsign=@callsign,
          homebbs=@homebbs,
          name=@name,
          zipcode=@zipcode,
          address=@address,
          notes=@notes
      WHERE id=@id
    `).run(entry);
    return { success: true, entry };
  }

  debugAddressBook() {
    return this.db.prepare("SELECT * FROM address_book").all();
  }
}

module.exports = DatabaseManager;