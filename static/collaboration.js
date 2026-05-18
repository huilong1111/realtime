import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { removeAwarenessStates } from "y-protocols/awareness";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

const TIPTAP_FIELD = "prosemirror";
const GUEST_CURSOR_STORAGE_KEY = "realtime_guest_cursor_name";
const CURSOR_COLORS = [
    "#d76c5d",
    "#4d8f8a",
    "#c28a2f",
    "#6c7ed6",
    "#8e5fb5",
    "#4f9a57",
    "#b55f79",
    "#5a86c8",
];

function buildWsBaseUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
}

/**
 * 游客身份不走后端接口，直接在前端会话里生成一次并复用。
 */
function getOrCreateGuestCursorIdentity() {
    const existing = window.sessionStorage.getItem(GUEST_CURSOR_STORAGE_KEY);
    if (existing) {
        return existing;
    }

    const nextGuestName = `游客-${Math.random().toString(36).slice(2, 6)}`;
    window.sessionStorage.setItem(GUEST_CURSOR_STORAGE_KEY, nextGuestName);
    return nextGuestName;
}

/**
 * 多人光标颜色按用户名做稳定映射
 */
function getCursorColor(name) {
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) {
        hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
    }
    return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

/**
 * awareness 可以直接承载多人光标用户信息
 */
function buildCursorUser(user) {
    const name = user?.username || getOrCreateGuestCursorIdentity();
    return {
        name,
        color: getCursorColor(name),
    };
}

/**
 * 把本地 cursor 身份单独封装出来
 */
function applyCursorIdentity(session) {
    session.localCursorUser = buildCursorUser(session.currentUser);
    session.provider.awareness.setLocalStateField("user", session.localCursorUser);
    return session.localCursorUser;
}

function rebroadcastLocalAwareness(session) {
    const localState = session.provider.awareness.getLocalState();
    if (!localState) {
        applyCursorIdentity(session);
        return;
    }
    // 重连成功后显式重发一次本地 awareness
    session.provider.awareness.setLocalState({ ...localState });
}

/**
 * 断开或离开文档时主动清掉本地 awareness
 */
function clearLocalCursorIdentity(session) {
    if (!session.provider) {
        return;
    }
    session.provider.awareness.setLocalState(null);
}

/**
 * 远端用户离线后立即清光标
 */
function clearRemoteCursorStates(session, reason) {
    if (!session.provider || !session.provider.awareness || !session.ydoc) {
        return;
    }

    const remoteClientIds = [];
    session.provider.awareness.getStates().forEach((_state, clientId) => {
        if (clientId !== session.ydoc.clientID) {
            remoteClientIds.push(clientId);
        }
    });

    if (remoteClientIds.length > 0) {
        removeAwarenessStates(session.provider.awareness, remoteClientIds, reason);
    }
}


function bindAwarenessLifecycle(session) {
    session.provider.awareness.on("change", () => {
        const localState = session.provider.awareness.getLocalState();
        if (session.connectionState === "connected" && session.localCursorUser && !localState?.user) {
            applyCursorIdentity(session);
        }
    });
}


function bindProviderLifecycle(session) {
    bindAwarenessLifecycle(session);

    session.provider.on("status", (event) => {
        if (session.isIntentionalDisconnect) {
            return;
        }

        if (event.status === "connected") {
            const recovered = session.hasConnectedOnce;
            session.hasConnectedOnce = true;
            applyCursorIdentity(session);
            rebroadcastLocalAwareness(session);
            session.connectionState = "connected";
            session.onStatusChange("connected", recovered);
            return;
        }

        session.connectionState = "reconnecting";
        session.onStatusChange("reconnecting");
    });

    session.provider.on("connection-close", () => {
        if (session.isIntentionalDisconnect) {
            return;
        }
        clearRemoteCursorStates(session, "connection-close");
        session.connectionState = navigator.onLine ? "reconnecting" : "disconnected";
        session.onStatusChange(session.connectionState);
    });

    session.provider.on("connection-error", () => {
        if (session.isIntentionalDisconnect) {
            return;
        }
        clearRemoteCursorStates(session, "connection-error");
        session.connectionState = navigator.onLine ? "reconnecting" : "disconnected";
        session.onStatusChange(session.connectionState);
    });
}

function handleOffline(session) {
    if (!session.provider || session.isIntentionalDisconnect) {
        return;
    }

    clearRemoteCursorStates(session, "browser-offline");
    session.connectionState = "disconnected";
    session.onStatusChange("disconnected");
    session.provider.disconnect();
}

function handleOnline(session) {
    if (!session.provider || session.isIntentionalDisconnect) {
        return;
    }

    session.connectionState = "reconnecting";
    session.onStatusChange("reconnecting");
    session.provider.shouldConnect = true;
    session.provider.connect();
}

/**
 * 创建协同会话时，把 Yjs / TipTap / awareness / reconnect 这一整条链路集中封装
 */
export function createCollaborativeSession({
    docId,
    canEdit,
    currentUser,
    editorElement,
    onStatusChange,
    onToolbarStateChange,
    setEditable,
    getToolbarButtons,
}) {
    const session = {
        provider: null,
        ydoc: null,
        editor: null,
        currentUser,
        localCursorUser: null,
        hasConnectedOnce: false,
        isIntentionalDisconnect: false,
        connectionState: "connecting",
        onStatusChange,
        onToolbarStateChange,
        setEditable,
        getToolbarButtons,
        handleOnline: null,
        handleOffline: null,
    };

    session.ydoc = new Y.Doc();
    session.provider = new WebsocketProvider(buildWsBaseUrl(), docId, session.ydoc);
    bindProviderLifecycle(session);

    const cursorUser = applyCursorIdentity(session);

    session.editor = new Editor({
        element: editorElement,
        editable: Boolean(canEdit),
        extensions: [
            StarterKit.configure({
                history: false,
            }),
            Collaboration.configure({
                document: session.ydoc,
                field: TIPTAP_FIELD,
            }),
            CollaborationCursor.configure({
                provider: session.provider,
                user: cursorUser,
            }),
        ],
        autofocus: "end",
        editorProps: {
            attributes: {
                class: "tiptap-editor__content",
            },
        },
        onCreate() {
            session.onToolbarStateChange();
            session.setEditable(Boolean(canEdit));
        },
        onSelectionUpdate() {
            session.onToolbarStateChange();
        },
        onTransaction() {
            session.onToolbarStateChange();
        },
    });

    session.handleOffline = () => handleOffline(session);
    session.handleOnline = () => handleOnline(session);
    window.addEventListener("offline", session.handleOffline);
    window.addEventListener("online", session.handleOnline);

    return session;
}

export function destroyCollaborativeSession(session) {
    if (!session) {
        return;
    }

    session.isIntentionalDisconnect = true;

    if (session.handleOffline) {
        window.removeEventListener("offline", session.handleOffline);
    }
    if (session.handleOnline) {
        window.removeEventListener("online", session.handleOnline);
    }

    if (session.provider) {
        clearLocalCursorIdentity(session);
        clearRemoteCursorStates(session, "leave-room");
        session.provider.disconnect();
        session.provider.destroy();
    }

    if (session.editor) {
        session.editor.destroy();
    }

    if (session.ydoc) {
        session.ydoc.destroy();
    }
}

export function reconnectCollaborativeSession(session) {
    if (!session || !session.provider || session.isIntentionalDisconnect) {
        return;
    }

    session.connectionState = "reconnecting";
    session.onStatusChange("reconnecting");
    session.provider.shouldConnect = true;
    session.provider.connect();
}
