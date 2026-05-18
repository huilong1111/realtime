from contextlib import asynccontextmanager
from pathlib import Path
import re

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from auth_service import (
    ACCESS_TOKEN_COOKIE_NAME,
    build_auth_cookie_settings,
    create_access_token,
    get_current_user_from_request,
    get_current_user_from_websocket,
    hash_password,
    validate_password,
    validate_username,
    verify_password,
)
from database import init_db
from document_service import (
    add_document_editor,
    can_user_edit_document,
    create_document_if_missing,
    get_document_permission,
    get_document_record,
    list_documents,
    remove_document_editor,
    set_document_public_editable,
)
from user_service import create_user, get_user_by_username
from yjs_service import FastAPIYjsWebSocket, yjs_server

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DOC_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AuthPayload(BaseModel):
    username: str
    password: str


class PublicPermissionPayload(BaseModel):
    is_public_editable: bool


class EditorPayload(BaseModel):
    username: str


def is_valid_doc_id(doc_id: str) -> bool:
    return bool(DOC_ID_PATTERN.fullmatch(doc_id))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    async with yjs_server:
        yield
    await yjs_server.stop_persistence_tasks()


app = FastAPI(lifespan=lifespan)


def build_auth_success_response(user: dict) -> JSONResponse:
    token = create_access_token(user["id"], user["username"])
    response = JSONResponse(
        {
            "ok": True,
            "user": {
                "id": user["id"],
                "username": user["username"],
            },
        }
    )
    response.set_cookie(value=token, **build_auth_cookie_settings())
    return response


@app.get("/")
async def serve_home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/login")
async def serve_login() -> FileResponse:
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/register")
async def serve_register() -> FileResponse:
    return FileResponse(STATIC_DIR / "register.html")


@app.get("/api/documents")
async def get_documents() -> JSONResponse:
    return JSONResponse(list_documents())


@app.post("/api/auth/register")
async def register(payload: AuthPayload) -> JSONResponse:
    username = validate_username(payload.username)
    password = validate_password(payload.password)

    if get_user_by_username(username):
        raise HTTPException(status_code=409, detail="用户名已存在")

    user = create_user(username, hash_password(password))
    return build_auth_success_response(user)


@app.post("/api/auth/login")
async def login(payload: AuthPayload) -> JSONResponse:
    username = validate_username(payload.username)
    user = get_user_by_username(username)
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return build_auth_success_response(user)


@app.post("/api/auth/logout")
async def logout() -> JSONResponse:
    response = JSONResponse({"ok": True})
    response.delete_cookie(ACCESS_TOKEN_COOKIE_NAME, path="/")
    return response


@app.get("/api/auth/me")
async def get_current_user(request: Request) -> JSONResponse:
    user = get_current_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")
    return JSONResponse(
        {
            "id": user["id"],
            "username": user["username"],
        }
    )


@app.get("/api/documents/{doc_id}/permissions")
async def get_permissions(doc_id: str, request: Request) -> JSONResponse:
    if not is_valid_doc_id(doc_id):
        raise HTTPException(status_code=400, detail="非法文档号")

    user = get_current_user_from_request(request)
    record = get_document_record(doc_id)
    if not record and user:
        # 首次由登录用户进入一个不存在的文档时，自动创建并把该用户记为创建者。
        create_document_if_missing(doc_id, user["id"])

    permission = get_document_permission(doc_id, user["id"] if user else None)
    return JSONResponse(permission)


@app.put("/api/documents/{doc_id}/permissions/public")
async def update_public_permission(
    doc_id: str,
    payload: PublicPermissionPayload,
    request: Request,
) -> JSONResponse:
    if not is_valid_doc_id(doc_id):
        raise HTTPException(status_code=400, detail="非法文档号")

    user = get_current_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")

    try:
        permission = set_document_public_editable(doc_id, user["id"], payload.is_public_editable)
    except PermissionError:
        raise HTTPException(status_code=403, detail="只有创建者可以修改权限")

    return JSONResponse(permission)


@app.post("/api/documents/{doc_id}/permissions/editors")
async def create_editor_permission(
    doc_id: str,
    payload: EditorPayload,
    request: Request,
) -> JSONResponse:
    if not is_valid_doc_id(doc_id):
        raise HTTPException(status_code=400, detail="非法文档号")

    user = get_current_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")

    try:
        permission = add_document_editor(doc_id, user["id"], payload.username)
    except PermissionError:
        raise HTTPException(status_code=403, detail="只有创建者可以修改权限")
    except LookupError:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    return JSONResponse(permission)


@app.delete("/api/documents/{doc_id}/permissions/editors/{username}")
async def delete_editor_permission(doc_id: str, username: str, request: Request) -> JSONResponse:
    if not is_valid_doc_id(doc_id):
        raise HTTPException(status_code=400, detail="非法文档号")

    user = get_current_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")

    try:
        permission = remove_document_editor(doc_id, user["id"], username)
    except PermissionError:
        raise HTTPException(status_code=403, detail="只有创建者可以修改权限")
    except LookupError:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    return JSONResponse(permission)


@app.get("/doc/{doc_id}")
async def serve_document(doc_id: str) -> FileResponse:
    return FileResponse(STATIC_DIR / "doc.html")


@app.websocket("/ws/{doc_id}")
async def websocket_endpoint(ws: WebSocket, doc_id: str) -> None:
    if not is_valid_doc_id(doc_id):
        await ws.close(code=1008)
        return

    try:
        user = get_current_user_from_websocket(ws)
    except HTTPException:
        user = None

    record = get_document_record(doc_id)
    if not record and user:
        # 只有登录用户首次进入不存在的文档时，才真正创建数据库记录并成为 owner。
        create_document_if_missing(doc_id, user["id"])

    can_edit = can_user_edit_document(doc_id, user["id"] if user else None)

    await ws.accept()
    # 同一 doc_id 的协同消息统一交给 Yjs websocket 服务处理。
    yjs_websocket = FastAPIYjsWebSocket(ws, doc_id, can_edit=can_edit)
    await yjs_server.serve(yjs_websocket)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
