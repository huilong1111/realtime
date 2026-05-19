from sqlalchemy import (
    TIMESTAMP,
    Boolean,
    Column,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    create_engine,
    func,
    inspect,
    text,
)
from sqlalchemy.orm import sessionmaker

DATABASE_URL = "postgresql+psycopg2://postgres:123456@localhost:5432/realtime_doc"

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)
metadata = MetaData()

documents_table = Table(
    "documents",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("doc_id", String, unique=True, nullable=False, index=True),
    Column("owner_user_id", Integer, nullable=True, index=True),
    Column("is_public_editable", Boolean, nullable=False, server_default="false"),
    Column("title", String, nullable=False, server_default=""),
    Column("preview_text", String, nullable=False, server_default=""),
    Column("yjs_state", LargeBinary, nullable=True),
    Column("created_at", TIMESTAMP, server_default=func.now(), nullable=False),
    Column("updated_at", TIMESTAMP, server_default=func.now(), nullable=False),
)

document_editors_table = Table(
    "document_editors",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("doc_id", String, nullable=False, index=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("created_at", TIMESTAMP, server_default=func.now(), nullable=False),
    UniqueConstraint("doc_id", "user_id", name="uq_document_editors_doc_user"),
)

users_table = Table(
    "users",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("username", String, unique=True, nullable=False, index=True),
    Column("password_hash", String, nullable=False),
    Column("created_at", TIMESTAMP, server_default=func.now(), nullable=False),
    Column("updated_at", TIMESTAMP, server_default=func.now(), nullable=False),
)


def init_db() -> None:
    metadata.create_all(engine)
   
