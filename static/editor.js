import { fetchCurrentUser } from "/static/auth.js";
import {
    createCollaborativeSession,
    destroyCollaborativeSession,
} from "/static/collaboration.js";
import { createEditorPanel } from "/static/editor_panel.js";

const editorElement = document.getElementById("editor");
const toolbar = document.getElementById("editorToolbar");
const readonlyBanner = document.getElementById("readonlyBanner");
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let activeDocId = null;
let currentUser = null;
let currentPermission = null;
let currentConnectionState = "connecting";
let collaborationSession = null;

const editorPanel = createEditorPanel({
    onLeaveDocument: leaveDocument,
    onDeleteDocument: handleDocumentDeleted,
    onPermissionChange: handlePermissionChange,
});

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

function getToolbarButtons() {
    return toolbar.querySelectorAll("[data-action]");
}

/**
 * 根据当前 TipTap 状态刷新工具栏高亮。
 */
function updateToolbarState() {
    if (!collaborationSession?.editor || !toolbar) {
        return;
    }

    const editor = collaborationSession.editor;
    getToolbarButtons().forEach((button) => {
        const action = button.dataset.action;
        let isActive = false;

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
 * 编辑器本体的只读切换。
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

function updateStatus(state, recovered = false) {
    currentConnectionState = state;
    editorPanel.updateConnectionStatus(state, {
        canEdit: Boolean(currentPermission?.can_edit),
        recovered,
    });
}

/**
 * 权限变化时同步更新右侧面板和编辑器可编辑状态。
 */
function handlePermissionChange(permission) {
    currentPermission = permission;
    editorPanel.renderPermissionState(permission);
    applyReadOnlyMode(!permission.can_edit);
    editorPanel.updateConnectionStatus(currentConnectionState, {
        canEdit: Boolean(permission.can_edit),
        recovered: currentConnectionState === "connected",
    });
}

/**
 * 工具栏命令绑定。
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
 * 页面入口只负责把已知上下文交给协同模块，不直接处理 provider / awareness 细节。
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

function handleDocumentDeleted() {
    disconnectCurrentRoom();
    goHome();
}

async function loadCurrentUser() {
    try {
        currentUser = await fetchCurrentUser();
        editorPanel.renderAuthState(currentUser);
    } catch (_error) {
        currentUser = null;
        editorPanel.renderAuthState(null, {
            loadFailed: true,
        });
    }

    return currentUser;
}

/**
 * 当前用户和权限请求可以并行，先把文档页骨架立起来，再在两边结果齐了之后初始化协同编辑器。
 */
async function connectToDocument(docId) {
    if (!isValidDocId(docId)) {
        goHome();
        return;
    }

    activeDocId = docId;
    editorPanel.setDocId(docId);
    document.title = `实时文档 - ${docId}`;
    updateStatus("connecting");

    const currentUserPromise = loadCurrentUser();
    const permissionPromise = editorPanel.fetchDocumentPermission(docId);

    await currentUserPromise;
    const permission = await permissionPromise;
    handlePermissionChange(permission);
    createEditorSession(docId);
}

window.addEventListener("beforeunload", () => {
    disconnectCurrentRoom();
    editorPanel.destroy();
});

bindToolbarEvents();
editorPanel.applyResponsiveState(true);

const initialDocId = getDocIdFromPath();

if (initialDocId) {
    connectToDocument(initialDocId).catch((error) => {
        updateStatus("disconnected");
        editorPanel.showPermissionError(error.message || "文档初始化失败");
    });
} else {
    goHome();
}
