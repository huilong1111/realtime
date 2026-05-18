/**
 * 认证公共逻辑
 */
export async function fetchCurrentUser() {
    const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
    });

    if (response.status === 401) {
        return null;
    }

    if (!response.ok) {
        throw new Error("Failed to fetch current user");
    }

    return response.json();
}

export async function logout() {
    const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
    });

    if (!response.ok) {
        throw new Error("Failed to logout");
    }
}

export function buildReturnUrl(path = "/") {
    return encodeURIComponent(path);
}

export function getSafeReturnPath(defaultPath = "/") {
    const params = new URLSearchParams(window.location.search);
    const returnPath = params.get("return");
    if (!returnPath || !returnPath.startsWith("/")) {
        return defaultPath;
    }
    return returnPath;
}

export function redirectToLogin(returnPath) {
    const nextPath = returnPath || `${window.location.pathname}${window.location.search}`;
    window.location.href = `/login?return=${buildReturnUrl(nextPath)}`;
}

export function redirectToRegister(returnPath) {
    const nextPath = returnPath || `${window.location.pathname}${window.location.search}`;
    window.location.href = `/register?return=${buildReturnUrl(nextPath)}`;
}
