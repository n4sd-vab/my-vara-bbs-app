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
        folder TEXT DEFAULT 'inbox',
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

  /* upsertMessageListEntry(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (msgNum, date, datePosted, typeCode, type, size, recipient, at, sender, subject, folder, downloaded, read)
      VALUES (@msgNum, @date, @datePosted, @typeCode, @type, @size, @recipient, @at, @sender, @subject, 'inbox', 0, 0)
      ON CONFLICT(msgNum) DO UPDATE SET
        date=@date,
        sender=@sender,
        recipient=@recipient,
        subject=@subject
    `);
    stmt.run(msg);

    if (msg.type === "private") {
      // Mark this message as seen in the latest LP
      this.db.prepare(`
        UPDATE messages SET seenInLP = 1 WHERE msgNum = ?
      `).run(msg.msgNum);

    } else if (msg.type === "bulletin") {
      // Mark this message as seen in the latest LB
      this.db.prepare(`
        UPDATE messages SET seenInLB = 1 WHERE msgNum = ?
      `).run(msg.msgNum);
    }
  } */

  upsertMessageListEntry(msg) {
  // Check if message already exists
  const existing = this.db.prepare(
    "SELECT * FROM messages WHERE msgNum = ?"
  ).get(msg.msgNum);

  if (!existing) {
    // INSERT new message header
    this.db.prepare(`
      INSERT INTO messages (
        msgNum, date, datePosted, typeCode, type,
        size, recipient, at, sender, subject,
        folder, downloaded, read,
        seenInLM, seenInLP, seenInLB
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', 0, 0, 0, 0, 0)
    `).run(
      msg.msgNum, msg.date, msg.datePosted, msg.typeCode, msg.type,
      msg.size, msg.recipient, msg.at, msg.sender, msg.subject
    );
  } else {
    // UPDATE header fields only — preserve local state
    this.db.prepare(`
      UPDATE messages SET
        date = ?,
        datePosted = ?,
        typeCode = ?,
        type = ?,
        size = ?,
        recipient = ?,
        at = ?,
        sender = ?,
        subject = ?
      WHERE msgNum = ?
    `).run(
      msg.date, msg.datePosted, msg.typeCode, msg.type,
      msg.size, msg.recipient, msg.at, msg.sender, msg.subject,
      msg.msgNum
    );
  }

  // Mark seen flags
  if (msg.type === "private") {
    this.db.prepare(`
      UPDATE messages SET seenInLP = 1 WHERE msgNum = ?
    `).run(msg.msgNum);
  } else if (msg.type === "bulletin") {
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
  // This is used for messages composed in the outbox before sending - 
  // we want to save them immediately so they persist if the app is closed before sending
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
      INSERT INTO messages (msgNum, date, typeCode, type, recipient, sender, subject, body, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outbox')
    `);
    stmt.run(msg.msgNum, formattedDate, typeCode, type, msg.recipient, msg.sender, msg.subject, msg.body);

    return true;
  }
  // This is used for messages sent directly from the message view (not via the outbox)
  saveMessage(msg) {
    msg.msgNum = Date.now(); // Temporary msgNum until we get the real one from the BBS after sending
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
      INSERT INTO messages (msgNum, date, typeCode, type, recipient, sender, subject, body, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')
    `);
    stmt.run(msg.msgNum, formattedDate, typeCode, type, msg.recipient, msg.sender, msg.subject, msg.body);

    return true;
  }

  getLastInsertRowId() {
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get();
    return row ? row.id : null;
  }

  getAllMessages() {
    return this.db.prepare("SELECT * FROM messages WHERE folder != 'trash'").all();
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

  /*   markMessageArchived(msgNum) {
      this.db.prepare("UPDATE messages SET folder = 'archive' WHERE msgNum = ?").run(msgNum);
    } */

  // V.23 Unified folder-move method with UI refresh + event emit
  moveMessageToFolder(msgNum, folder) {
    // 1. Update DB
    this.db.prepare("UPDATE messages SET folder = ? WHERE msgNum = ?")
      .run(folder, msgNum);
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
    const result = this.db.prepare("UPDATE messages SET folder = 'trash' WHERE msgNum = ?").run(numMsg);
    return result.changes;
  }

  emptyTrash() {
    const stmt = this.db.prepare("DELETE FROM messages WHERE folder = 'trash'");
    const info = stmt.run();
    return info.changes;   // number of rows deleted
  }

  getOutboxMessages() {
    return this.db.prepare("SELECT * FROM messages WHERE folder = 'outbox' ").all();
  }

  updateOutboxMessageSent(id, msgNum, size, date, datePosted) {
    console.log("Updating outbox message as sent:", { id, msgNum, size, date, datePosted });
    this.db.prepare(`
      UPDATE messages
      SET msgNum = ?, size = ?, folder = 'outbox', date = ?, datePosted = ?
      WHERE id = ?
    `).run(msgNum, size, date, datePosted, id);
  }

  updateMessageSent(id, msgNum, size, date, datePosted) {
    console.log("Updating direct message as sent:", { id, msgNum, size, date, datePosted });
    this.db.prepare(`
      UPDATE messages
      SET msgNum = ?, size = ?, folder = 'sent', date = ?, datePosted = ?
      WHERE id = ?
    `).run(msgNum, size, date, datePosted, id);
  }

  getPrivateMessagesForDownload() {
    return this.db.prepare(`
      SELECT msgNum FROM messages
      WHERE type='private' AND folder = 'inbox' AND downloaded = 0
    `).all();
  }

  getPrivateMessagesInTrash() {
    return this.db.prepare(
      "SELECT msgNum FROM messages WHERE folder='trash' AND type='private'"
    ).all();
  }

  deletePrivateTrashMessages() {
    this.db.prepare(
      "DELETE FROM messages WHERE folder='trash' AND type='private'"
    ).run();
  }

  markPrivateMessagesSeen() {
    this.db.prepare("UPDATE messages SET seenInLP = 0 WHERE type='private'").run();
  }

  deleteUnseenPrivateMessages() {
    this.db.prepare(`
      UPDATE messages
      SET folder = 'trash'
      WHERE type='private' AND seenInLP = 0 AND downloaded = 0
    `).run();
  }

  markBulletinMessagesSeen() {
    this.db.prepare("UPDATE messages SET seenInLB = 0 WHERE type='bulletin'").run();
  }

  deleteUnseenBulletinMessages() {
    this.db.prepare(`
      UPDATE messages
      SET folder = 'trash'
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

  getBulletinsBySender(sender) {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE type='bulletin' AND TRIM(sender) = ?
      ORDER BY msgNum DESC
    `).all(sender);
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

  /* syncWithBbs(type, bbsRows) {

    return; // TEMP - disable sync for now while we test other things
    const bbsNums = new Set(bbsRows.map(r => r.msgNum));

    // Get all local messages of this type
    const localRows = this.db.prepare(
      "SELECT msgNum, folder FROM messages WHERE type = ?"
    ).all(type);

    let deleted = 0;

    for (const row of localRows) {
      const { msgNum, folder } = row;

      // Skip user-managed folders
      if (["archive", "user1", "user2", "saved", "sent", "outbox"].includes(folder)) {
        continue;
      }

      // Skip trash (handled by K-delete)
      if (folder === "trash") {
        continue;
      }

      // If BBS no longer lists this message → expired → delete locally
      if (!bbsNums.has(msgNum)) {
        this.db.prepare("DELETE FROM messages WHERE msgNum = ?").run(msgNum);
        deleted++;
      }
    }

    return deleted;
  } */

  syncWithBbs(type, bbsRows) {

    // SAFETY: Disabled unless explicitly enabled
    if (!this.enableSafeSync) {
      console.log("syncWithBbs skipped (safe mode)");
      return 0;
    }

    const bbsNums = new Set(bbsRows.map(r => r.msgNum));

    const localRows = this.db.prepare(
      "SELECT msgNum, folder FROM messages WHERE type = ?"
    ).all(type);

    let deleted = 0;

    for (const row of localRows) {
      const { msgNum, folder } = row;

      // Never touch local-only folders
      if (["archive", "user1", "user2", "saved", "sent", "outbox"].includes(folder))
        continue;

      // Never touch trash
      if (folder === "trash")
        continue;

      // Never delete bulletins automatically
      if (type === "bulletin")
        continue;

      // Private messages only:
      if (!bbsNums.has(msgNum)) {
        this.db.prepare("UPDATE messages SET folder='trash' WHERE msgNum=?").run(msgNum);
        deleted++;
      }
    }

    return deleted;
  }
}



module.exports = DatabaseManager;