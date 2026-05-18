import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

from fastapi import HTTPException, Request, WebSocket

from user_service import get_user_by_id

ACCESS_TOKEN_COOKIE_NAME = "access_token"
ACCESS_TOKEN_EXPIRE_SECONDS = 60 * 60 * 24 * 7
JWT_ALGORITHM = "HS256"
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "realtime-doc-demo-secret")
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{3,32}$")
PASSWORD_MIN_LENGTH = 6
PASSWORD_ITERATIONS = 200_000


def validate_username(username: str) -> str:
    normalized = username.strip()
    if not USERNAME_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="用户名仅支持字母、数字、下划线，长度 3-32 位")
    return normalized


def validate_password(password: str) -> str:
    if len(password) < PASSWORD_MIN_LENGTH:
        raise HTTPException(status_code=400, detail="密码长度至少为 6 位")
    return password


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password: str) -> str:
    # 这里使用标准库 PBKDF2 做密码哈希，避免把明文密码存进数据库。
    salt = secrets.token_bytes(16)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return (
        "pbkdf2_sha256"
        f"${PASSWORD_ITERATIONS}"
        f"${_b64url_encode(salt)}"
        f"${_b64url_encode(password_hash)}"
    )


def verify_password(plain_password: str, password_hash: str) -> bool:
    try:
        algorithm, iterations, salt, stored_hash = password_hash.split("$", 3)
    except ValueError:
        return False

    if algorithm != "pbkdf2_sha256":
        return False

    computed_hash = hashlib.pbkdf2_hmac(
        "sha256",
        plain_password.encode("utf-8"),
        _b64url_decode(salt),
        int(iterations),
    )
    return hmac.compare_digest(_b64url_encode(computed_hash), stored_hash)


def create_access_token(user_id: int, username: str) -> str:
    # JWT 只放最少必要信息，前端通过 /api/auth/me 获取当前用户，不直接解析 token。
    header = {"alg": JWT_ALGORITHM, "typ": "JWT"}
    payload = {
        "sub": str(user_id),
        "username": username,
        "exp": int(time.time()) + ACCESS_TOKEN_EXPIRE_SECONDS,
    }
    header_part = _b64url_encode(
        json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    payload_part = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    signing_input = f"{header_part}.{payload_part}".encode("ascii")
    signature = hmac.new(JWT_SECRET_KEY.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_part}.{payload_part}.{_b64url_encode(signature)}"


def decode_access_token(token: str) -> dict:
    try:
        header_part, payload_part, signature_part = token.split(".")
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="登录状态无效") from exc

    signing_input = f"{header_part}.{payload_part}".encode("ascii")
    expected_signature = hmac.new(
        JWT_SECRET_KEY.encode("utf-8"),
        signing_input,
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(_b64url_encode(expected_signature), signature_part):
        raise HTTPException(status_code=401, detail="登录状态无效")

    payload = json.loads(_b64url_decode(payload_part).decode("utf-8"))
    if payload.get("exp", 0) < int(time.time()):
        raise HTTPException(status_code=401, detail="登录状态已过期")
    return payload


def get_current_user_from_cookie_token(token: str | None) -> dict | None:
    if not token:
        return None

    payload = decode_access_token(token)
    user_id = int(payload["sub"])
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def get_current_user_from_request(request: Request) -> dict | None:
    token = request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)
    return get_current_user_from_cookie_token(token)


def get_current_user_from_websocket(websocket: WebSocket) -> dict | None:
    token = websocket.cookies.get(ACCESS_TOKEN_COOKIE_NAME)
    return get_current_user_from_cookie_token(token)


def build_auth_cookie_settings() -> dict:
    return {
        "key": ACCESS_TOKEN_COOKIE_NAME,
        "httponly": True,
        "max_age": ACCESS_TOKEN_EXPIRE_SECONDS,
        "samesite": "lax",
        "secure": False,
        "path": "/",
    }
