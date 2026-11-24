from collections.abc import Generator
from contextlib import contextmanager
import re
import sqlite3
from pathlib import Path
from typing import Any


def make_slug(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "post"


class CmsStore:
    def __init__(self, database_path: str) -> None:
        self.database_path = database_path
        if database_path != ":memory:":
            Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    domain TEXT NOT NULL UNIQUE,
                    hosted_zone_id TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS posts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    body TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    published_at TEXT,
                    UNIQUE (site_id, slug)
                );
                CREATE TABLE IF NOT EXISTS tracking (
                    site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
                    gtm_id TEXT NOT NULL DEFAULT '',
                    ga4_id TEXT NOT NULL DEFAULT '',
                    meta_pixel_id TEXT NOT NULL DEFAULT '',
                    tiktok_pixel_id TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    @contextmanager
    def _connect(self) -> Generator[sqlite3.Connection, None, None]:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def list_sites(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM sites ORDER BY name COLLATE NOCASE").fetchall()
        return [dict(row) for row in rows]

    def get_site(self, site_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
        return self._dict(row)

    def create_site(self, name: str, domain: str, hosted_zone_id: str | None) -> dict[str, Any]:
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO sites (name, domain, hosted_zone_id) VALUES (?, ?, ?)",
                (name, domain, hosted_zone_id),
            )
            row = connection.execute("SELECT * FROM sites WHERE id = ?", (cursor.lastrowid,)).fetchone()
        result = self._dict(row)
        assert result is not None
        return result

    def update_site(self, site_id: int, name: str, hosted_zone_id: str | None) -> dict[str, Any] | None:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE sites SET name = ?, hosted_zone_id = ? WHERE id = ?",
                (name, hosted_zone_id, site_id),
            )
            if cursor.rowcount == 0:
                return None
            row = connection.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
        return self._dict(row)

    def delete_site(self, site_id: int) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM sites WHERE id = ?", (site_id,))
        return cursor.rowcount > 0

    def list_posts(self, site_id: int) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM posts WHERE site_id = ? ORDER BY updated_at DESC, id DESC",
                (site_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_post(
        self, site_id: int, title: str, slug: str, body: str, status: str
    ) -> dict[str, Any]:
        published = "CURRENT_TIMESTAMP" if status == "published" else "NULL"
        with self._connect() as connection:
            cursor = connection.execute(
                f"""
                INSERT INTO posts (site_id, title, slug, body, status, published_at)
                VALUES (?, ?, ?, ?, ?, {published})
                """,
                (site_id, title, slug, body, status),
            )
            row = connection.execute("SELECT * FROM posts WHERE id = ?", (cursor.lastrowid,)).fetchone()
        result = self._dict(row)
        assert result is not None
        return result

    def update_post(
        self, post_id: int, title: str, slug: str, body: str, status: str
    ) -> dict[str, Any] | None:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE posts
                SET title = ?, slug = ?, body = ?, status = ?,
                    updated_at = CURRENT_TIMESTAMP,
                    published_at = CASE
                        WHEN ? = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP)
                        ELSE NULL
                    END
                WHERE id = ?
                """,
                (title, slug, body, status, status, post_id),
            )
            if cursor.rowcount == 0:
                return None
            row = connection.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        return self._dict(row)

    def delete_post(self, post_id: int) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM posts WHERE id = ?", (post_id,))
        return cursor.rowcount > 0

    def get_public_post(self, site_id: int, slug: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT posts.id, posts.site_id, posts.title, posts.slug, posts.body,
                       posts.published_at, sites.name AS site_name, sites.domain,
                       tracking.gtm_id, tracking.ga4_id, tracking.meta_pixel_id,
                       tracking.tiktok_pixel_id
                FROM posts
                JOIN sites ON sites.id = posts.site_id
                LEFT JOIN tracking ON tracking.site_id = sites.id
                WHERE posts.site_id = ? AND posts.slug = ? AND posts.status = 'published'
                """,
                (site_id, slug),
            ).fetchone()
        return self._dict(row)

    def get_tracking(self, site_id: int) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM tracking WHERE site_id = ?", (site_id,)).fetchone()
        return dict(row) if row else {
            "site_id": site_id,
            "gtm_id": "",
            "ga4_id": "",
            "meta_pixel_id": "",
            "tiktok_pixel_id": "",
            "updated_at": None,
        }

    def save_tracking(self, site_id: int, tracking: dict[str, str]) -> dict[str, Any]:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO tracking (site_id, gtm_id, ga4_id, meta_pixel_id, tiktok_pixel_id)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(site_id) DO UPDATE SET
                    gtm_id = excluded.gtm_id,
                    ga4_id = excluded.ga4_id,
                    meta_pixel_id = excluded.meta_pixel_id,
                    tiktok_pixel_id = excluded.tiktok_pixel_id,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    site_id,
                    tracking["gtm_id"],
                    tracking["ga4_id"],
                    tracking["meta_pixel_id"],
                    tracking["tiktok_pixel_id"],
                ),
            )
        return self.get_tracking(site_id)
