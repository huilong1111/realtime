import asyncio
from inspect import isawaitable
import re

from anyio import create_task_group
from fastapi import WebSocket, WebSocketDisconnect
import y_py as Y
from ypy_websocket.websocket_server import WebsocketServer
from ypy_websocket.yroom import YRoom
from ypy_websocket.yutils import (
    YMessageType,
    YSyncMessageType,
    process_sync_message,
    sync,
    write_var_uint,
)

from document_service import ensure_document_exists, save_yjs_state

PREVIEW_EMPTY_TEXT = "暂无内容"


def write_var_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return write_var_uint(len(encoded)) + encoded


def create_awareness_message(entries: list[tuple[int, int, str]]) -> bytes:
    payload = write_var_uint(len(entries))
    for client_id, clock, state_str in entries:
        payload += write_var_uint(client_id)
        payload += write_var_uint(clock)
        payload += write_var_string(state_str)
    return bytes([YMessageType.AWARENESS]) + write_var_uint(len(payload)) + payload


def normalize_preview_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def extract_tiptap_preview(ydoc: Y.YDoc, doc_id: str) -> tuple[str, str]:
    root = ydoc.get_xml_element("prosemirror")
    heading_title = ""
    text_blocks: list[str] = []

    for node in root.tree_walker():
        if not isinstance(node, Y.YXmlElement):
            continue

        node_text = normalize_preview_text(str(node))
        if not node_text:
            continue

        if node.name == "heading" and not heading_title:
            heading_title = node_text

        if node.name in {"heading", "paragraph", "blockquote", "listItem"}:
            text_blocks.append(node_text)

    fallback_title = text_blocks[0] if text_blocks else ""
    title = heading_title or fallback_title or doc_id

    preview_blocks = []
    skipped_title = False
    for block in text_blocks:
        if not skipped_title and block == title:
            skipped_title = True
            continue
        preview_blocks.append(block)

    preview_text = normalize_preview_text(" ".join(preview_blocks))
    if preview_text == title:
        preview_text = ""
    if len(preview_text) > 120:
        preview_text = preview_text[:120].rstrip() + "..."

    return title, (preview_text or PREVIEW_EMPTY_TEXT)


# 这里集中承接 FastAPI WebSocket 适配层和 Yjs 房间服务层。
class FastAPIYjsWebSocket:
    def __init__(self, websocket: WebSocket, room_name: str, can_edit: bool):
        self.websocket = websocket
        self._room_name = room_name
        self.can_edit = can_edit

    @property
    def path(self) -> str:
        return self._room_name

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        try:
            return await self.recv()
        except WebSocketDisconnect:
            raise StopAsyncIteration()

    async def send(self, message: bytes) -> None:
        try:
            await self.websocket.send_bytes(message)
        except RuntimeError as exc:
            raise WebSocketDisconnect() from exc

    async def close(self, code: int = 1000) -> None:
        try:
            await self.websocket.close(code=code)
        except RuntimeError:
            pass

    def _is_allowed_readonly_message(self, message: bytes) -> bool:
        # 协同权限边界：只读用户仍可完成初始化同步、awareness 广播和在线感知，但不能提交文档更新。
        if not message:
            return False
        if message[0] == YMessageType.AWARENESS:
            return True
        if message[0] != YMessageType.SYNC or len(message) < 2:
            return False
        return message[1] == YSyncMessageType.SYNC_STEP1

    async def recv(self) -> bytes:
        while True:
            message = await self.websocket.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()

            if message.get("bytes") is not None:
                payload = message["bytes"]
            elif message.get("text") is not None:
                payload = message["text"].encode("utf-8")
            else:
                payload = b""

            if self.can_edit or self._is_allowed_readonly_message(payload):
                return payload


class PresenceAwareRoom(YRoom):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._client_ids_by_socket: dict[object, set[int]] = {}

    def _track_awareness_from_message(self, websocket, message: bytes) -> None:
        if len(message) < 2 or message[0] != YMessageType.AWARENESS:
            return

        changes = self.awareness.get_changes(message[1:])
        tracked_ids = self._client_ids_by_socket.setdefault(websocket, set())

        for client_id in changes["added"] + changes["updated"] + changes["filtered_updated"]:
            tracked_ids.add(client_id)

        for client_id in changes["removed"]:
            tracked_ids.discard(client_id)

    async def _broadcast_awareness_removal(self, websocket) -> None:
        tracked_ids = self._client_ids_by_socket.pop(websocket, set())
        if not tracked_ids:
            return

        removal_entries = []
        for client_id in tracked_ids:
            client_meta = self.awareness.meta.get(client_id)
            current_clock = 0 if client_meta is None else client_meta["clock"]
            removal_entries.append((client_id, current_clock + 1, ""))

        if not removal_entries:
            return

        removal_message = create_awareness_message(removal_entries)
        # 先更新房间内的 awareness 视图，再把“该 clientId 已离线”的消息立即广播给其他客户端。
        self.awareness.get_changes(removal_message[1:])
        for client in self.clients:
            if client != websocket:
                await client.send(removal_message)

    async def serve(self, websocket):
        async with create_task_group() as tg:
            self.clients.append(websocket)
            self._client_ids_by_socket.setdefault(websocket, set())
            await sync(self.ydoc, websocket, self.log)
            try:
                async for message in websocket:
                    skip = False
                    if self.on_message:
                        _skip = self.on_message(message)
                        skip = await _skip if isawaitable(_skip) else _skip
                    if skip:
                        continue
                    message_type = message[0]
                    if message_type == YMessageType.SYNC:
                        tg.start_soon(
                            process_sync_message, message[1:], self.ydoc, websocket, self.log
                        )
                    elif message_type == YMessageType.AWARENESS:
                        self._track_awareness_from_message(websocket, message)
                        self.log.debug(
                            "Received %s message from endpoint: %s",
                            YMessageType.AWARENESS.name,
                            websocket.path,
                        )
                        for client in self.clients:
                            self.log.debug(
                                "Sending Y awareness from client with endpoint %s to client with endpoint: %s",
                                websocket.path,
                                client.path,
                            )
                            tg.start_soon(client.send, message)
            except Exception as e:
                self.log.debug("Error serving endpoint: %s", websocket.path, exc_info=e)
            finally:
                await self._broadcast_awareness_removal(websocket)
                self.clients = [c for c in self.clients if c != websocket]


class PersistentYjsServer(WebsocketServer):
    def __init__(self) -> None:
        super().__init__(rooms_ready=False, auto_clean_rooms=False)
        self._save_tasks: dict[str, asyncio.Task] = {}

    async def get_room(self, name: str) -> YRoom:
        if name not in self.rooms:
            room = PresenceAwareRoom(ready=False, log=self.log)
            self.rooms[name] = room
            # 默认按只读模式预热房间，避免游客浏览时意外创建数据库文档。
            await self._bootstrap_room(name, room, create_if_missing=False)

        room = self.rooms[name]
        await self.start_room(room)
        return room

    async def _bootstrap_room(self, doc_id: str, room: YRoom, create_if_missing: bool) -> None:
        yjs_state = ensure_document_exists(doc_id, create_if_missing=create_if_missing)
        if yjs_state:
            # 先恢复数据库里的 Yjs 快照，保证同一文档重进时优先回到上次协同状态。
            Y.apply_update(room.ydoc, bytes(yjs_state))

        room.ready = True
        room.ydoc.observe_after_transaction(
            lambda _event: self._schedule_persist(doc_id, room.ydoc)
        )

    async def ensure_editable_room(self, doc_id: str) -> None:
        if doc_id not in self.rooms:
            return

        room = self.rooms[doc_id]
        if ensure_document_exists(doc_id, create_if_missing=True) is not None:
            return

        room.ready = True

    def _schedule_persist(self, doc_id: str, ydoc: Y.YDoc) -> None:
        task = self._save_tasks.get(doc_id)
        if task and not task.done():
            task.cancel()

        self._save_tasks[doc_id] = asyncio.create_task(
            self._persist_room_state_later(doc_id, ydoc)
        )

    async def _persist_room_state_later(self, doc_id: str, ydoc: Y.YDoc) -> None:
        try:
            await asyncio.sleep(1)
            # 富文本真实状态仍以 yjs_state 为准，同时派生标题与摘要给首页和“我的文档”卡片直接展示。
            for _ in range(3):
                try:
                    yjs_state = Y.encode_state_as_update(ydoc)
                    title, preview_text = extract_tiptap_preview(ydoc, doc_id)
                    await asyncio.to_thread(
                        save_yjs_state,
                        doc_id,
                        yjs_state,
                        title,
                        preview_text,
                    )
                    return
                except RuntimeError:
                    await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            pass

    async def stop_persistence_tasks(self) -> None:
        for task in self._save_tasks.values():
            if not task.done():
                task.cancel()

        if self._save_tasks:
            await asyncio.gather(*self._save_tasks.values(), return_exceptions=True)
        self._save_tasks.clear()

    async def delete_room(self, doc_id: str) -> None:
        # 删除文档时同时清掉在线协同房间，避免旧连接继续停留在已删除文档里。
        task = self._save_tasks.pop(doc_id, None)
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        room = self.rooms.pop(doc_id, None)
        if not room:
            return

        clients = list(room.clients)
        room.clients = []
        for client in clients:
            close = getattr(client, "close", None)
            if close:
                await close(code=1008)


yjs_server = PersistentYjsServer()
