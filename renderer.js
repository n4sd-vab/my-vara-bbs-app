window.addEventListener('DOMContentLoaded', async () => {
    let bbsLinkUp = false;
    let connected = false;
    let bbsPromptReady = false;
    let whitePagesResults = [];
    let currentMessageTab = "private";
    let messageListMode = "local"; // "local" | "bbs"

    let inMessageRead = false;
    let currentMsgNum = null;
    let currentBody = [];

    let currentDisplayedMsgNum = null;  // Track which message is displayed in the right panel

    let isReplyMode = false; // modify the modal for message compose vs message reply

    // Load settings ONCE
    const appSettings = await window.settings.get();

    // Get DOM elements
    const composeMsgBtn = document.getElementById('composeMsgBtn');
    const composeModal = document.getElementById('composeModal');
    const composeCancelBtn = document.getElementById('composeCancelBtn');
    const composeTo = document.getElementById('composeTo');
    const composeSubject = document.getElementById('composeSubject');
    const composeType = document.getElementById('composeType');

    const addressBookModal = document.getElementById('addressBookModal');
    const addressBookCancelBtn = document.getElementById('addressBookCancelBtn');
    const addressBookSaveBtn = document.getElementById('addressBookSaveBtn');
    const addressBookViewModal = document.getElementById('addressBookViewModal');
    const addressBookViewClose = document.getElementById('addressBookViewClose');

    const yappReceiveModal = document.getElementById('yappReceiveModal');
    const yappLoadFileListBtn = document.getElementById("yappLoadFileListBtn");
    const yappModalDirInput = document.getElementById('yappModalDirInput');
    const yappReceiveDir = document.getElementById('yappReceiveDir');
    const yappReceiveCancelBtn = document.getElementById('yappReceiveCancelBtn');
    const yappReceiveStartBtn = document.getElementById('yappReceiveStartBtn');
    const yappRecvProgressBar = document.getElementById("yappRecvProgressBar");
    const yappRecvProgressText = document.getElementById("yappRecvProgressText");
    const fileName = document.getElementById('fileName');
    // const fileDirectory = document.getElementById('fileDirectory');

    const yappSendModal = document.getElementById('yappSendModal');
    const yappModalFileInput = document.getElementById('yappModalFileInput');
    const yappSendFile = document.getElementById('yappSendFile');
    const yappSendCancelBtn = document.getElementById('yappSendCancelBtn');
    const yappSendStartBtn = document.getElementById('yappSendStartBtn');
    const yappSendProgressBar = document.getElementById("yappSendProgressBar");
    const yappSendProgressText = document.getElementById("yappSendProgressText");

    const addCallsign = document.getElementById('addCallsign');
    const addName = document.getElementById('addName');
    const addAddress = document.getElementById('addAddress');
    const addHomeBBS = document.getElementById('addHomeBBS');
    const addNotes = document.getElementById('addNotes');

    const connectBtn = document.getElementById('connectBtn');
    const connectBbsBtn = document.getElementById('connectBbsBtn');
    const disconnectBbsBtn = document.getElementById('disconnectBbsBtn');
    const listMineBtn = document.getElementById('listMineBtn');
    const listBullBtn = document.getElementById('listBullBtn');
    const listWxBtn = document.getElementById('listWxBtn');
    const listNewBtn = document.getElementById('listNewBtn');
    const sendBtn = document.getElementById('sendBtn');
    const receiveBtn = document.getElementById('receiveBtn');
    const commandConsole = document.getElementById('commandConsole');
    const commandInput = document.getElementById('commandInput');
    const rxArea = document.getElementById('rxArea');
    const txInput = document.getElementById('txInput');

    //const statusConn = document.getElementById('statusConn');
    const statusLink = document.getElementById('statusLink');
    const statusBusy = document.getElementById('statusBusy');
    const statusPTT = document.getElementById('statusPTT');
    const statusSNR = document.getElementById('statusSNR');
    const statusRate = document.getElementById('statusRate');

    const statusVara = document.getElementById('statusVara');
    const disconnectBtn = document.getElementById('disconnectBtn');

    const composeSendBtn = document.getElementById('composeSendBtn');
    const composeSaveBtn = document.getElementById('composeSaveBtn');
    const composeBody = document.getElementById('composeBody');

    const listPanel = document.getElementById("messageTabs");

    console.log("Loaded settings:", appSettings);

    document.getElementById("varaConsoleSection").style.display =
        appSettings.showVaraConsole ? "block" : "none";

    console.log("txInput:", txInput);

    // Append text to command console
    function appendCommand(type, msg) {
        commandConsole.value += `[${type}] ${msg}\n`;
        commandConsole.scrollTop = commandConsole.scrollHeight;
    }

    function formatBbsLine(line) {
        const parts = line.split(/\s+/);

        const msgNum = parts[0] || "";
        const date = (parts[1] || "");
        const status = (parts[2] || "");
        const size = (parts[3] || "").padStart(5);
        const to = (parts[4] || "").padEnd(8);
        const at = (parts[5] || "").padEnd(8);
        const from = (parts[6] || "").padEnd(7);
        const subject = parts.slice(7).join(" ");

        const paddedLine = msgNum.padEnd(6) + date + " " + status + size + " " + to + at + from + subject;

        return `
                <div class="msgRow" data-msg="${msgNum}">${paddedLine}</div>
            `;
    }

    function clearMessageWindows() {
        msgList.innerHTML = "";
        msgView.innerHTML = "<em>Select a message to view it</em><br>";
    }



    // Parse a message list line to extract message number, 
    // sender, and subject for context menu

    function parseMsgListLine(line) {
        const parts = line.trim().split(/\s+/);
        const msgNum = parts[0];
        const sender = parts[6] || "";
        const subject = parts.slice(6).join(" ");
        return { msgNum, sender, subject };
    }

    let lastLineWasBlank = false;

    function appendMsgViewLine(line) {
        const isBlank = line.trim().length === 0;

        if (isBlank) {
            if (lastLineWasBlank) {
                // skip this line — it's an extra blank
                return;
            }
            lastLineWasBlank = true;
        } else {
            lastLineWasBlank = false;
        }

        msgView.textContent += line + "\n";
        msgView.scrollTop = msgView.scrollHeight;
    }

    async function ensureBbsConnected() {
        console.log("ensureBbsConnected: entry", {
            bbsLinkUp,
            bbsPromptReady
        });
        // Already connected and ready
        if (bbsLinkUp && bbsPromptReady) {
            console.log("ensureBbsConnected: already ready");
            return true;
        }

        console.log("ensureBbsConnected: reconnecting…");
        window.showToast("Reconnecting to BBS…");

        // Build CONNECT command
        const connectCmd =
            `CONNECT ${appSettings.myCall} ${appSettings.bbsCall}` +
            (appSettings.digi1 ? ` VIA ${appSettings.digi1}` : "") +
            (appSettings.digi2 ? ` ${appSettings.digi2}` : "");

        // Send CONNECT
        await window.vara.sendCommand(connectCmd);

        // Wait for RF link (command port)
        await waitUntil(() => bbsLinkUp);

        // Wait for BBS prompt (data port)
        await waitUntil(() => bbsPromptReady);

        console.log("ensureBbsConnected: ready");
        return true;

        console.log("ensureBbsConnected: exit", {
            bbsLinkUp,
            bbsPromptReady
        });
    }

    function waitUntil(cond) {
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (cond()) {
                    clearInterval(check);
                    resolve(true);
                }
            }, 100);
        });
    }



    function attachMessageRowHandlers() {
        const rows = document.querySelectorAll(".msg-row");

        rows.forEach(row => {

            // LEFT CLICK = open message
            row.addEventListener("click", async () => {
                // Remove previous selection highlight
                rows.forEach(r => r.classList.remove("selected"));
                row.classList.add("selected");

                const id = row.dataset.id;
                console.log("Message clicked, id:", id);

                // Fetch full message from DB
                let msg = null;
                try {
                    msg = await window.electronAPI.getMessageById(id);
                    console.log("Fetched message from DB:", msg.msgNum, "has body:", !!msg.body);
                } catch (err) {
                    console.error("Failed to load message", err);
                    return;
                }

                // Mark as read
                if (msg.read === 0) {
                    await window.electronAPI.markMessageRead(id);
                    msg.read = 1;
                }

                // Update styling
                row.classList.remove("unread");
                row.classList.add("read");

                // Track which message is currently displayed
                currentDisplayedMsgNum = msg.msgNum;
                console.log("Set currentDisplayedMsgNum to:", currentDisplayedMsgNum);

                // If body missing, fetch from BBS
                if (!msg.body || msg.body.trim() === "") {
                    console.log("Body missing, requesting from BBS for msgNum:", msg.msgNum);
                    await ensureBbsConnected();
                    window.electronAPI.readMessage(msg.msgNum);
                } else {
                    console.log("Body already exists, displaying immediately");
                }

                window.showToast(`Loading message #${msg.msgNum}…`);

                // Render into right pane
                const viewer = document.getElementById("msgView");
                viewer.innerHTML = `<pre>${msg.body || "(Fetching message...)"}</pre>`;
                row.classList.add("data-read=1");
                row.classList.remove("data-read=0");

            });

            // RIGHT CLICK = context menu
            row.addEventListener("contextmenu", async (ev) => {
                ev.preventDefault();

                const id = row.dataset.id;
                const msg = await window.electronAPI.getMessageById(id);

                showMessageContextMenu(row, msg);
            });
        });
    }

    function showMessageContextMenu(row, msg) {
        const menu = document.createElement("div");
        menu.className = "msg-context-menu";

        menu.innerHTML = `
                    <div class="menu-item" data-action="open">Open</div>
                    <div class="menu-item" data-action="reply">Reply</div>
                    <div class="menu-item" data-action="archive">Move to Archive</div>
                    <div class="menu-item" data-action="delete">Delete</div>
                    <div class="menu-item" data-action="move">Move to...</div>
                    ${currentMessageTab === "bulletin"
                ? `<div class="menu-item" data-action="filter-category">Filter by Category (${msg.recipient})</div>`
                : ""
            }

                `;

        document.body.appendChild(menu);

        // Position near the row
        const rect = row.getBoundingClientRect();
        menu.style.left = rect.right + 5 + "px";
        menu.style.top = rect.top + "px";

        // Handle clicks
        menu.addEventListener("click", async (e) => {
            const action = e.target.dataset.action;
            if (!action) return;

            if (action === "open") {
                row.click();
            }

            if (action === "reply") {
                openReplyModal(msg);
            }

            if (action === "archive") {
                await window.electronAPI.markMessageSaved(msg.msgNum);
                row.classList.add("saved");
                row.remove();
            }

            if (action === "delete") {
                await window.electronAPI.deleteMessage(msg.msgNum);
                row.remove();
            }

            if (action === "move") {
                // Future: open category picker
                window.showToast("Move-to-category not implemented yet");
            }

            if (action === "filter-category") {
                window.electronAPI.filterBulletins(msg.recipient);
                menu.remove();
                return;
            }

            menu.remove();
        });

        // Close on outside click
        document.addEventListener("click", function handler(ev) {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener("click", handler);
            }
        });
    }

    async function renderMessageList(rows) {
        const list = document.getElementById("messageList");

        let messages = [];

        if (rows) {
            // ⭐ Use filtered rows from main process
            messages = rows;
        } else {
            // ⭐ Normal mode: load everything
            try {
                messages = await window.electronAPI.getMessages();
            } catch (err) {
                console.error("Failed to load messages", err);
                return;
            }
        }

        // ⭐ Filter based on current tab
        let filtered = messages.filter(m => {
            if (currentMessageTab === "private") return m.type === "private" && !m.deleted;
            if (currentMessageTab === "bulletin") return m.type === "bulletin" && !m.deleted;
            if (currentMessageTab === "sent") return m.sent === 1 && !m.deleted;
            if (currentMessageTab === "outbox") return m.outbox === 1 && !m.deleted;
            if (currentMessageTab === "saved") return m.saved === 1 && !m.deleted;
            if (currentMessageTab === "user1") return m.type === "user1" && !m.deleted;
            if (currentMessageTab === "user2") return m.type === "user2" && !m.deleted;
            return false;
        });

        // ⭐ Sort newest first
        filtered.sort((a, b) => (b.msgNum || 0) - (a.msgNum || 0));

        // ⭐ Apply message filters (unread, read, local, remote)
        filtered = filtered.filter(m => {
            switch (currentFilter) {
                case "unread": return m.read === 0;
                case "read": return m.read === 1;
                case "local": return m.localOnly === 1;
                case "remote": return m.localOnly === 0;
                default: return true;
            }
        });

        // ⭐ Render
        list.innerHTML = filtered.map(m => `
        <div class="msg-row" data-read="${m.read}" data-id="${m.id}" data-msgnum="${m.msgNum}">
            <pre>${formatListRow(m)}</pre>
        </div>
    `).join("");

        attachMessageRowHandlers();
    }

    function formatListRow(m) {
        const pad = (str, len) => (str + " ".repeat(len)).slice(0, len);

        return [
            pad(m.msgNum.toString(), 5),
            pad(m.date, 6),
            pad(m.typeCode, 2),
            pad((m.size || 0).toString(), 5),
            pad(m.recipient, 7),
            pad(m.at, 7),
            pad(m.sender, 7),
            m.subject
        ].join(" ");
    }

    window.electronAPI.onToast((text) => {
        showToast(text);
    });

    showToast = function (text) {
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = text;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add("visible"), 10);
        setTimeout(() => {
            toast.classList.remove("visible");
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    };


    function showCategoryPopup() {
        const modal = document.getElementById("categoryModal");
        const list = document.getElementById("categoryList");
        const cancelBtn = document.getElementById("categoryCancel");

        list.innerHTML = "";

        window.electronAPI.getBulletinCategories().then(categories => {

            // "All Categories" button
            const allBtn = document.createElement("button");
            allBtn.textContent = "All Categories";
            allBtn.onclick = () => {
                window.electronAPI.filterBulletins("ALL");
                modal.style.display = "none";
            };
            list.appendChild(allBtn);

            // Each category with count
            categories.forEach(cat => {
                const btn = document.createElement("button");
                btn.textContent = `${cat.category} (${cat.count})`;
                btn.onclick = () => {
                    window.electronAPI.filterBulletins(cat.category);
                    modal.style.display = "none";
                };
                list.appendChild(btn);
            });
        });

        cancelBtn.onclick = () => {
            modal.style.display = "none";
        };

        modal.style.display = "flex";
    }

    function openReplyModal(msg) {
        isReplyMode = true;   // set flag FIRST

        // Open the modal (this will show/hide checkbox)
        openComposeModal();

        // Fill fields AFTER modal is open
        document.getElementById("composeTo").value = msg.sender;
        document.getElementById("composeSubject").value = "Re: " + msg.subject;
        document.getElementById("composeType").value = "P";

        const bodyField = document.getElementById("composeBody");
        const includeOriginal = document.getElementById("includeOriginalCheckbox");

        bodyField.value = "";
        includeOriginal.checked = false;

        const quoted = msg.body
            ? "\n\n--- Original Message ---\n" +
            msg.body.split("\n").map(l => "> " + l).join("\n")
            : "";

        includeOriginal.onchange = () => {
            if (includeOriginal.checked) {
                bodyField.value += quoted;
            } else {
                bodyField.value = bodyField.value.replace(quoted, "");
            }
        };
    }

    async function sendBbsCommand(cmd) {
        await ensureBbsConnected();
        if (cmd.startsWith("L")) {
            messageListMode = "bbs";
            const messageList = document.getElementById("messageList");
            messageList.innerHTML = ""; // clear previous content
        }

        window.electronAPI.sendToBbs(cmd);
    }

    // Handle incoming logs from main.js

    function setConnectedUI(connected) {
        connectBtn.disabled = connected;
        disconnectBtn.disabled = !connected;
        disconnectBbsBtn.disabled = !connected;

        connectBbsBtn.disabled = !connected;
        listMineBtn.disabled = !connected;
        listBullBtn.disabled = !connected;
        listWxBtn.disabled = !connected;
        listNewBtn.disabled = !connected;
        composeMsgBtn.disabled = !connected;
        sendBtn.disabled = !connected;
        receiveBtn.disabled = !connected;

        statusVara.textContent = connected ? "Connected" : "Disconnected";
        statusVara.style.color = connected ? "#0f0" : "#f33";
    }

    async function requestMessageBody(msgNum) {
        const msg = await window.electronAPI.getMessageByMsgNum(msgNum);

        if (msg.body && msg.body.length > 0) {
            msgView.innerText = msg.body;
        } else {
            msgView.innerText = "Retrieving message...";
            window.electronAPI.sendToBbs(`R ${msgNum}`);
        }
    }

    function displayMessage(msg) {
        console.log("displayMessage called with:", msg);
        const viewer = document.getElementById("msgView");
        console.log("Setting viewer innerHTML to:", `<pre>${msg.body}</pre>`);
        viewer.innerHTML = `<pre>${msg.body}</pre>`;
        console.log("Viewer innerHTML is now:", viewer.innerHTML);
    }

    async function saveOutboxMessage(message) {
        console.log("Saving outbox message to DB:", message);
        try {
            await window.electronAPI.saveOutboxMessage(message);
        } catch (err) {
            console.error("Failed to save outbox message:", err);
            throw err;
        }

    }

    async function saveMessage(message) {
        console.log("Calling the save message to DB(1):", message);
        try {
            await window.electronAPI.saveMessage(message);
        } catch (err) {
            console.error("Failed to save message:", err);
            throw err;
        }

    }

    // Attach handlers to Edit/Delete buttons in address book view
    function attachAddressBookRowHandlers() {
        document.querySelectorAll(".ab-edit").forEach(btn => {
            btn.addEventListener("click", async () => {
                const id = btn.dataset.id;
                const entry = await window.electronAPI.getAddressBookEntry(id);
                openEditAddressBookModal(entry);
            });
        });

        document.querySelectorAll(".ab-delete").forEach(btn => {
            btn.addEventListener("click", async () => {
                const id = btn.dataset.id;

                const result = await window.electronAPI.deleteAddressBookEntry(id);

                if (result?.success) {
                    const row = document.querySelector(`tr[data-id="${id}"]`);
                    if (row) row.remove();
                }
            });
        });
    }

    function openEditAddressBookModal(entry) {
        addressBookModal.classList.add("front");
        addressBookModal.style.display = "flex";

        addCallsign.value = entry.callsign;
        addHomeBBS.value = entry.homebbs;
        addName.value = entry.name;
        addZipcode.value = entry.zipcode;
        addAddress.value = entry.address;
        addNotes.value = entry.notes;

        addressBookSaveBtn.textContent = "Update";
        addressBookSaveBtn.dataset.id = entry.id;
    }

    function resetYappSendModal() {
        // Show file picker
        document.getElementById("yappPickerSection").style.display = "block";

        // Hide progress section
        document.getElementById("yappSendProgressSection").style.display = "none";

        // Reset progress bar
        document.getElementById("yappSendProgressBar").style.width = "0%";
        document.getElementById("yappSendProgressText").innerText = "0%";

        // Clear file path
        document.getElementById("yappModalSendFile").value = "";
    }

    function resetYappRecvModal() {
        // Show file picker
        document.getElementById("yappFileListSection").style.display = "block";

        // Hide progress section
        document.getElementById("yappRecvProgressSection").style.display = "none";

        // Reset progress bar
        document.getElementById("yappRecvProgressBar").style.width = "0%";
        document.getElementById("yappRecvProgressText").innerText = "0%";

        // Clear file path
        //document.getElementById("yappModalSendFile").value = "";
    }



    // Listen for VARA console toggle from main process
    window.electronAPI.onToggleVaraConsole((visible) => {
        const section = document.getElementById("varaConsoleSection");
        section.style.display = visible ? "block" : "none";
    });

    document.querySelectorAll(".msg-row").forEach(row => {
        row.addEventListener("click", () => {
            const msgNum = row.dataset.msgnum;
            requestMessageBody(msgNum);
        });
    });

    document.getElementById("msg-header").addEventListener("click", () => {
        // Example: toggle date sort
        if (sortDirection === "asc") sortDirection = "desc";
        else sortDirection = "asc";

        renderMessageList();
    });

    let currentFilter = "all";

    let sortColumn = "date";
    let sortDirection = "asc"; // or "desc"

    document.querySelectorAll("#msg-filters button").forEach(btn => {
        btn.addEventListener("click", () => {
            currentFilter = btn.dataset.filter;

            // highlight active button
            document.querySelectorAll("#msg-filters button").forEach(b =>
                b.classList.toggle("active", b === btn)
            );

            renderMessageList();  // re-render with filter applied
        });
    });

    const cancelBtn = document.getElementById("addressBookCancelBtn");
    // const saveBtn = document.getElementById("addressBookSaveBtn");

    async function loadAddressBook() {
        return await window.electronAPI.getAddressBook();
    }

    window.electronAPI.onOpenAddressBookAdd(async () => {
        addressBookModal.style.display = "flex";
        // optionally retrieve existing entries (for debugging / later use)
        try {
            const entries = await window.electronAPI.getAddressBook();
            console.log('Address book entries:', entries);
        } catch (err) {
            console.error('Failed to load address book', err);
        }
    });

    cancelBtn.addEventListener("click", () => {
        addressBookModal.style.display = "none";
    });

    addressBookSaveBtn.addEventListener("click", async () => {
        const entry = {
            id: addressBookSaveBtn.dataset.id || null,
            callsign: addCallsign.value,
            homebbs: addHomeBBS.value,
            name: addName.value,
            zipcode: addZipcode.value,
            address: addAddress.value,
            notes: addNotes.value
        };

        let result;

        if (entry.id) {
            result = await window.electronAPI.updateAddressBookEntry(entry);
        } else {
            result = await window.electronAPI.saveAddressBookEntry(entry);
        }

        // ⭐ Update the row in real time
        if (result?.success && entry.id) {
            const row = document.querySelector(`tr[data-id="${entry.id}"]`);
            if (row) {
                row.querySelector(".ab-callsign").textContent = entry.callsign;
                row.querySelector(".ab-name").textContent = entry.name;
                row.querySelector(".ab-homebbs").textContent = entry.homebbs;
                row.querySelector(".ab-zipcode").textContent = entry.zipcode;
                row.querySelector(".ab-address").textContent = entry.address;
                row.querySelector(".ab-notes").textContent = entry.notes;
            }
        }

        // Reset button state
        addressBookSaveBtn.textContent = "Save";
        delete addressBookSaveBtn.dataset.id;

        // Clear form
        addCallsign.value = "";
        addHomeBBS.value = "";
        addName.value = "";
        addAddress.value = "";
        addZipcode.value = "";
        addNotes.value = "";

        // Close modal
        addressBookModal.style.display = "none";
        addressBookModal.classList.remove("front");
    });

    async function renderAddressBookTable() {
        const tbody = document.getElementById("addressBookTableBody");
        let entries = [];

        try {
            entries = await window.electronAPI.getAddressBook();
        } catch (err) {
            console.error("Failed to load address book", err);
        }

        // ⭐ Apply sorting
        entries.sort((a, b) => {
            const col = addressBookSort.column;
            const dir = addressBookSort.direction === "asc" ? 1 : -1;

            const av = a[col] || "";
            const bv = b[col] || "";

            return av.localeCompare(bv, undefined, { numeric: true }) * dir;
        });

        // Render rows
        tbody.innerHTML = entries.map(e => `
                    <tr data-id="${e.id}">
                    <td><span class="ab-callsign" data-callsign="${e.callsign}">${e.callsign}</span></td>
                    <td class="ab-name">${e.name || ""}</td>
                    <td class="ab-homebbs">${e.homebbs || ""}</td>
                    <td class="ab-zipcode">${e.zipcode || ""}</td>
                    <td class="ab-address">${e.address || ""}</td>
                    <td class="ab-notes">${e.notes || ""}</td>
                    <td>
                        <button class="ab-edit" data-id="${e.id}">Edit</button>
                        <button class="ab-delete" data-id="${e.id}">Delete</button>
                    </td>
                </tr>
                `).join("");

        attachAddressBookRowHandlers();
    }

    window.electronAPI.onOpenAddressBookView(async () => {
        addressBookViewModal.style.display = "flex";
        renderAddressBookTable();
    });

    document.addEventListener("click", (e) => {
        if (e.target.classList.contains("ab-callsign")) {
            const callsign = e.target.dataset.callsign;
            addressBookViewModal.style.display = "none";

            isReplyMode = false;
            openComposeModal(callsign);
        }
    });

    let addressBookSort = { column: "callsign", direction: "asc" };

    document.querySelectorAll(".ab-table th[data-column]").forEach(th => {
        th.addEventListener("click", () => {
            const col = th.dataset.column;

            if (addressBookSort.column === col) {
                addressBookSort.direction =
                    addressBookSort.direction === "asc" ? "desc" : "asc";
            } else {
                addressBookSort.column = col;
                addressBookSort.direction = "asc";
            }

            // Re-render using your existing viewer
            renderAddressBookTable();
        });
    });

    window.electronAPI.onOpenWhitePagesModal(async () => {
        document.getElementById("whitePagesModal").style.display = "flex";
    });

    wpCancelBtn.addEventListener('click', () => {
        whitePagesModal.style.display = "none";
    });

    document.getElementById("whitePagesWindow")
        .addEventListener("click", e => e.stopPropagation());

    wpRunQueryBtn.addEventListener('click', () => {
        const query = wpQuery.value.trim();
        console.log("Running WhitePages query:", query);
        if (!query) return;

        window.electronAPI.startWhitePagesMode();

        wpResults.innerHTML = "Querying BBS...";

        sendBbsCommand(query + "\r");
    });

    window.electronAPI.onWhitePagesLine((entry) => {
        whitePagesResults.push(entry);   // ← store it locally

        wpResults.innerHTML +=
            `${entry.callsign}  ${entry.homebbs}  ${entry.name} ${entry.zipcode} ${entry.address} <br>`;

        wpImportBtn.disabled = false;
    });

    wpImportBtn.addEventListener('click', async () => {
        for (const entry of whitePagesResults) {
            await window.electronAPI.saveAddressBookEntry({ ...entry, preserveNotes: true });
        }
        whitePagesModal.style.display = "none";
    });

    // Listen for message body responses from main process
    window.electronAPI.onMessageBody((msg) => {
        console.log("🎯 onMessageBody EVENT RECEIVED:", msg);
        console.log("Renderer received message body:", msg.msgNum, "currentDisplayedMsgNum:", currentDisplayedMsgNum);
        
        // TEMP: Always display for debugging - update UI to show we received the event
        const viewer = document.getElementById("msgView");
        viewer.innerHTML = `<pre>📨 EVENT RECEIVED for msg ${msg.msgNum} - displaying body...</pre>`;
        setTimeout(() => {
            displayMessage(msg);
        }, 500);
            displayMessage(msg);

            // Fetch the full message from DB (now updated)
            window.electronAPI.getMessageByMsgNum(msg.msgNum).then(fullMsg => {
                // Double-check it's still the current message
                if (fullMsg.msgNum === currentDisplayedMsgNum) {
                    console.log("Displaying full message from DB for msgNum:", fullMsg.msgNum);
                    displayMessage(fullMsg);
                }
            });
        } else {
            console.log("Ignoring message body - not currently displayed. Received:", msg.msgNum, "Displayed:", currentDisplayedMsgNum);
        }
    });

    window.electronAPI.onBulletinList((rows) => {
        console.log("Received bulletin rows:", rows.length);
        renderMessageList(rows);
    });

    // Refresh message list when messages are updated
    window.electronAPI.onMessageDeleted((msgNum) => {
        console.log("Message deleted, refreshing list:", msgNum);
        renderMessageList();
    });

    window.electronAPI.onMessageSaved((msgNum) => {
        console.log("Message saved, refreshing list:", msgNum);
        renderMessageList();
    });

    window.electronAPI.onMessageRead((id) => {
        console.log("Message marked as read, refreshing list:", id);
        renderMessageList();
    });

    window.electronAPI.onMessagesReceived((data) => {
        console.log("Messages received, refreshing list:", data);
        renderMessageList();
    });

    window.electronAPI.onMenuItemClicked((label) => {
        if (label === "Filter by Category") {
            showCategoryPopup();
        }
    });

    document.getElementById("yappModalDirButton").addEventListener("click", async () => {
        const dir = await window.electronAPI.pickDirectory();
        if (dir) {
            document.getElementById("yappModalDirInput").value = dir;
            window.settings.saveSetting("yappReceiveDir", dir);
        }
    });

    window.settings.getSetting("yappReceiveDir").then(dir => {
        document.getElementById("yappModalDirInput").value = dir || "";
    });

    yappLoadFileListBtn.addEventListener("click", async () => {
        await ensureBbsConnected();
        console.log("Renderer: Requesting YAPP file list...");
        window.electronAPI.requestYappFileList();
    });

    window.electronAPI.onYappFileList(files => {
        console.log("Renderer: Received file list:", files);

        const list = document.getElementById("yappFileList");
        list.innerHTML = "";

        if (!files || !Array.isArray(files)) {
            console.log("Renderer: FILE LIST IS NOT AN ARRAY");
            return;
        }

        files.forEach(f => {
            //console.log("Renderer: Adding file:", f);
            const li = document.createElement("li");
            li.textContent = `${f.name} (${f.size} bytes)`;
            li.addEventListener("click", () => {
                fileName.value = f.name;
            });
            list.appendChild(li);
        });
    });

    window.electronAPI.onOpenYappReceive(async () => {
        yappReceiveModal.style.display = "flex";

        // Request file list from BBS when modal opens
        // window.electronAPI.requestYappFileList();

        // Load the save directory when the modal opens
        const dir = await window.settings.getSetting("yappReceiveDir");
        document.getElementById("yappModalDirInput").value = dir || "";
    });

    window.electronAPI.onYappReceiveComplete(() => {
        setTimeout(() => {
            resetYappRecvModal();

            // Close modal
            const modal = document.getElementById("yappReceiveModal");
            modal.style.display = "none";

            // Log
            appendCommand('info', 'YAPP file receive complete');

            // Toast
            const toast = document.getElementById("yappToast");
            toast.innerText = "File received successfully";
            toast.classList.add("show");
            setTimeout(() => toast.classList.remove("show"), 4000);

            // Reset progress bar
            document.getElementById("yappRecvProgressBar").style.width = "0%";
            document.getElementById("yappRecvProgressText").innerText = "0%";
        }, 500); // 300–500ms is perfect
    });

    // ------------------------------------------------------------
    // OPEN YAPP SEND MODAL
    // ------------------------------------------------------------
    window.electronAPI.onOpenYappSend(() => {
        const modal = document.getElementById("yappSendModal");
        modal.style.display = "flex";
    });

    // ------------------------------------------------------------
    // FILE PICKER BUTTON
    // ------------------------------------------------------------
    document.getElementById("yappModalSendFileButton").addEventListener("click", async () => {
        const filePath = await window.electronAPI.pickFile();
        if (filePath) {
            document.getElementById("yappModalSendFile").value = filePath;
        }
    });

    window.electronAPI.onYappSendError((event, { message }) => {
        document.getElementById("yappSendErrorMessage").innerText =
            message || "An unknown error occurred during YAPP send.";

        document.getElementById("yappSendErrorSection").style.display = "block";
        document.getElementById("yappSendProgressSection").style.display = "none";
    });

    // ------------------------------------------------------------
    // START SEND BUTTON
    // ------------------------------------------------------------
    document.getElementById("yappSendStartBtn").addEventListener("click", async () => {
        await ensureBbsConnected();
        const filePath = document.getElementById("yappModalSendFile").value;

        if (!filePath) {
            appendCommand("error", "No file selected for YAPP send");
            return;
        }

        // Switch modal to progress mode
        document.getElementById("yappPickerSection").style.display = "none";
        document.getElementById("yappSendProgressSection").style.display = "block";

        const fileBytes = await window.electronAPI.sendYappFile(filePath);
        if (!fileBytes) {
            appendCommand("error", "Failed to load file for YAPP send");
            return;
        }

        const fileName = filePath.split(/[/\\]/).pop();
        const fileSize = fileBytes.length;

        window.electronAPI.startYappSend({
            fileName,
            fileSize,
            fileBytes
        });
    });

    // ------------------------------------------------------------
    // PROGRESS UPDATES (new version with percent)
    // ------------------------------------------------------------
    window.electronAPI.onYappRecvProgress((event, { received, total, percent }) => {
        const pct = percent + "%";
        console.log("Receiver progress:", pct);

        document.getElementById("yappRecvProgressBar").style.width = pct;
        document.getElementById("yappRecvProgressText").innerText = pct;
    });

    window.electronAPI.onYappSendProgress((event, { sent, total, percent }) => {
        const pct = percent + "%";

        console.log("Sender progress:", pct);

        const bar = document.getElementById("yappSendProgressBar");
        const text = document.getElementById("yappSendProgressText");

        bar.style.width = pct;
        text.innerText = pct;
    });

    // ------------------------------------------------------------
    // SEND COMPLETE
    // ------------------------------------------------------------
    window.electronAPI.onYappSendComplete(() => {
        // Let the final progress update paint
        setTimeout(() => {
            resetYappSendModal();
            document.getElementById("yappSendModal").style.display = "none";

            const toast = document.getElementById("yappToast");
            toast.innerText = "File sent successfully";
            toast.classList.add("show");
            setTimeout(() => toast.classList.remove("show"), 4000);

            // Reset progress bar
            document.getElementById("yappSendProgressBar").style.width = "0%";
            document.getElementById("yappSendProgressText").innerText = "0%";
        }, 500); // 300–500ms is perfect
    });

    // -------------------------------------------------------------
    // BBS Help Modal
    window.electronAPI.onOpenBbsHelp(() => {
        document.getElementById("bbsHelpModal").style.display = "flex";
    });
    // About Modal
    window.electronAPI.onOpenAbout(() => {
        document.getElementById("aboutModal").style.display = "flex";
    });
    //  
    // Listen for message context menu events
    // 
    window.vara.onLog(({ type, msg }) => {
        appendCommand(type, msg);

        // Split into individual VARA/BPQ lines
        //const lines = msg.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
        const lines = msg.split(/\r\n|\r|\n/);

        for (const line of lines) {
            handleVaraLine(type, line);
        }
    });

    function handleVaraLine(type, line) {

        // Connection state
        if (line.startsWith("Connected to VARA")) {
            setConnectedUI(true);
            statusVara.textContent = "Connected";
            statusVara.style.color = "#0f0";
        }

        if (line.includes("socket closed")) {
            setConnectedUI(false);
            statusVara.textContent = "Disconnected";
            statusVara.style.color = "#f33";
        }

        // RF link up
        if (/^\s*CONNECTED\s/.test(line)) {
            bbsLinkUp = true;
            statusLink.textContent = "BBS Link Up";
            statusLink.style.color = "#0f0";
            console.log("BBS link is up");
        }

        // RF link down
        if (type === "cmd" && line.includes("DISCONNECTED")) {
            bbsLinkUp = false;
            bbsPromptReady = false;
            statusLink.textContent = "BBS Link Down";
            statusLink.style.color = "#f33";
            console.log("BBS link is down");
        }

        // BPQ prompt
        if (/^\s*de\s+[A-Z0-9\-]+>/i.test(line)) {
            bbsPromptReady = true;
            console.log("BBS prompt detected");
        }

        // Busy
        if (line === "BUSY ON") {
            statusBusy.textContent = "ON";
            statusBusy.style.color = "#f33";
        }

        if (line === "BUSY OFF") {
            statusBusy.textContent = "OFF";
            statusBusy.style.color = "#0f0";
        }

        // PTT
        if (line === "PTT ON") {
            statusPTT.textContent = "ON";
            statusPTT.style.color = "#f33";
        }

        if (line === "PTT OFF") {
            statusPTT.textContent = "OFF";
            statusPTT.style.color = "#0f0";
        }

        // SNR / BITRATE
        if (line.startsWith("SN")) {
            const snr = line.replace("SN", "").trim();
            statusSNR.textContent = snr;
        }

        if (line.startsWith("BITRATE")) {
            const rate = line.replace("BITRATE", "").trim();
            statusRate.textContent = rate;
        }

        // Data routing
        if (type === "data") {
            const msgListPattern = /^\s*\d+\s+\d{1,2}-[A-Za-z]{3}\s+[A-Z$]{1,3}\s+\d+/;

            if (msgListPattern.test(line)) {
                msgList.innerHTML += formatBbsLine(line);
                msgList.scrollTop = msgList.scrollHeight;
            } else {
                // Assume anything else is message content for now
                // msgView.innerText += line + "\n";
                appendMsgViewLine(line);
                msgView.scrollTop = msgView.scrollHeight;
            }
        }
    }

    connectBtn.addEventListener('click', async () => {
        try {
            await window.vara.connect();
            appendCommand('info', 'Connect requested');
        } catch (err) {
            appendCommand('error', 'Connect failed: ' + err.message);
        }
    });

    // Command input (Enter to send)
    commandInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const line = commandInput.value.trim();
            if (!line) return;
            appendCommand('local', '> ' + line);
            commandInput.value = '';
            try {
                await window.vara.sendCommand(line);
            } catch (err) {
                appendCommand('error', 'Send command failed: ' + err.message);
            }
        }
    });

    txInput.addEventListener('keydown', async (e) => {
        console.log("Key Pressed:", e.key);

        if (e.key === 'Enter') {
            e.preventDefault();

            const text = txInput.value.trim();
            if (!text) return;

            appendCommand('local', 'TX: ' + text);
            txInput.value = '';

            try {
                await sendBbsCommand(text);
            } catch (err) {
                appendCommand('error', 'Send data failed: ' + err.message);
            }
        }
    });

    // Connect BBS button
    connectBbsBtn.addEventListener('click', async () => {
        const cmd = `CONNECT ${appSettings.myCall} ${appSettings.bbsCall}${appSettings.digi1 ? " VIA " + appSettings.digi1 : ""}${appSettings.digi2 ? appSettings.digi2 : ""}`;
        appendCommand('local', '> ' + cmd);
        try {
            await window.vara.sendCommand(cmd);
        } catch (err) {
            appendCommand('error', 'Connect BBS failed: ' + err.message);
        }
    });
    disconnectBbsBtn.addEventListener('click', async () => {
        const cmd = `B\r`;
        appendCommand('local', '> ' + 'B');
        try {
            await sendBbsCommand("B");
        } catch (err) {
            appendCommand('error', 'Disconnect BBS failed: ' + err.message);
        }
    });

    disconnectBtn.addEventListener('click', async () => {
        appendCommand('local', '> DISCONNECT');
        try {
            await window.vara.disconnect();
        } catch (err) {
            appendCommand('error', 'Disconnect failed: ' + err.message);
        }
    });

    // Tabbed Message List
    document.querySelectorAll(".msg-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            // Update active tab
            document.querySelectorAll(".msg-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");

            currentMessageTab = tab.dataset.tab;
            messageListMode = "local"; // reset to local mode when switching tabs

            renderMessageList();  // ⭐ re-render the left pane
        });
    });

    listPanel.addEventListener("contextmenu", (ev) => {
        if (currentMessageTab !== "bulletin") return;

        ev.preventDefault();

        window.electronAPI.createMenu([
            {
                label: "Filter by Category"
            }
        ]);
    });


    // List Mine (LM) updated to use sendBbsCommand helper which ensures BBS connection and routes through main process

    listMineBtn.addEventListener("click", async () => {
        // clearMessageWindows();
        appendCommand("local", "TX: LM");
        try {
            await sendBbsCommand("LM");
        } catch (err) {
            appendCommand("error", "List Mine failed: " + err.message);
        }
    });

    listBullBtn.addEventListener('click', async () => {
        // clearMessageWindows();
        appendCommand('local', 'TX: LB');
        try {
            await sendBbsCommand("LB");
        } catch (err) {
            appendCommand('error', 'List Bulletins failed: ' + err.message);
        }
    });

    listWxBtn.addEventListener('click', async () => {
        // clearMessageWindows();
        appendCommand('local', 'TX: LW');
        try {
            await sendBbsCommand("L> WX");
        } catch (err) {
            appendCommand('error', 'List Weather failed: ' + err.message);
        }
    });

    // List All (L)
    listNewBtn.addEventListener('click', async () => {
        //clearMessageWindows();
        appendCommand('local', 'TX: L');
        try {
            await sendBbsCommand("L");
        } catch (err) {
            appendCommand('error', 'List New failed: ' + err.message);
        }
    });

    document.getElementById("sendBtn").addEventListener("click", () => {
        window.electronAPI.sendOutbox();
    });

    document.getElementById("receiveBtn").addEventListener("click", async () => {
        console.log("Receive button clicked, requesting messages from main process...");
        const result = await window.electronAPI.receiveMessages();

        if (result.error) {
            window.showToast("Receive failed: " + result.error);
        } else {
            window.showToast(`Downloaded ${result.downloaded} messages`);
            renderMessageList();
        }
    });

    document.getElementById("composeWindow")
        .addEventListener("click", (e) => e.stopPropagation());

    composeMsgBtn.addEventListener('click', () => {
        isReplyMode = false;

        openComposeModal();
        //composeModal.style.display = "flex";
    });

    async function openComposeModal(prefill = {}) {
        const list = document.getElementById("callsignList");
        const toInput = document.getElementById("composeTo");

        // Allow passing a string directly: openComposeModal("K4ABC")
        if (typeof prefill === "string") {
            prefill = { to: prefill };
        }

        // Clear old entries
        list.innerHTML = "";

        // Load address book entries
        const entries = await window.electronAPI.getAddressBook();

        for (const entry of entries) {
            const opt = document.createElement("option");
            opt.value = entry.callsign;
            opt.label = entry.name || "";
            list.appendChild(opt);
        }

        // Prefill if needed
        if (prefill.to) {
            toInput.value = prefill.to;
        }

        // ⭐ Show modal FIRST
        composeModal.style.display = "flex";

        // ⭐ THEN toggle the checkbox visibility
        document.getElementById("includeOriginalContainer").style.display =
            isReplyMode ? "block" : "none";
    }

    composeCancelBtn.addEventListener('click', () => {
        composeModal.style.display = "none";
    });

    addressBookViewClose.addEventListener('click', () => {
        addressBookViewModal.style.display = "none";
    });

    yappReceiveCancelBtn.addEventListener('click', () => {
        resetYappRecvModal();
        yappReceiveModal.style.display = "none";
    });

    yappSendCancelBtn.addEventListener("click", () => {
        resetYappSendModal();
        yappSendModal.style.display = "none";
    });
    yappSendErrorCloseBtn.addEventListener("click", () => {
        document.getElementById("yappSendErrorSection").style.display = "none";
        document.getElementById("yappPickerSection").style.display = "block";
    });

    document.getElementById("yappReceiveStartBtn").addEventListener("click", async () => {
        await ensureBbsConnected();

        const filename = document.getElementById('fileName').value.trim();
        const directory = document.getElementById('yappModalDirInput').value.trim();

        // Switch modal to progress mode
        document.getElementById("yappFileListSection").style.display = "none";
        document.getElementById("yappRecvProgressSection").style.display = "block";

        window.electronAPI.startYappReceive({ filename, directory });
    });

    bbsHelpClose.addEventListener('click', () => {
        document.getElementById("bbsHelpModal").style.display = "none";
    });
    aboutClose.addEventListener('click', () => {
        document.getElementById("aboutModal").style.display = "none";
    });

    composeSendBtn.addEventListener('click', async () => {
        const msgNum = Date.now(); // temporary unique ID
        const recipient = document.getElementById('composeTo').value.trim();
        const subject = document.getElementById('composeSubject').value.trim();
        const type = document.getElementById('composeType').value;
        const body = document.getElementById('composeBody').value;
        const sender = appSettings.myCall;

        if (!recipient || !subject || !body) {
            appendCommand('error', 'All fields are required');
            return;
        }

        // Build BBS message format
        // Old format
        /* const cmd = (type === "P") ? `SP ${to}\r` : `SB ${to}\r`;
        const msg =
            cmd +
            `${subject}\r` +
            body.replace(/\n/g, "\r") +
            `\r/EX\r`; */

        const msg = {
            msgNum,
            type,
            recipient,
            sender,
            subject,
            body
        };

        appendCommand('local', 'TX: Sending message');

        await saveMessage({ msg });

        try {
            await window.electronAPI.sendBbsMessage(msg);

            // reset form and close modal
            composeModal.style.display = "none";
            composeTo.value = "";
            composeSubject.value = "";
            composeBody.value = "";
            composeType.value = "P";
        } catch (err) {
            appendCommand('error', 'Send message failed: ' + err.message);
        }
    });

    composeSaveBtn.addEventListener('click', async () => {
        const msgNum = Date.now(); // temporary unique ID
        const recipient = document.getElementById('composeTo').value.trim();
        const subject = document.getElementById('composeSubject').value.trim();
        const type = document.getElementById('composeType').value;
        const body = document.getElementById('composeBody').value;
        const sender = appSettings.myCall;

        if (!recipient || !subject || !body) {
            appendCommand('error', 'All fields are required');
            return;
        }
        await saveOutboxMessage({
            msgNum,
            type,
            recipient,
            sender,
            subject,
            body
        });
        composeModal.style.display = "none";
    });

    // Initialize message list with private messages
    renderMessageList();

});
console.log("RENDERER LOADED");
