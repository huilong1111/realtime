import { fetchCurrentUser, logout, redirectToLogin, redirectToRegister } from "/static/auth.js";
import {
    createCollaborativeSession,
    destroyCollaborativeSession,
} from "/static/collaboration.js";

const leaveDocButton = document.getElementById("leaveDocButton");
const copyLinkButton = document.getElementById("copyLinkButton");
const connectionStatus = document.getElementById("connectionStatus");
const editorElement = document.getElementById("editor");
const toolbar = document.getElementById("editorToolbar");
const authStatusText = document.getElementById("authStatusText");
const authActions = document.getElementById("authActions");
const readonlyBanner = document.getElementById("readonlyBanner");
const permissionSummary = document.getElementById("permissionSummary");
const permissionMeta = document.getElementById("permissionMeta");
const ownerPermissionPanel = document.getElementById("ownerPermissionPanel");
const publicEditableToggle = document.getElementById("publicEditableToggle");
const addEditorForm = document.getElementById("addEditorForm");
const editorUsernameInput = document.getElementById("editorUsernameInput");
const permissionMessage = document.getElementById("permissionMessage");
const editorList = document.getElementById("editorList");
const infoSidebarDetails = document.getElementById("infoSidebarDetails");
const sidebarSummaryTitle = document.getElementById("sidebarSummaryTitle");

const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let activeDocId = null;
let currentUser = null;
let currentPermission = null;
let currentConnectionState = "connecting";
let collaborationSession = null;
let isMobileSidebarLayout = null;

function isValidDocId(docId) {
    return DOC_ID_PATTERN.test(docId);
}

function getDocIdFromPath() {
    const match = window.location.pathname.match(/^\/doc\/([A-Za-z0-9_-]{1,64})$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function goHome() {
    window.location.href = "/";
}

function syncInfoSidebarTitle(docId) {
    if (sidebarSummaryTitle) {
        sidebarSummaryTitle.textContent = `文档 ${docId}`;
    }
}

/**
 * 移动端默认折叠信息区
 */
function applyInfoSidebarDefaultState(force = false) {
    if (!infoSidebarDetails) {
        return;
    }

    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    if (!force && isMobileSidebarLayout === isMobile) {
        return;
    }

    isMobileSidebarLayout = isMobile;

    if (isMobile) {
        infoSidebarDetails.open = false;
    } else {
        infoSidebarDetails.open = true;
    }
}

async function fetchDocumentPermission(docId) {
    const response = await fetch(`/api/documents/${encodeURIComponent(docId)}/permissions`, {
        credentials: "same-origin",
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.detail || "获取文档权限失败");
    }

    return data;
}

async function updatePublicEditable(docId, isPublicEditable) {
    const response = await fetch(`/api/documents/${encodeURIComponent(docId)}/permissions/public`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
            is_public_editable: isPublicEditable,
        }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.detail || "更新文档权限失败");
    }

    return data;
}

async function createEditorPermission(docId, username) {
    const response = await fetch(`/api/documents/${encodeURIComponent(docId)}/permissions/editors`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ username }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.detail || "添加可编辑用户失败");
    }

    return data;
}

async function deleteEditorPermission(docId, username) {
    const response = await fetch(
        `/api/documents/${encodeURIComponent(docId)}/permissions/editors/${encodeURIComponent(username)}`,
        {
            method: "DELETE",
            credentials: "same-origin",
        }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.detail || "移除可编辑用户失败");
    }

    return data;
}


function updateStatus(state, recovered = false) {
    currentConnectionState = state;

    let label = "连接中...";
    if (state === "connected") {
        if (currentPermission?.can_edit) {
            label = recovered ? "连接已恢复" : "实时连接";
        } else {
            label = recovered ? "只读连接已恢复" : "只读连接";
        }
    } else if (state === "reconnecting") {
        label = navigator.onLine ? "断线重连中..." : "网络已断开，等待恢复";
    } else if (state === "disconnected") {
        label = "连接已断开";
    }

    connectionStatus.textContent = label;
    connectionStatus.classList.toggle("is-offline", state === "disconnected");
    connectionStatus.classList.toggle("is-warning", state === "connecting" || state === "reconnecting");
}

function getToolbarButtons() {
    return toolbar.querySelectorAll("[data-action]");
}

/**
 * 根据当前 TipTap 状态刷新工具栏
 */
function updateToolbarState() {
    if (!collaborationSession?.editor || !toolbar) {
        return;
    }

    const buttons = getToolbarButtons();
    buttons.forEach((button) => {
        const action = button.dataset.action;
        let isActive = false;
        const editor = collaborationSession.editor;

        if (action === "paragraph") {
            isActive = editor.isActive("paragraph");
        } else if (action === "heading-1") {
            isActive = editor.isActive("heading", { level: 1 });
        } else if (action === "heading-2") {
            isActive = editor.isActive("heading", { level: 2 });
        } else if (action === "bold") {
            isActive = editor.isActive("bold");
        } else if (action === "italic") {
            isActive = editor.isActive("italic");
        } else if (action === "bullet-list") {
            isActive = editor.isActive("bulletList");
        } else if (action === "ordered-list") {
            isActive = editor.isActive("orderedList");
        }

        button.classList.toggle("is-active", isActive);
    });
}

/**
 * 文档是否只读
 */
function applyReadOnlyMode(isReadOnly) {
    if (readonlyBanner) {
        readonlyBanner.classList.toggle("is-hidden", !isReadOnly);
    }

    if (collaborationSession?.editor) {
        collaborationSession.editor.setEditable(!isReadOnly);
    }

    getToolbarButtons().forEach((button) => {
        button.disabled = isReadOnly;
    });

    toolbar.classList.toggle("is-readonly", isReadOnly);
}

/**
 * 显示当前用户状态
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

    authStatusText.textContent = "当前为游客浏览模式。你可以查看文档";

    const loginButton = document.createElement("button");
    loginButton.type = "button";
    loginButton.className = "ghost-button";
    loginButton.textContent = "登录";
    loginButton.addEventListener("click", () => {
        redirectToLogin(window.location.pathname);
    });

    const registerButton = document.createElement("button");
    registerButton.type = "button";
    registerButton.className = "secondary-button";
    registerButton.textContent = "注册";
    registerButton.addEventListener("click", () => {
        redirectToRegister(window.location.pathname);
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

function renderPermissionMeta(permission) {
    permissionMeta.innerHTML = `
        <span class="permission-chip">创建者：${permission.owner_username || "暂未创建"}</span>
        <span class="permission-chip">当前可编辑：${permission.can_edit ? "是" : "否"}</span>
    `;
}

function renderEditorList(permission) {
    editorList.innerHTML = "";
    if (!permission.is_owner) {
        return;
    }

    if (!permission.editors || permission.editors.length === 0) {
        editorList.innerHTML = `<p class="permission-empty">还没有额外授权的可编辑用户。</p>`;
        return;
    }

    permission.editors.forEach((username) => {
        const item = document.createElement("div");
        item.className = "permission-editor-item";
        item.innerHTML = `
            <span>${username}</span>
            <button class="ghost-button permission-remove-button" type="button">移除</button>
        `;

        item.querySelector("button").addEventListener("click", async () => {
            permissionMessage.textContent = "";
            try {
                currentPermission = await deleteEditorPermission(activeDocId, username);
                renderPermissionSection(currentPermission);
            } catch (error) {
                permissionMessage.textContent = error.message;
            }
        });

        editorList.appendChild(item);
    });
}

/**
 * 权限设置区只对创建者开放修改能力
 */
function renderPermissionSection(permission) {
    currentPermission = permission;
    permissionSummary.textContent = permission.is_owner
        ? "你是该文档创建者，可以在这里管理编辑权限。"
        : permission.can_edit
            ? "你当前拥有此文档的编辑权限。"
            : "你当前只能查看这份文档内容。";

    renderPermissionMeta(permission);
    ownerPermissionPanel.classList.toggle("is-hidden", !permission.is_owner);
    publicEditableToggle.checked = Boolean(permission.is_public_editable);
    renderEditorList(permission);
    applyReadOnlyMode(!permission.can_edit);
}

/**
 * 工具栏命令
 */
function bindToolbarEvents() {
    toolbar.addEventListener("click", (event) => {
        const button = event.target.closest("[data-action]");
        if (!button || !collaborationSession?.editor || button.disabled) {
            return;
        }

        const action = button.dataset.action;
        const chain = collaborationSession.editor.chain().focus();

        if (action === "paragraph") {
            chain.setParagraph().run();
        } else if (action === "heading-1") {
            chain.toggleHeading({ level: 1 }).run();
        } else if (action === "heading-2") {
            chain.toggleHeading({ level: 2 }).run();
        } else if (action === "bold") {
            chain.toggleBold().run();
        } else if (action === "italic") {
            chain.toggleItalic().run();
        } else if (action === "bullet-list") {
            chain.toggleBulletList().run();
        } else if (action === "ordered-list") {
            chain.toggleOrderedList().run();
        }

        updateToolbarState();
    });
}

/**
 * 页面入口只负责把已知上下文交给协同模块，不再直接处理 provider / awareness 细节。
 */
function createEditorSession(docId) {
    collaborationSession = createCollaborativeSession({
        docId,
        canEdit: Boolean(currentPermission?.can_edit),
        currentUser,
        editorElement,
        onStatusChange: updateStatus,
        onToolbarStateChange: updateToolbarState,
        setEditable: (canEdit) => applyReadOnlyMode(!canEdit),
        getToolbarButtons,
    });
}

function disconnectCurrentRoom() {
    destroyCollaborativeSession(collaborationSession);
    collaborationSession = null;
    activeDocId = null;
}

function leaveDocument() {
    disconnectCurrentRoom();
    goHome();
}

/**
 * 建立文档页所需的页面状态，再交给协同模块初始化 TipTap + Yjs。
 */
async function connectToDocument(docId) {
    if (!isValidDocId(docId)) {
        goHome();
        return;
    }

    await loadCurrentUser();

    activeDocId = docId;
    syncInfoSidebarTitle(docId);
    document.title = `实时文档 - ${docId}`;
    updateStatus("connecting");

    currentPermission = await fetchDocumentPermission(docId);
    renderPermissionSection(currentPermission);
    createEditorSession(docId);
}

copyLinkButton.addEventListener("click", async () => {
    if (!activeDocId) {
        return;
    }

    const link = window.location.href;

    try {
        await navigator.clipboard.writeText(link);
        copyLinkButton.textContent = "已复制";
        window.setTimeout(() => {
            copyLinkButton.textContent = "复制邀请链接";
        }, 1500);
    } catch (_error) {
        copyLinkButton.textContent = "复制失败";
        window.setTimeout(() => {
            copyLinkButton.textContent = "复制邀请链接";
        }, 1500);
    }
});

publicEditableToggle.addEventListener("change", async () => {
    permissionMessage.textContent = "";
    try {
        currentPermission = await updatePublicEditable(activeDocId, publicEditableToggle.checked);
        renderPermissionSection(currentPermission);
    } catch (error) {
        permissionMessage.textContent = error.message;
        publicEditableToggle.checked = !publicEditableToggle.checked;
    }
});

addEditorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    permissionMessage.textContent = "";

    const username = editorUsernameInput.value.trim();
    if (!username) {
        permissionMessage.textContent = "请输入要授权的用户名。";
        return;
    }

    try {
        currentPermission = await createEditorPermission(activeDocId, username);
        editorUsernameInput.value = "";
        renderPermissionSection(currentPermission);
    } catch (error) {
        permissionMessage.textContent = error.message;
    }
});

leaveDocButton.addEventListener("click", () => {
    leaveDocument();
});

window.addEventListener("beforeunload", () => {
    disconnectCurrentRoom();
});

bindToolbarEvents();
applyInfoSidebarDefaultState(true);
window.addEventListener("resize", applyInfoSidebarDefaultState);

const initialDocId = getDocIdFromPath();

if (initialDocId) {
    connectToDocument(initialDocId).catch((error) => {
        updateStatus("disconnected");
        permissionSummary.textContent = error.message || "文档初始化失败";
    });
} else {
    goHome();
}
