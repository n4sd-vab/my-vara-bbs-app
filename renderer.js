window.addEventListener('DOMContentLoaded', async () => {
    let bbsLinkUp = false;  // Track if RF link to BBS is up (command port)
    let connected = false;  // Track if VARA is connected (data port)
    let bbsPromptReady = false; // Track if BBS prompt is ready (after CONNECT, before we can send commands)
    let whitePagesResults = [];
    let currentMessageTab = "private";
    let messageListMode = "local"; // "local" | "bbs"

    let inMessageRead = false;
    let currentMsgNum = null;
    let currentBody = [];

    let currentDisplayedMsgNum = null;  // Track which message is displayed in the right panel

    let currentBulletinFilter = { type: "none", value: null };

    let multiSelectMode = false;
    let selectedMsgNums = new Set();
    let lastSelectedIndex = null;

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

    const addressBookBtn = document.getElementById('addressBookBtn');
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
    const yappSendQueuedBar = document.getElementById("yappSendQueuedBar");
    const yappSendProgressText = document.getElementById("yappSendProgressText");

    // Last shown percent/bytes to avoid excessive DOM updates
    let lastYappRecvPercent = -1;
    let lastYappSendPercent = -1;
    let lastYappSendQueuedPercent = -1;
    let lastYappSendConfirmedBytes = -1;
    let currentYappTotal = 0;
    let lastVaraBuffer = null;
    let yappSendCloseTimer = null;
    let yappSendCompleted = false;
    let yappSendReplyDetected = false;
    const YAPP_SEND_MODAL_CLOSE_DELAY_MS = 5000;
    const YAPP_SEND_MODAL_REPLY_CLOSE_DELAY_MS = 2500;

    window.electronAPI.onBbsPromptReady((ready) => {
        bbsPromptReady = Boolean(ready);
        if (bbsPromptReady) {
            console.log("BBS prompt synced from main process");
        }
    });

    const addCallsign = document.getElementById('addCallsign');
    const addName = document.getElementById('addName');
    const addAddress = document.getElementById('addAddress');
    const addHomeBBS = document.getElementById('addHomeBBS');
    const addNotes = document.getElementById('addNotes');

    const connectBtn = document.getElementById('connectBtn');
    const connectBbsBtn = document.getElementById('connectBbsBtn');
    const disconnectBbsBtn = document.getElementById('disconnectBbsBtn');

    const sendBtn = document.getElementById('sendBtn');
    const receiveBtn = document.getElementById('receiveBtn');
    const commandConsole = document.getElementById('commandConsole');
    const commandInput = document.getElementById('commandInput');
    const rxArea = document.getElementById('rxArea');
    const txInput = document.getElementById('txInput');

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

    const whitePagesModal = document.getElementById('whitePagesModal');
    const wpQuery = document.getElementById('wpQuery');
    const wpRunQueryBtn = document.getElementById('wpRunQueryBtn');
    const wpResults = document.getElementById('wpResults');
    const wpCancelBtn = document.getElementById('wpCancelBtn');
    const wpImportBtn = document.getElementById('wpImportBtn');

    const listPanel = document.getElementById("messageTabs");
    const bulletinTab = document.querySelector('.msg-tab[data-tab="bulletin"]');

    console.log("Loaded settings:", appSettings);

    document.getElementById("varaConsoleSection").style.display =
        appSettings.showVaraConsole ? "block" : "none";

    console.log("txInput:", txInput);

    const list = document.getElementById("messageList");
    list.setAttribute("tabindex", "0");

    list.addEventListener("keydown", async (ev) => {
        if (ev.key !== "Delete") return;
        ev.preventDefault();

        // MULTI-DELETE → move all selected to trash
        if (selectedMsgNums.size > 0) {
            bulkMoveSelectedToTrash();
            return;
        }

        // SINGLE DELETE → move selected row to trash
        const selectedRow = document.querySelector(".msg-row.selected");
        if (selectedRow) {
            const msgNum = selectedRow.dataset.msgnum;
            await window.electronAPI.moveMessageToFolder(msgNum, "trash");
            return;
        }

        window.showToast("No message selected");
    });

    function updateTime() {
        const now = new Date();

        // Format the time string (HH:MM:SS)
        const timeString = now.toLocaleTimeString([], {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        // Listen to VARA command-buffer reports and use them to visualize queued bytes
        window.electronAPI.onVaraBuffer((data) => {
            lastVaraBuffer = typeof data.buffer === 'number' ? data.buffer : null;
            // update queued bar immediately if send UI is visible
            const queuedBar = document.getElementById("yappSendQueuedBar");
            const text = document.getElementById("yappSendProgressText");
            if (!queuedBar || !currentYappTotal) return;
            const pct = Math.min(100, (lastVaraBuffer / currentYappTotal) * 100);
            requestAnimationFrame(() => {
                queuedBar.style.width = pct + "%";
                if (text) {
                    const queuedLabel = `${Math.floor(pct)}% queued`;
                    const confirmedLabel = currentYappTotal > 0 ? `${Math.floor((parseInt((text.innerText.split('\n')[0]) || 0)))} confirmed` : '';
                    text.innerText = `${confirmedLabel}\n${queuedLabel}`;
                }
            });
        });

        document.getElementById('clock').textContent = timeString;
    }

    // Update the clock immediately, then every 1 second
    updateTime();
    setInterval(updateTime, 1000);


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
        const list = document.getElementById("messageList");
        const rows = document.querySelectorAll(".msg-row");

        list.focus();

        rows.forEach((row, index) => {

            // LEFT CLICK = open message OR multi-select
            row.addEventListener("click", async (ev) => {
                const msgNum = row.dataset.msgnum;

                // --- MULTI-SELECT: SHIFT + CLICK (range select) ---
                if (ev.shiftKey && lastSelectedIndex !== null) {
                    const start = Math.min(lastSelectedIndex, index);
                    const end = Math.max(lastSelectedIndex, index);

                    for (let i = start; i <= end; i++) {
                        const r = rows[i];
                        r.classList.add("multi-selected");
                        selectedMsgNums.add(r.dataset.msgnum);
                    }
                    return;
                }

                // --- MULTI-SELECT: CTRL/CMD + CLICK (toggle) ---
                if (ev.ctrlKey || ev.metaKey) {
                    row.classList.toggle("multi-selected");

                    if (row.classList.contains("multi-selected"))
                        selectedMsgNums.add(msgNum);
                    else
                        selectedMsgNums.delete(msgNum);

                    lastSelectedIndex = index;
                    return;
                }

                // --- NORMAL CLICK (open message) ---
                selectedMsgNums.clear();
                rows.forEach(r => r.classList.remove("multi-selected"));

                rows.forEach(r => r.classList.remove("selected"));
                row.classList.add("selected");

                const id = row.dataset.id;
                console.log("Message clicked, id:", id);

                // Fetch full message from DB
                let msg = null;
                try {
                    msg = await window.electronAPI.getMessageById(id);
                    console.log("Fetched message:", msg.msgNum, "has body:", !!msg.body);
                } catch (err) {
                    console.error("Failed to load message", err);
                    return;
                }

                // Mark as read
                if (msg.read === 0) {
                    await window.electronAPI.markMessageRead(id);
                    msg.read = 1;
                }

                row.dataset.read = "1";

                currentDisplayedMsgNum = msg.msgNum;
                console.log("Set currentDisplayedMsgNum:", currentDisplayedMsgNum);

                // If body missing, fetch from BBS
                if (!msg.body || msg.body.trim() === "") {
                    console.log("Body missing, requesting from BBS:", msg.msgNum);
                    await ensureBbsConnected();
                    window.electronAPI.readMessage(msg.msgNum);
                }

                window.showToast(`Loading message #${msg.msgNum}…`);

                const viewer = document.getElementById("msgView");
                viewer.innerHTML = `<pre>${msg.body || "(Fetching message...)"}</pre>`;

                lastSelectedIndex = index;
            });

            // RIGHT CLICK = context menu
            row.addEventListener("contextmenu", async (ev) => {
                ev.preventDefault();

                // --- NORMAL RIGHT CLICK ---
                row.classList.add("context-active");

                const id = row.dataset.id;
                const msg = await window.electronAPI.getMessageById(id);

                showMessageContextMenu(row, msg, ev);
            });
        });
    }

    async function bulkMoveSelectedToTrash() {
        if (selectedMsgNums.size === 0) {
            window.showToast("No messages selected");
            return;
        }

        const nums = Array.from(selectedMsgNums);

        for (const msgNum of nums) {
            await window.electronAPI.moveMessageToFolder(msgNum, "trash");
        }

        window.showToast(`Moved ${nums.length} messages to Trash`);

        selectedMsgNums.clear();

        refreshCurrentTab();
    }

    function showMessageContextMenu(row, msg, ev) {
        const menu = document.createElement("div");
        menu.className = "msg-context-menu";

        const isTrash = msg.folder === "trash";
        const isArchive = msg.folder === "archive";

        // Determine if multi-select is active
        const multi = selectedMsgNums.size > 1;

        // Build menu HTML
        menu.innerHTML = `
        <div class="menu-item" data-action="open">Open</div>

        ${currentMessageTab === "private" || currentMessageTab === "archived" ? `
            <div class="menu-item" data-action="reply">Reply</div>` : ""}

        ${!isArchive && !isTrash ? `
            <div class="menu-item" data-action="archive">Move to Archive</div>` : ""}

        ${!isTrash ? `
            <div class="menu-item" data-action="delete">Move to Trash</div>` : `
            <div class="menu-item" data-action="restore">Restore from Trash</div>`}

        ${!isTrash ? `
            <div class="menu-item" data-action="download">Download Body${multi ? " (All Selected)" : ""}</div>
        ` : ""}

        <div class="menu-item" data-action="move1">Move to User1</div>
        <div class="menu-item" data-action="move2">Move to User2</div>

        ${currentMessageTab === "bulletin" ? `
            <div class="menu-item" data-action="filter-category">Filter by Category (${msg.recipient})</div>` : ""}

        ${currentMessageTab === "bulletin" ? `
            <div class="menu-item" data-action="filter-sender">Filter by Sender (${msg.sender})</div>` : ""}
        `;

        document.body.appendChild(menu);

        // Position under cursor first
        menu.style.left = ev.pageX + "px";
        menu.style.top = ev.pageY + "px";

        // After it's in the DOM, measure it
        const menuRect = menu.getBoundingClientRect();
        const viewportHeight = window.innerHeight;

        // If the menu would go off the bottom, slide it upward
        if (menuRect.bottom > viewportHeight) {
            const adjustedTop = ev.pageY - (menuRect.bottom - viewportHeight) - 10;
            menu.style.top = Math.max(10, adjustedTop) + "px";
        }

        function closeMenu() {
            menu.remove();
            row.classList.remove("context-active");
        }

        // Close on mouse leave
        menu.addEventListener("mouseleave", closeMenu);

        // Close on Escape
        function escHandler(ev) {
            if (ev.key === "Escape") {
                closeMenu();
                document.removeEventListener("keydown", escHandler);
            }
        }
        document.addEventListener("keydown", escHandler);

        // Close on outside click
        function outsideHandler(ev) {
            if (!menu.contains(ev.target)) {
                closeMenu();
                document.removeEventListener("click", outsideHandler);
            }
        }
        document.addEventListener("click", outsideHandler);

        // Handle menu actions
        menu.addEventListener("click", async (e) => {
            const action = e.target.dataset.action;
            if (!action) return;

            // Determine target messages
            const targets = multi
                ? Array.from(selectedMsgNums)
                : [msg.msgNum];

            // Helper to apply folder move to all targets
            async function moveAll(folder) {
                for (const num of targets) {
                    await window.electronAPI.moveMessageToFolder(num, folder);
                }
            }

            if (action === "open") {
                if (!multi) row.click();
                closeMenu();
                return;
            }

            if (action === "reply") {
                if (!multi) openReplyModal(msg);
                closeMenu();
                return;
            }

            if (action === "archive") {
                await moveAll("archive");
                closeMenu();
                return;
            }

            if (action === "delete") {
                await moveAll("trash");
                closeMenu();
                return;
            }

            if (action === "restore") {
                await moveAll("inbox");
                closeMenu();
                return;
            }

            if (action === "download") {
                const toDownload = [];

                for (const num of targets) {
                    // Fetch metadata for each message
                    const m = await window.electronAPI.getMessageByMsgNum(num);

                    // Only download if not already downloaded
                    if (m && m.downloaded === 0) {
                        toDownload.push(num);
                    }
                }

                if (toDownload.length > 0) {
                    window.electronAPI.queueBatchDownload(toDownload);
                    window.showToast(`Downloading ${toDownload.length} messages...`);
                } else {
                    window.showToast("All selected messages are already downloaded.");
                }

                closeMenu();
                return;
            }

            if (action === "move1") {
                await moveAll("user1");
                closeMenu();
                return;
            }

            if (action === "move2") {
                await moveAll("user2");
                closeMenu();
                return;
            }

            if (action === "filter-category") {
                currentBulletinFilter = { type: "category", value: msg.recipient };
                window.electronAPI.filterBulletins(msg.recipient);
                closeMenu();
                return;
            }

            if (action === "filter-sender") {
                currentBulletinFilter = { type: "sender", value: msg.sender };
                window.electronAPI.filterBulletinsSender(msg.sender);
                closeMenu();
                return;
            }

            closeMenu();
        });
    }

    function applyCurrentBulletinFilter() {
        console.log("Applying bulletin filter by category:", currentBulletinFilter.value);
        if (currentBulletinFilter.type === "category") {
            window.electronAPI.filterBulletins(currentBulletinFilter.value);
            return;
        }

        if (currentBulletinFilter.type === "sender") {
            window.electronAPI.filterBulletinsSender(currentBulletinFilter.value);
            return;
        }

        // Default: no filter
        currentBulletinFilter = { type: "none", value: null };
        renderMessageList();
    }

    async function renderMessageList(rows) {
        const list = document.getElementById("messageList");

        let messages = [];

        if (rows) {
            messages = rows;
        } else {
            try {
                messages = await window.electronAPI.getMessages();
            } catch (err) {
                console.error("Failed to load messages", err);
                return;
            }
        }

        // ⭐ Now you can use the flag safely
        let filtered = messages.filter(m => {

            if (currentMessageTab === "private") return m.folder === "inbox" && m.type === "private";
            if (currentMessageTab === "bulletin") return m.folder === "inbox" && m.type === "bulletin";
            if (currentMessageTab === "sent") return m.folder === "sent";
            if (currentMessageTab === "outbox") return m.folder === "outbox";
            if (currentMessageTab === "archived") return m.folder === "archive";
            if (currentMessageTab === "user1") return m.folder === "user1";
            if (currentMessageTab === "user2") return m.folder === "user2";



            return false;
        });

        // ⭐ Sort newest first
        filtered.sort((a, b) => (b.msgNum || 0) - (a.msgNum || 0));

        // ⭐ Apply message filters (unread, read, local, remote)
        filtered = filtered.filter(m => {
            switch (currentFilter) {
                case "unread": return m.read === 0;
                case "read": return m.read === 1;
                case "local": return m.folder !== "inbox";
                case "remote": return m.folder === "inbox";
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

    function refreshCurrentTab() {

        // ⭐ If we are in the bulletin tab AND a bulletin filter is active,
        //    reapply the bulletin filter instead of loading everything.
        if (currentMessageTab === "bulletin" &&
            currentBulletinFilter &&
            currentBulletinFilter.type !== "none") {

            console.log("Reapplying bulletin filter:", currentBulletinFilter);

            applyCurrentBulletinFilter();
            return;
        }

        // ⭐ Default: load all messages and let renderMessageList() filter by tab
        window.electronAPI.getMessages()
            .then(rows => {
                renderMessageList(rows);
            })
            .catch(err => {
                console.error("Failed to refresh current tab:", err);
            });
    }

    function updateMessageRow(msgNum) {
        const row = document.querySelector(`.msg-row[data-msgnum="${msgNum}"]`);
        if (!row) return;
        console.log("Updating message row for msgNum:", msgNum, "row found:", !!row);
        row.dataset.read = "1";     // update read state
    }

    function formatListRow(m) {
        const pad = (str, len) => (str + " ".repeat(len)).slice(0, len);
        const dflag = (m.downloaded === 1) ? "+" : " ";

        return [
            pad(m.msgNum.toString(), 5),
            pad(m.date, 6),
            pad(m.typeCode, 2),
            pad((m.size || 0).toString(), 5),
            pad(m.recipient, 7),
            pad(m.at, 7),
            pad(m.sender, 7),
            dflag + m.subject
        ].join(" ");
    }

    window.showToast = function (text) {
        const container = document.getElementById("toastContainer");

        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = text;

        container.appendChild(toast);

        // Animate in 10ms later to allow CSS transition
        setTimeout(() => toast.classList.add("visible"), 10);

        // Auto-remove after 2.5 seconds
        setTimeout(() => {
            toast.classList.remove("visible");
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    };

    window.electronAPI.onToast((text) => {
        window.showToast(text);
    });

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
                currentBulletinFilter = { type: "none", value: null };
                window.electronAPI.filterBulletins("ALL");
                modal.style.display = "none";
            };
            list.appendChild(allBtn);

            // Each category with count
            categories.forEach(cat => {
                const btn = document.createElement("button");
                btn.textContent = `${cat.category} (${cat.count})`;
                btn.onclick = () => {
                    currentBulletinFilter = { type: "category", value: cat.category };
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
        if (cmd.startsWith("L ") || cmd.startsWith("LB") || cmd.startsWith("LP")) {
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
        /*  listMineBtn.disabled = !connected;
            listBullBtn.disabled = !connected;
            listWxBtn.disabled = !connected;
            listNewBtn.disabled = !connected; */
        addressBookBtn.disabled = !connected;
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
        // Only update the viewer if this message is the currently displayed one
        if (msg.msgNum === currentDisplayedMsgNum) {
            const viewer = document.getElementById("msgView");
            console.log("Setting viewer innerHTML to:", `<pre>${msg.body}</pre>`);
            viewer.innerHTML = `<pre>${msg.body}</pre>`;
            console.log("Viewer innerHTML is now:", viewer.innerHTML);
        } else {
            console.log("Ignoring displayMessage for msgNum", msg.msgNum, "because current is", currentDisplayedMsgNum);
        }
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

    function initializePreferencesModal() {

        //
        // Load main settings
        //
        window.settings.get().then(s => {
            myCall.value = s.myCall || "";
            bbsCall.value = s.bbsCall || "";
            nodeCall.value = s.nodeCall || "";
            digi1.value = s.digi1 || "";
            digi2.value = s.digi2 || "";
            varaIP.value = s.varaIP || "";
            varaCmdPort.value = s.varaCmdPort || "";
            varaDataPort.value = s.varaDataPort || "";
            yappDirInput.value = s.yappReceiveDir || "";
        });

        //
        // Save button
        //
        saveBtn.addEventListener("click", async () => {
            await window.settings.set({
                myCall: myCall.value,
                bbsCall: bbsCall.value,
                nodeCall: nodeCall.value,
                digi1: digi1.value,
                digi2: digi2.value,
                varaIP: varaIP.value,
                varaCmdPort: Number(varaCmdPort.value),
                varaDataPort: Number(varaDataPort.value),
                yappReceiveDir: yappDirInput.value
            });

            closePreferencesModal();
        });

        //
        // YAPP directory picker
        //
        document.getElementById("yappDirButton").addEventListener("click", async () => {
            const dir = await window.electronAPI.pickDirectory();
            if (dir) {
                yappDirInput.value = dir;
                window.settings.saveSetting("yappReceiveDir", dir);
            }
        });

        //
        // Load bulletin categories + subscriptions
        //
        Promise.all([
            window.electronAPI.getBulletinCategories(),
            window.settings.getSetting("subscriptions")
        ]).then(([categories, subs]) => {
            subs = subs || [];
            const container = document.getElementById("subscriptionList");

            categories.forEach(cat => {
                const row = document.createElement("div");

                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.value = cat.category;
                checkbox.checked = subs.includes(cat.category);

                const label = document.createElement("label");
                label.textContent = `${cat.category} (${cat.count})`;

                row.appendChild(checkbox);
                row.appendChild(label);
                container.appendChild(row);
            });
        });

        //
        // Save subscriptions
        //
        document.getElementById("saveSubscriptionsBtn").addEventListener("click", async () => {
            const container = document.getElementById("subscriptionList");
            const selected = [...container.querySelectorAll("input[type=checkbox]:checked")]
                .map(cb => cb.value);

            await window.settings.saveSetting("subscriptions", selected);
    
            closePreferencesModal();

            window.showToast("Subscriptions saved");
        });
    }


    function closePreferencesModal() {
        document.getElementById("preferencesModal").style.display = "none";
    }



    function resetYappSendModal() {
        if (yappSendCloseTimer) {
            clearTimeout(yappSendCloseTimer);
            yappSendCloseTimer = null;
        }
        yappSendCompleted = false;
        yappSendReplyDetected = false;

        // Show file picker
        document.getElementById("yappPickerSection").style.display = "block";

        // Hide progress section
        document.getElementById("yappSendProgressSection").style.display = "none";

        // Reset progress bars
        document.getElementById("yappSendProgressBar").style.width = "0%";
        document.getElementById("yappSendQueuedBar").style.width = "0%";
        document.getElementById("yappSendProgressText").innerText = "0%";
        // Do NOT clear status text here - let it persist to show final message

        // Clear file path
        document.getElementById("yappModalSendFile").value = "";
        lastYappSendPercent = -1;
        lastYappSendQueuedPercent = -1;
    }

    function scheduleYappSendModalClose(delayMs) {
        if (yappSendCloseTimer) {
            clearTimeout(yappSendCloseTimer);
        }

        yappSendCloseTimer = setTimeout(() => {
            resetYappSendModal();
            document.getElementById("yappSendModal").style.display = "none";

            const toast = document.getElementById("yappToast");
            if (toast) {
                toast.innerText = "File sent successfully";
                toast.classList.add("show");
                setTimeout(() => toast.classList.remove("show"), 4000);
            } else {
                window.showToast("File sent successfully");
            }

            // Reset progress bar
            document.getElementById("yappSendProgressBar").style.width = "0%";
            document.getElementById("yappSendProgressText").innerText = "0%";
            yappSendCloseTimer = null;
        }, delayMs);
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
        lastYappRecvPercent = -1;
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

    window.electronAPI.onOpenPreferences(() => {
        const modal = document.getElementById("preferencesModal");
        const content = document.getElementById("preferencesContent");
        const template = document.getElementById("preferencesTemplate");

        content.innerHTML = template.innerHTML;

        modal.style.display = "flex";   // ← FIXED

        initializePreferencesModal();
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

    addressBookBtn.addEventListener('click', async () => {
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

    wpRunQueryBtn.addEventListener('click', async () => {
        const query = wpQuery.value.trim();
        console.log("Running WhitePages query:", query);
        if (!query) return;

        await ensureBbsConnected();
        window.electronAPI.startWhitePagesMode();

        wpResults.innerHTML = "Querying BBS...";

        await sendBbsCommand(query + "\r");
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
    window.electronAPI.onMessageBody(async (msg) => {
        console.log("🎯 onMessageBody EVENT RECEIVED:", msg);
        console.log("Renderer received message body:", msg.msgNum, "currentDisplayedMsgNum:", currentDisplayedMsgNum);

        if (msg.msgNum !== currentDisplayedMsgNum) {
            console.log("Ignoring body event for non-current message", msg.msgNum);
            return;
        }

        window.showToast(`Message #${msg.msgNum} downloaded`);
        updateMessageRow(msg.msgNum);

        let fullMsg = null;
        const start = Date.now();

        while (Date.now() - start < 10000) {
            fullMsg = await window.electronAPI.getMessageByMsgNum(msg.msgNum);
            if (fullMsg && fullMsg.body && fullMsg.body.trim() !== "") break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (fullMsg && fullMsg.body && fullMsg.body.trim() !== "") {
            displayMessage(fullMsg);
        } else {
            displayMessage(msg);
        }
    });

    window.electronAPI.onBulletinList(async (rows) => {
        await window.electronAPI.syncMessagesWithBbs("bulletin", rows);
        renderMessageList(rows);
    });

    /*     window.electronAPI.onPrivateList(async (rows) => {
            await window.electronAPI.syncMessagesWithBbs("private", rows);
            renderMessageList(rows);
        }); */

    // Refresh message list when messages are updated
    window.electronAPI.onMessageDeleted((msgNum) => {
        console.log("Message deleted, refreshing list:", msgNum);
        window.showToast(`Message #${msgNum} deleted`);
        applyCurrentBulletinFilter();
        //renderMessageList();
    });

    window.electronAPI.onTrashEmptied((count) => {
        window.showToast(`Trash emptied (${count} messages deleted)`);
        refreshCurrentTab();
    });

    // V.22 New event for when a message is moved to a different folder (e.g. archive, user1, user2)
    window.electronAPI.onMessageMoved(({ msgNum, folder }) => {
        window.showToast(`Message #${msgNum} moved to ${folder}`);
        refreshCurrentTab();
    });

    window.electronAPI.onMessageDownloaded((msgNum) => {
        console.log("Message downloaded, refreshing list:", msgNum);
        window.showToast(`Message #${msgNum} downloaded`);
        renderMessageList();
    });

    window.electronAPI.onMessageRead((id) => {
        console.log("Message marked as read, refreshing list:", id);
        updateMessageRow(id);
        //renderMessageList();
    });

    window.electronAPI.onMessagesReceived((data) => {
        console.log("Messages received, refreshing list:", data);
        window.showToast(`Received ${data.count} messages`);
        renderMessageList();
        //updateMessageRow(msg.msgNum);
    });

    window.electronAPI.onMenuItemClicked((label) => {
        if (label === "Filter by Category") {
            window.showCategoryPopup();
        }
    });

    // Clear the right-hand message pane
    window.electronAPI.onClearMessageView(() => {
        const body = document.getElementById("msgView");
        if (body) body.textContent = "";
    });

    // Append command output
    window.electronAPI.onCommandOutput((line) => {
        const body = document.getElementById("msgView");
        if (body) body.textContent += line + "\n";
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

            // Toast (guard in case element is missing)
            const toast = document.getElementById("yappToast");
            if (toast) {
                toast.innerText = "File received successfully";
                toast.classList.add("show");
                setTimeout(() => toast.classList.remove("show"), 4000);
            } else {
                window.showToast("File received successfully");
            }

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
        yappSendCompleted = false;
        yappSendReplyDetected = false;
        
        console.log("Starting YAPP send for file:", filePath);

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
    window.electronAPI.onYappRecvProgress(({ received, total, percent }) => {
        const display = Math.max(0, Math.min(100, Number.isFinite(percent) ? Math.floor(percent) : 0));
        if (display === lastYappRecvPercent) return;
        lastYappRecvPercent = display;

        const pct = `${display}%`;

        // Ensure modal/section are visible (some flows close the picker)
        const modal = document.getElementById("yappReceiveModal");
        const section = document.getElementById("yappRecvProgressSection");
        const fileList = document.getElementById("yappFileListSection");
        if (modal) modal.style.display = "flex";
        if (section) section.style.display = "block";
        if (fileList) fileList.style.display = "none";

        const bar = document.getElementById("yappRecvProgressBar");
        const text = document.getElementById("yappRecvProgressText");

        if (bar) {
            bar.style.width = pct;
            bar.style.minWidth = display > 0 ? "2%" : "0%"; // make very small progress visible
            bar.style.background = bar.style.background || "#4caf50";
        }
        if (text) {
            text.innerText = pct;
            // Force readable color in case stylesheet makes it invisible
            text.style.color = "#111";
        }
    });

    window.electronAPI.onYappSendProgress((data) => {
        const total = data.total || 0;
        if (total > 0) currentYappTotal = total;
        const queued = typeof data.queued === 'number' ? data.queued : (data.sent || 0);
        const confirmed = typeof data.confirmed === 'number' ? data.confirmed : (data.sent || 0);

        const pctQueued = total > 0 ? (queued / total) * 100 : 0;
        const pctConfirmed = total > 0 ? (confirmed / total) * 100 : 0;
        const widthQueued = total > 0 ? Math.min(100, pctQueued) : 0;
        const widthConfirmed = total > 0 ? Math.min(100, pctConfirmed) : 0;

        const displayQueued = total > 0 ? Math.floor(pctQueued) : 0;
        const displayConfirmed = total > 0 ? Math.floor(pctConfirmed) : 0;
        if (confirmed === lastYappSendConfirmedBytes && displayQueued === lastYappSendQueuedPercent) return;
        lastYappSendConfirmedBytes = confirmed;
        lastYappSendPercent = displayConfirmed;
        lastYappSendQueuedPercent = displayQueued;

        const modal = document.getElementById("yappSendModal");
        const section = document.getElementById("yappSendProgressSection");
        const picker = document.getElementById("yappPickerSection");
        if (modal) modal.style.display = "flex";
        if (section) section.style.display = "block";
        if (picker) picker.style.display = "none";

        const queuedBar = document.getElementById("yappSendQueuedBar");
        const bar = document.getElementById("yappSendProgressBar");
        const text = document.getElementById("yappSendProgressText");

        // Apply DOM updates inside rAF to avoid blocking paints
        requestAnimationFrame(() => {
            // If we have a BUFFER reading from the modem, prefer it for queued visualization
            const effectiveQueuedPct = (lastVaraBuffer !== null && currentYappTotal > 0)
                ? Math.min(100, (lastVaraBuffer / currentYappTotal) * 100)
                : widthQueued;
            if (queuedBar) {
                queuedBar.style.width = effectiveQueuedPct + "%";
                queuedBar.style.background = queuedBar.style.background || "#b7e5b7";
            }
            if (bar) {
                bar.style.width = widthConfirmed + "%";
                bar.style.background = bar.style.background || "#4caf50";
            }
            if (text) {
                const confirmedLabel = total > 0
                    ? `${confirmed}/${total} bytes confirmed`
                    : `${confirmed} bytes confirmed`;
                const queuedLabel = total > 0
                    ? `${displayQueued}% queued`
                    : `${queued} bytes queued`;
                text.innerText = `${confirmedLabel}\n${queuedLabel}`;
                text.style.color = "#111";
            }
        });
    });

    window.electronAPI.onYappSendStatus((message) => {
        const statusElement = document.getElementById("yappSendStatusText");
        if (statusElement) {
            statusElement.innerText = message;
            statusElement.style.display = message ? "block" : "none";
        }

        if (/Yapp file .+received/i.test(message || "")) {
            yappSendReplyDetected = true;
            if (yappSendCompleted) {
                scheduleYappSendModalClose(YAPP_SEND_MODAL_REPLY_CLOSE_DELAY_MS);
            }
        }
    });

    // ------------------------------------------------------------
    // SEND COMPLETE
    // ------------------------------------------------------------
    window.electronAPI.onYappSendComplete(() => {
        yappSendCompleted = true;
        scheduleYappSendModalClose(
            yappSendReplyDetected
                ? YAPP_SEND_MODAL_REPLY_CLOSE_DELAY_MS
                : YAPP_SEND_MODAL_CLOSE_DELAY_MS
        );
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

        if (line.includes("socket closed") ||
            line.includes("Connection closed") ||
            line.includes("Disconnected from VARA") ||
            line.includes("TCP link lost") ||
            line.includes("VARA closed")
        ) {
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
    // Connect button for VARA TCP connection
    connectBtn.addEventListener('click', async () => {
        try {
            await window.vara.connect();
            appendCommand('info', 'Connect requested');
        } catch (err) {
            appendCommand('error', 'Connect failed: ' + err.message);
        }
    });

    // Vara Command input (Enter to send)
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
        // console.log("Key Pressed:", e.key);

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
    // Disconnect button for VARA TCP connection
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

    if (bulletinTab) {
        currentBulletinFilter = { type: "none", value: null };
        bulletinTab.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            showCategoryPopup();
        });
    }

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

    window.electronAPI.onComposeFromForm(async (payload) => {
        isReplyMode = false;

        const safePayload = payload || {};
        await openComposeModal({ to: (safePayload.to || "").trim() });

        composeType.value = safePayload.type || "P";
        composeSubject.value = safePayload.subject || "";
        composeBody.value = safePayload.body || "";
        composeBody.focus();
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
        composeTo.value = "";
        composeSubject.value = "";
        composeBody.value = "";
        composeType.value = "P";
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

    // ------------------------------------------------------------
    // COMPOSE SEND/CANCEL BUTTONS
    // ------------------------------------------------------------
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

        /*         await saveMessage({
                    msgNum,
                    type,
                    recipient,
                    sender,
                    subject,
                    body
                }); */

        appendCommand('local', 'TX: Sending message');

        try {
            await window.electronAPI.saveMessage({
                msgNum,
                type,
                recipient,
                sender,
                subject,
                body
            });

            await window.electronAPI.sendBbsMessage({
                msgNum,
                type,
                recipient,
                sender,
                subject,
                body
            });

            // reset compose form and close modal
            composeModal.style.display = "none";
            composeTo.value = "";
            composeSubject.value = "";
            composeBody.value = "";
            composeType.value = "P";
        } catch (err) {
            appendCommand('error', 'Send message failed: ' + err.message);
        }

        composeModal.style.display = "none";
    });
    // ------------------------------------------------------------
    // Save to outbox without sending
    // ------------------------------------------------------------
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
        // reset compose form and close modal
        composeModal.style.display = "none";
        composeTo.value = "";
        composeSubject.value = "";
        composeBody.value = "";
        composeType.value = "P";
        composeModal.style.display = "none";
    });

    // Initialize message list with private messages
    renderMessageList();

    // Auto-connect to the VARA modem on startup
    try {
        await window.vara.connect();
        appendCommand('info', 'VARA modem connected on startup');
    } catch (err) {
        appendCommand('error', 'VARA modem auto-connect failed: ' + err.message);
    }

});
console.log("RENDERER LOADED");
