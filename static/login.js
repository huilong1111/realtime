import { getSafeReturnPath } from "/static/auth.js";

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const formMessage = document.getElementById("formMessage");
const registerLink = document.getElementById("registerLink");

const returnPath = getSafeReturnPath("/");
registerLink.href = `/register?return=${encodeURIComponent(returnPath)}`;

/**
 * 登录页只负责提交认证表单，成功后按 return 参数回跳来源页面。
 */
loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    formMessage.textContent = "";

    try {
        const response = await fetch("/api/auth/login", {
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
            formMessage.textContent = data.detail || "登录失败，请检查用户名和密码。";
            return;
        }

        window.location.href = returnPath;
    } catch (_error) {
        formMessage.textContent = "登录请求失败，请稍后重试。";
    }
});
