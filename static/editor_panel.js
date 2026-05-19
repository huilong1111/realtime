import { logout, redirectToLogin, redirectToRegister } from "/static/auth.js";

const leaveDocButton = document.getElementById("leaveDocButton");
const copyLinkButton = document.getElementById("copyLinkButton");
const connectionStatus = document.getElementById("connectionStatus");
const authStatusText = document.getElementById("authStatusText");
const authActions = document.getElementById("authActions");
const permissionSummary = document.getElementById("permissionSummary");
const permissionMeta = document.getElementById("permissionMeta");
const ownerPermissionPanel = document.getElementById("ownerPermissionPanel");
const publicEditableToggle = document.getElementById("publicEditableToggle");
const addEditorForm = document.getElementById("addEditorForm");
const editorUsernameInput = document.getElementById("editorUsernameInput");
const permissionMessage = document.getElementById("permissionMessage");
const editorList = document.getElementById("editorList");
const deleteDocumentButton = document.getElementById("deleteDocumentButton");
const infoSidebarDetails = document.getElementById("infoSidebarDetails");
const sidebarSummaryTitle = document.getElementById("sidebarSummaryTitle");

function buildConnectionLabel(state, canEdit, recovered) {
    if (state === "connected") {
        if (canEdit) {
            return recovered ? "连接已恢复" : "实时连接";
        }
        return recovered ? "只读连接已恢复" : "只读连接";
    }

    if (state === "reconnecting") {
        return navigator.onLine ? "断线重连中..." : "网络已断开，等待恢复";
    }

    if (state === "disconnected") {
        return "连接已断开";
    }

    return "连接中...";
}

async function requestJson(url, options = {}, fallbackMessage = "请求失败") {
    const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.detail || fallbackMessage);
    }

    return data;
}

async function fetchDocumentPermission(docId) {
    return requestJson(
        `/api/documents/${encodeURIComponent(docId)}/permissions`,
        {},
        "获取文档权限失败"
    );
}

async function updatePublicEditable(docId, isPublicEditable) {
    return requestJson(
        `/api/documents/${encodeURIComponent(docId)}/permissions/public`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                is_public_editable: isPublicEditable,
            }),
        },
        "更新文档权限失败"
    );
}

async function createEditorPermission(docId, username) {
    return requestJson(
        `/api/documents/${encodeURIComponent(docId)}/permissions/editors`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ username }),
        },
        "添加可编辑用户失败"
    );
}

async function deleteEditorPermission(docId, username) {
    return requestJson(
        `/api/documents/${encodeURIComponent(docId)}/permissions/editors/${encodeURIComponent(username)}`,
        {
            method: "DELETE",
        },
        "移除可编辑用户失败"
    );
}

async function deleteDocumentRequest(docId) {
    return requestJson(
        `/api/documents/${encodeURIComponent(docId)}`,
        {
            method: "DELETE",
        },
        "删除文档失败"
    );
}

/**
 * 右侧折叠区单独抽成一个模块
 */
export function createEditorPanel({ onLeaveDocument, onPermissionChange, onDeleteDocument }) {
    const state = {
        activeDocId: null,
        currentPermission: null,
        isMobileSidebarLayout: null,
    };

    function syncInfoSidebarTitle(docId) {
        if (sidebarSummaryTitle) {
            sidebarSummaryTitle.textContent = `文档 ${docId}`;
        }
    }

    /**
     * 移动端默认折叠信息区，桌面端默认展开
     */
    function applyResponsiveState(force = false) {
        if (!infoSidebarDetails) {
            return;
        }

        const isMobile = window.matchMedia("(max-width: 768px)").matches;
        if (!force && state.isMobileSidebarLayout === isMobile) {
            return;
        }

        state.isMobileSidebarLayout = isMobile;
        infoSidebarDetails.open = !isMobile;
    }

    function setPermissionMessage(message = "") {
        if (permissionMessage) {
            permissionMessage.textContent = message;
        }
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
            editorList.innerHTML = '<p class="permission-empty">还没有额外授权的可编辑用户</p>';
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
                setPermissionMessage("");
                try {
                    const permissionState = await deleteEditorPermission(state.activeDocId, username);
                    onPermissionChange(permissionState);
                } catch (error) {
                    setPermissionMessage(error.message);
                }
            });

            editorList.appendChild(item);
        });
    }

    function renderPermissionState(permission) {
        state.currentPermission = permission;
        permissionSummary.textContent = permission.is_owner
            ? "你是该文档创建者，可以在这里管理编辑权限"
            : permission.can_edit
                ? "你当前拥有此文档的编辑权限"
                : "你当前只能查看这份文档内容";

        renderPermissionMeta(permission);
        ownerPermissionPanel.classList.toggle("is-hidden", !permission.is_owner);
        publicEditableToggle.checked = Boolean(permission.is_public_editable);
        setPermissionMessage("");
        renderEditorList(permission);
    }

    function updateConnectionStatus(stateName, { canEdit, recovered = false } = {}) {
        connectionStatus.textContent = buildConnectionLabel(stateName, canEdit, recovered);
        connectionStatus.classList.toggle("is-offline", stateName === "disconnected");
        connectionStatus.classList.toggle(
            "is-warning",
            stateName === "connecting" || stateName === "reconnecting"
        );
    }

    function renderAuthState(currentUser, { loadFailed = false } = {}) {
        authActions.innerHTML = "";

        if (loadFailed) {
            authStatusText.textContent = "登录状态获取失败，请稍后刷新重试";
            return;
        }

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

        authStatusText.textContent = "当前为游客浏览模式";

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

    function setDocId(docId) {
        state.activeDocId = docId;
        syncInfoSidebarTitle(docId);
    }

    function showPermissionError(message) {
        permissionSummary.textContent = message;
    }

    copyLinkButton.addEventListener("click", async () => {
        if (!state.activeDocId) {
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

    leaveDocButton.addEventListener("click", () => {
        onLeaveDocument();
    });

    publicEditableToggle.addEventListener("change", async () => {
        setPermissionMessage("");
        try {
            const permission = await updatePublicEditable(
                state.activeDocId,
                publicEditableToggle.checked
            );
            onPermissionChange(permission);
        } catch (error) {
            setPermissionMessage(error.message);
            publicEditableToggle.checked = !publicEditableToggle.checked;
        }
    });

    addEditorForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setPermissionMessage("");

        const username = editorUsernameInput.value.trim();
        if (!username) {
            setPermissionMessage("请输入要授权的用户名。");
            return;
        }

        try {
            const permission = await createEditorPermission(state.activeDocId, username);
            editorUsernameInput.value = "";
            onPermissionChange(permission);
        } catch (error) {
            setPermissionMessage(error.message);
        }
    });

    deleteDocumentButton.addEventListener("click", async () => {
        if (!state.activeDocId || !state.currentPermission?.is_owner) {
            return;
        }

        const confirmed = window.confirm("确定删除这个文档吗？删除后将无法恢复。");
        if (!confirmed) {
            return;
        }

        setPermissionMessage("");
        deleteDocumentButton.disabled = true;

        try {
            await deleteDocumentRequest(state.activeDocId);
            onDeleteDocument();
        } catch (error) {
            setPermissionMessage(error.message);
        } finally {
            deleteDocumentButton.disabled = false;
        }
    });

    window.addEventListener("resize", applyResponsiveState);

    return {
        applyResponsiveState,
        fetchDocumentPermission,
        renderAuthState,
        renderPermissionState,
        setDocId,
        setPermissionMessage,
        showPermissionError,
        updateConnectionStatus,
        destroy() {
            window.removeEventListener("resize", applyResponsiveState);
        },
    };
}
