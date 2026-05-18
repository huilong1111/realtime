from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from database import SessionLocal, users_table


def get_user_by_username(username: str) -> dict | None:
    with SessionLocal() as session:
        row = session.execute(
            select(
                users_table.c.id,
                users_table.c.username,
                users_table.c.password_hash,
            ).where(users_table.c.username == username)
        ).first()

    if not row:
        return None

    return {
        "id": row.id,
        "username": row.username,
        "password_hash": row.password_hash,
    }


def get_user_by_id(user_id: int) -> dict | None:
    with SessionLocal() as session:
        row = session.execute(
            select(
                users_table.c.id,
                users_table.c.username,
                users_table.c.password_hash,
            ).where(users_table.c.id == user_id)
        ).first()

    if not row:
        return None
    
    return {
        "id": row.id,
        "username": row.username,
        "password_hash": row.password_hash,
    }


def create_user(username: str, password_hash: str) -> dict:
    with SessionLocal() as session:
        statement = (
            insert(users_table)
            .values(username=username, password_hash=password_hash)
            .returning(users_table.c.id, users_table.c.username, users_table.c.password_hash)
        )
        row = session.execute(statement).first()
        session.commit()

    return {
        "id": row.id,
        "username": row.username,
        "password_hash": row.password_hash,
    }
