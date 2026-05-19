import { fetchCurrentUser, logout, redirectToLogin } from "/static/auth.js";

const authStatusText = document.getElementById("authStatusText");
const authActions = document.getElementById("authActions");
const myDocumentsList = document.getElementById("myDocumentsList");
const myDocumentsState = document.getElementById("myDocumentsState");

let currentUser = null;

function goHome() {
    window.location.href = "/";
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

function renderAuthPanel() {
    authActions.innerHTML = "";
    authStatusText.textContent = `当前用户：${currentUser.username}`;

    const homeButton = document.createElement("button");
    homeButton.type = "button";
    homeButton.className = "secondary-button";
    homeButton.textContent = "返回首页";
    homeButton.addEventListener("click", goHome);

    const logoutButton = document.createElement("button");
    logoutButton.type = "button";
    logoutButton.className = "ghost-button";
    logoutButton.textContent = "退出登录";
    logoutButton.addEventListener("click", async () => {
        await logout();
        goHome();
    });

    authActions.append(homeButton, logoutButton);
}

/**
 * “我的文档”页沿用首页同样的内容卡片，让用户直接按标题和摘要浏览自己创建的文档。
 */
function renderMyDocuments(documents) {
    myDocumentsList.innerHTML = "";

    if (!Array.isArray(documents) || documents.length === 0) {
        myDocumentsState.textContent = "你还没有创建任何文档。";
        myDocumentsState.classList.remove("is-hidden");
        return;
    }

    myDocumentsState.classList.add("is-hidden");

    documents.forEach((documentItem) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "room-item";
        button.innerHTML = `
            <span class="room-item__name">${documentItem.title || documentItem.doc_id}</span>
            <span class="room-item__meta">文档号：${documentItem.doc_id}</span>
            <span class="room-item__preview">${documentItem.preview_text || "暂无内容"}</span>
            <span class="room-item__time">最近更新：${formatUpdatedAt(documentItem.updated_at)}</span>
        `;
        button.addEventListener("click", () => {
            goToDocument(documentItem.doc_id);
        });
        myDocumentsList.appendChild(button);
    });
}

async function loadMyDocuments() {
    try {
        const response = await fetch("/api/my-documents", {
            credentials: "same-origin",
        });

        if (response.status === 401) {
            redirectToLogin("/my-documents");
            return;
        }

        if (!response.ok) {
            throw new Error("Failed to fetch my documents");
        }

        const documents = await response.json();
        renderMyDocuments(documents);
    } catch (_error) {
        myDocumentsState.textContent = "我的文档加载失败，请稍后刷新重试。";
        myDocumentsState.classList.remove("is-hidden");
    }
}

/**
 * 先确认当前用户身份，未登录时直接带 return 参数跳回登录页。
 */
async function bootstrapPage() {
    currentUser = await fetchCurrentUser();
    if (!currentUser) {
        redirectToLogin("/my-documents");
        return;
    }

    renderAuthPanel();
    await loadMyDocuments();
}

bootstrapPage().catch(() => {
    redirectToLogin("/my-documents");
});
