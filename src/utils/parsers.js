// Utility functions for parsing and formatting BBS data

function parseWhitePagesLine(line) {
  const parts = line.trim().split(/\s+/);

  const callsign = parts[0];
  const homebbs = parts[1];

  // Everything after homebbs
  const rest = parts.slice(2).join(" ").trim();

  // Extract ZIP (5 digits)
  const zipMatch = rest.match(/\b\d{5}\b/);
  const zipcode = zipMatch ? zipMatch[0] : "";

  let name = "";
  let address = "";

  if (zipcode) {
    // Split at ZIP
    const [beforeZip, afterZip] = rest.split(zipcode);

    name = beforeZip.trim();          // everything before ZIP
    address = afterZip.trim();        // everything after ZIP (city/state)
  } else {
    // No ZIP → name is first token
    const tokens = rest.split(/\s+/);
    name = tokens[0];
    address = rest.replace(name, "").trim();
  }

  return {
    callsign,
    homebbs,
    name,
    zipcode,
    address,
    notes: ""
  };
}

function parseListLine(line) {
  const parts = line.trim().split(/\s+/);

  const msgNum = parseInt(parts[0]);
  const date = parts[1];
  const typeCode = parts[2];
  const size = parseInt(parts[3]);
  const toCall = parts[4];

  let at = "";
  let fromCall = "";
  let subject = "";

  // Detect AT by pattern, not position
  if (parts[5] && parts[5].startsWith("@")) {
    // AT is present
    at = parts[5];
    fromCall = parts[6];
    subject = parts.slice(7).join(" ");
  } else {
    // AT is missing
    at = "";
    fromCall = parts[5];
    subject = parts.slice(6).join(" ");
  }

  const type = typeCode.startsWith("B") ? "bulletin" : "private";
  const datePosted = convertListDate(date);

  return {
    msgNum,
    date,
    datePosted,
    typeCode,
    type,
    size,
    recipient: toCall,
    at,
    sender: fromCall,
    subject
  };
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

function createDateString() {
  const date = new Date();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC'
  });
  return formatter.format(date).replace(' ', '-');
}

function convertListDate(ddmmm) {
    const [dd, mon] = ddmmm.split("-");
    const monthMap = {
        Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
        Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12"
    };

    const mm = monthMap[mon];
    const now = new Date();
    let yyyy = now.getFullYear();

    // Handle year rollover (Dec → Jan)
    const listMonth = parseInt(mm, 10);
    const currentMonth = now.getMonth() + 1;

    if (listMonth > currentMonth + 1) {
        yyyy -= 1; // message is from last year
    }

    return `${yyyy}-${mm}-${dd} 00:00Z`;
}

function convertHeaderDate(dateStr, timeStr) {
    const [mm, dd, yy] = dateStr.split("/");
    const yyyy = (yy < 70 ? "20" : "19") + yy;
    return `${yyyy}-${mm}-${dd} ${timeStr}Z`;
}

module.exports = {
  parseWhitePagesLine,
  parseListLine,
  formatBbsLine,
  createDateString,
  convertListDate,
  convertHeaderDate
}
