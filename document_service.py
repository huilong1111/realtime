from sqlalchemy import and_, delete, func, outerjoin, select, update
from sqlalchemy.dialects.postgresql import insert

from database import SessionLocal, document_editors_table, documents_table, users_table
from user_service import get_user_by_username


def get_document_record(doc_id: str) -> dict | None:
    with SessionLocal() as session:
        owner_alias = users_table.alias("owner_user")
        row = session.execute(
            select(
                documents_table.c.doc_id,
                documents_table.c.owner_user_id,
                documents_table.c.is_public_editable,
                documents_table.c.yjs_state,
                owner_alias.c.username.label("owner_username"),
            )
            .select_from(
                outerjoin(
                    documents_table,
                    owner_alias,
                    documents_table.c.owner_user_id == owner_alias.c.id,
                )
            )
            .where(documents_table.c.doc_id == doc_id)
        ).first()

    if not row:
        return None

    return {
        "doc_id": row.doc_id,
        "owner_user_id": row.owner_user_id,
        "owner_username": row.owner_username,
        "is_public_editable": bool(row.is_public_editable),
        "yjs_state": row.yjs_state,
    }


def create_document_if_missing(doc_id: str, owner_user_id: int) -> dict:
    # 新文档第一次由登录用户进入时，把该用户记为创建者，并默认设为“仅创建者可编辑”。
    with SessionLocal() as session:
        statement = (
            insert(documents_table)
            .values(
                doc_id=doc_id,
                owner_user_id=owner_user_id,
                is_public_editable=False,
            )
            .on_conflict_do_nothing(index_elements=[documents_table.c.doc_id])
        )
        session.execute(statement)
        session.commit()

    record = get_document_record(doc_id)
    assert record is not None
    return record


def ensure_document_exists(doc_id: str, create_if_missing: bool, owner_user_id: int | None = None) -> bytes | None:
    record = get_document_record(doc_id)
    if record:
        return record["yjs_state"]

    if not create_if_missing or owner_user_id is None:
        return None

    record = create_document_if_missing(doc_id, owner_user_id)
    return record["yjs_state"]


def save_yjs_state(doc_id: str, yjs_state: bytes) -> None:
    with SessionLocal() as session:
        statement = (
            insert(documents_table)
            .values(doc_id=doc_id, yjs_state=yjs_state, is_public_editable=False)
            .on_conflict_do_update(
                index_elements=[documents_table.c.doc_id],
                set_={
                    "yjs_state": yjs_state,
                    "updated_at": func.now(),
                },
            )
        )
        session.execute(statement)
        session.commit()


def list_documents() -> list[dict[str, str]]:
    with SessionLocal() as session:
        rows = session.execute(
            select(documents_table.c.doc_id, documents_table.c.updated_at)
            .order_by(documents_table.c.updated_at.desc())
        ).all()

    return [
        {
            "doc_id": row.doc_id,
            "updated_at": row.updated_at.isoformat() if row.updated_at else "",
        }
        for row in rows
    ]


def get_document_editor_usernames(doc_id: str) -> list[str]:
    with SessionLocal() as session:
        rows = session.execute(
            select(users_table.c.username)
            .select_from(
                document_editors_table.join(
                    users_table,
                    document_editors_table.c.user_id == users_table.c.id,
                )
            )
            .where(document_editors_table.c.doc_id == doc_id)
            .order_by(users_table.c.username.asc())
        ).all()

    return [row.username for row in rows]


def get_document_permission(doc_id: str, current_user_id: int | None) -> dict:
    # 编辑权限分三层：创建者、全员可编辑、指定用户名可编辑。
    record = get_document_record(doc_id)
    if not record:
        return {
            "doc_id": doc_id,
            "owner_user_id": None,
            "owner_username": None,
            "is_public_editable": False,
            "can_edit": False,
            "is_owner": False,
            "editors": [],
        }

    is_owner = current_user_id is not None and record["owner_user_id"] == current_user_id

    with SessionLocal() as session:
        editor_row = None
        if current_user_id is not None:
            editor_row = session.execute(
                select(document_editors_table.c.id).where(
                    and_(
                        document_editors_table.c.doc_id == doc_id,
                        document_editors_table.c.user_id == current_user_id,
                    )
                )
            ).first()

    can_edit = is_owner or bool(record["is_public_editable"]) or editor_row is not None

    return {
        "doc_id": doc_id,
        "owner_user_id": record["owner_user_id"],
        "owner_username": record["owner_username"],
        "is_public_editable": bool(record["is_public_editable"]),
        "can_edit": can_edit,
        "is_owner": is_owner,
        "editors": get_document_editor_usernames(doc_id) if is_owner else [],
    }


def can_user_edit_document(doc_id: str, current_user_id: int | None) -> bool:
    permission = get_document_permission(doc_id, current_user_id)
    return bool(permission["can_edit"])


def set_document_public_editable(doc_id: str, owner_user_id: int, is_public_editable: bool) -> dict:
    permission = get_document_permission(doc_id, owner_user_id)
    if not permission["is_owner"]:
        raise PermissionError("only_owner_can_update_permissions")

    with SessionLocal() as session:
        session.execute(
            update(documents_table)
            .where(documents_table.c.doc_id == doc_id)
            .values(
                is_public_editable=is_public_editable,
                updated_at=func.now(),
            )
        )
        session.commit()

    return get_document_permission(doc_id, owner_user_id)


def add_document_editor(doc_id: str, owner_user_id: int, username: str) -> dict:
    permission = get_document_permission(doc_id, owner_user_id)
    if not permission["is_owner"]:
        raise PermissionError("only_owner_can_update_permissions")

    user = get_user_by_username(username.strip())
    if not user:
        raise LookupError("target_user_not_found")

    if user["id"] == owner_user_id:
        return get_document_permission(doc_id, owner_user_id)

    with SessionLocal() as session:
        statement = (
            insert(document_editors_table)
            .values(doc_id=doc_id, user_id=user["id"])
            .on_conflict_do_nothing(index_elements=["doc_id", "user_id"])
        )
        session.execute(statement)
        session.execute(
            update(documents_table)
            .where(documents_table.c.doc_id == doc_id)
            .values(updated_at=func.now())
        )
        session.commit()

    return get_document_permission(doc_id, owner_user_id)


def remove_document_editor(doc_id: str, owner_user_id: int, username: str) -> dict:
    permission = get_document_permission(doc_id, owner_user_id)
    if not permission["is_owner"]:
        raise PermissionError("only_owner_can_update_permissions")

    user = get_user_by_username(username.strip())
    if not user:
        raise LookupError("target_user_not_found")

    with SessionLocal() as session:
        session.execute(
            delete(document_editors_table).where(
                and_(
                    document_editors_table.c.doc_id == doc_id,
                    document_editors_table.c.user_id == user["id"],
                )
            )
        )
        session.execute(
            update(documents_table)
            .where(documents_table.c.doc_id == doc_id)
            .values(updated_at=func.now())
        )
        session.commit()

    return get_document_permission(doc_id, owner_user_id)
