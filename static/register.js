import { getSafeReturnPath } from "/static/auth.js";

const registerForm = document.getElementById("registerForm");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const formMessage = document.getElementById("formMessage");
const loginLink = document.getElementById("loginLink");

const returnPath = getSafeReturnPath("/");
loginLink.href = `/login?return=${encodeURIComponent(returnPath)}`;

/**
 * 注册成功后直接复用后端下发的登录 Cookie，用户无需再额外手动登录一次。
 */
registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    formMessage.textContent = "";

    try {
        const response = await fetch("/api/auth/register", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                username: usernameInput.value,
                password: passwordInput.value,
            }),
        });

        const data = await response.json();
        if (!response.ok) {
            formMessage.textContent = data.detail || "注册失败，请稍后重试。";
            return;
        }

        window.location.href = returnPath;
    } catch (_error) {
        formMessage.textContent = "注册请求失败，请稍后重试。";
    }
});
