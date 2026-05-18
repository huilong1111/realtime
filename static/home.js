import { fetchCurrentUser, logout, redirectToLogin, redirectToRegister } from "/static/auth.js";

const entryForm = document.getElementById("entryForm");
const docIdInput = document.getElementById("docIdInput");
const createDocButton = document.getElementById("createDocButton");
const roomList = document.getElementById("roomList");
const roomListState = document.getElementById("roomListState");
const authStatusText = document.getElementById("authStatusText");
const authActions = document.getElementById("authActions");

const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let currentUser = null;

function normalizeDocId(value) {
    return value.trim();
}

function isValidDocId(docId) {
    return DOC_ID_PATTERN.test(docId);
}

function createDocId() {
    return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function goToDocument(docId) {
    window.location.href = `/doc/${encodeURIComponent(docId)}`;
}

function formatUpdatedAt(value) {
    if (!value) {
        return "暂无更新时间";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "更新时间未知";
    }

    return date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function renderRoomList(documents) {
    roomList.innerHTML = "";

    if (documents.length === 0) {
        roomListState.textContent = "还没有可进入的房间。";
        roomListState.classList.remove("is-hidden");
        return;
    }

    roomListState.classList.add("is-hidden");

    documents.forEach((documentItem) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "room-item";
        button.innerHTML = `
            <span class="room-item__name">${documentItem.doc_id}</span>
            <span class="room-item__time">最近更新：${formatUpdatedAt(documentItem.updated_at)}</span>
        `;
        button.addEventListener("click", () => {
            goToDocument(documentItem.doc_id);
        });
        roomList.appendChild(button);
    });
}

async function loadDocuments() {
    try {
        const response = await fetch("/api/documents");
        if (!response.ok) {
            throw new Error("Failed to fetch documents");
        }

        const documents = await response.json();
        renderRoomList(documents);
    } catch (_error) {
        roomListState.textContent = "房间列表加载失败，请稍后刷新重试。";
        roomListState.classList.remove("is-hidden");
    }
}

/**
 * 首页把登录状态单独展示出来，方便用户知道自己当前能否创建文档，
 * 以及文档的默认权限模型。
 */
function renderAuthPanel() {
    authActions.innerHTML = "";

    if (currentUser) {
        authStatusText.textContent = `当前用户：${currentUser.username}`;

        const logoutButton = document.createElement("button");
        logoutButton.type = "button";
        logoutButton.className = "ghost-button";
        logoutButton.textContent = "退出登录";
        logoutButton.addEventListener("click", async () => {
            await logout();
            window.location.reload();
        });
        authActions.appendChild(logoutButton);
        return;
    }

    authStatusText.textContent = "当前以游客身份浏览，可查看文档。";

    const loginButton = document.createElement("button");
    loginButton.type = "button";
    loginButton.className = "ghost-button";
    loginButton.textContent = "登录";
    loginButton.addEventListener("click", () => {
        redirectToLogin("/");
    });

    const registerButton = document.createElement("button");
    registerButton.type = "button";
    registerButton.className = "secondary-button";
    registerButton.textContent = "注册";
    registerButton.addEventListener("click", () => {
        redirectToRegister("/");
    });

    authActions.append(loginButton, registerButton);
}

async function loadCurrentUser() {
    try {
        currentUser = await fetchCurrentUser();
    } catch (_error) {
        currentUser = null;
        authStatusText.textContent = "登录状态获取失败，请稍后刷新重试。";
        return;
    }

    renderAuthPanel();
}

entryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const docId = normalizeDocId(docIdInput.value);

    if (!isValidDocId(docId)) {
        docIdInput.focus();
        docIdInput.setCustomValidity("请输入合法文档号：仅支持字母、数字、下划线和短横线。");
        docIdInput.reportValidity();
        return;
    }

    docIdInput.setCustomValidity("");
    goToDocument(docId);
});

docIdInput.addEventListener("input", () => {
    docIdInput.setCustomValidity("");
});

createDocButton.addEventListener("click", () => {
    const docId = createDocId();
    if (!currentUser) {
        redirectToLogin(`/doc/${encodeURIComponent(docId)}`);
        return;
    }
    goToDocument(docId);
});

await loadCurrentUser();
loadDocuments();
