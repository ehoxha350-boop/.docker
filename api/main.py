import os
import re
import secrets
import sqlite3
from typing import Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from cms import CmsStore, make_slug
from dns import Route53Dns


def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    expected = os.getenv("API_ADMIN_TOKEN", "")
    if not expected or not x_admin_token or not secrets.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=401, detail="Admin authentication required")


def normalize_domain(value: str) -> str:
    domain = value.strip().rstrip(".").lower()
    if "://" in domain or "/" in domain or ":" in domain or len(domain) > 253:
        raise ValueError("Enter a domain name without a scheme, port, or path")
    try:
        ascii_domain = domain.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise ValueError("Invalid domain name") from error
    if len(ascii_domain) > 253:
        raise ValueError("Domain name is too long")
    labels = ascii_domain.split(".")
    if len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    ):
        raise ValueError("Enter a valid fully qualified domain name")
    return ascii_domain


class SiteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    domain: str = Field(min_length=3, max_length=253)
    hosted_zone_id: str = Field(default="", max_length=128)

    @field_validator("name", "hosted_zone_id")
    @classmethod
    def strip_value(cls, value: str) -> str:
        return value.strip()

    @field_validator("domain")
    @classmethod
    def valid_domain(cls, value: str) -> str:
        return normalize_domain(value)

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value: str) -> str:
        if not value:
            raise ValueError("Site name must not be blank")
        return value


class SiteUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    hosted_zone_id: str = Field(default="", max_length=128)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Site name must not be blank")
        return value

    @field_validator("hosted_zone_id")
    @classmethod
    def clean_zone_id(cls, value: str) -> str:
        return value.strip()


class PostFields(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    slug: str = Field(default="", max_length=180)
    body: str = Field(max_length=100_000)
    status: Literal["draft", "published"] = "draft"

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Post title must not be blank")
        return value

    @field_validator("slug")
    @classmethod
    def clean_slug(cls, value: str) -> str:
        value = value.strip().lower()
        if value and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("Slug may contain lowercase letters, numbers, and hyphens")
        return value


class TrackingSettings(BaseModel):
    gtm_id: str = Field(default="", max_length=32)
    ga4_id: str = Field(default="", max_length=32)
    meta_pixel_id: str = Field(default="", max_length=32)
    tiktok_pixel_id: str = Field(default="", max_length=64)

    @field_validator("gtm_id", "ga4_id", "meta_pixel_id", "tiktok_pixel_id")
    @classmethod
    def validate_tracking_id(cls, value: str, info) -> str:
        value = value.strip().upper()
        patterns = {
            "gtm_id": r"(?:GTM-[A-Z0-9]+)?",
            "ga4_id": r"(?:G-[A-Z0-9]+)?",
            "meta_pixel_id": r"(?:[0-9]{5,32})?",
            "tiktok_pixel_id": r"(?:[A-Z0-9_-]{5,64})?",
        }
        if not re.fullmatch(patterns[info.field_name], value):
            raise ValueError(f"Invalid {info.field_name.replace('_', ' ')}")
        return value


class DnsRecord(BaseModel):
    name: str = Field(min_length=3, max_length=253)
    type: Literal["A", "AAAA", "CNAME", "TXT"]
    ttl: int = Field(default=300, ge=60, le=86400)
    values: list[str] = Field(min_length=1, max_length=20)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return normalize_domain(value)


app = FastAPI(title="Site Administration API", version="1.0.0")
store = CmsStore(os.getenv("DATABASE_PATH", "data/sitecraft.db"))


def get_site_or_404(site_id: int) -> dict:
    site = store.get_site(site_id)
    if site is None:
        raise HTTPException(status_code=404, detail="Site not found")
    return site


def get_dns_client() -> Route53Dns:
    try:
        return Route53Dns()
    except BotoCoreError as error:
        raise HTTPException(status_code=503, detail="AWS Route 53 is not configured") from error


def handle_integrity_error(error: sqlite3.IntegrityError, resource: str) -> HTTPException:
    if "UNIQUE constraint failed" in str(error):
        return HTTPException(status_code=409, detail=f"A {resource} with that domain or slug already exists")
    raise error


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sites", dependencies=[Depends(require_admin)])
def list_sites() -> list[dict]:
    return store.list_sites()


@app.post("/api/sites", status_code=201, dependencies=[Depends(require_admin)])
def create_site(site: SiteCreate) -> dict:
    try:
        return store.create_site(site.name, site.domain, site.hosted_zone_id or None)
    except sqlite3.IntegrityError as error:
        raise handle_integrity_error(error, "site") from error


@app.put("/api/sites/{site_id}", dependencies=[Depends(require_admin)])
def update_site(site_id: int, site: SiteUpdate) -> dict:
    updated = store.update_site(site_id, site.name, site.hosted_zone_id or None)
    if updated is None:
        raise HTTPException(status_code=404, detail="Site not found")
    return updated


@app.delete("/api/sites/{site_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_site(site_id: int) -> Response:
    if not store.delete_site(site_id):
        raise HTTPException(status_code=404, detail="Site not found")
    return Response(status_code=204)


@app.get("/api/sites/{site_id}/posts", dependencies=[Depends(require_admin)])
def list_posts(site_id: int) -> list[dict]:
    get_site_or_404(site_id)
    return store.list_posts(site_id)


@app.post("/api/sites/{site_id}/posts", status_code=201, dependencies=[Depends(require_admin)])
def create_post(site_id: int, post: PostFields) -> dict:
    get_site_or_404(site_id)
    slug = post.slug or make_slug(post.title)
    try:
        return store.create_post(site_id, post.title, slug, post.body, post.status)
    except sqlite3.IntegrityError as error:
        raise handle_integrity_error(error, "post slug") from error


@app.put("/api/posts/{post_id}", dependencies=[Depends(require_admin)])
def update_post(post_id: int, post: PostFields) -> dict:
    slug = post.slug or make_slug(post.title)
    try:
        updated = store.update_post(post_id, post.title, slug, post.body, post.status)
    except sqlite3.IntegrityError as error:
        raise handle_integrity_error(error, "post slug") from error
    if updated is None:
        raise HTTPException(status_code=404, detail="Post not found")
    return updated


@app.delete("/api/posts/{post_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_post(post_id: int) -> Response:
    if not store.delete_post(post_id):
        raise HTTPException(status_code=404, detail="Post not found")
    return Response(status_code=204)


@app.get("/api/sites/{site_id}/tracking", dependencies=[Depends(require_admin)])
def get_tracking(site_id: int) -> dict:
    get_site_or_404(site_id)
    return store.get_tracking(site_id)


@app.put("/api/sites/{site_id}/tracking", dependencies=[Depends(require_admin)])
def save_tracking(site_id: int, tracking: TrackingSettings) -> dict:
    get_site_or_404(site_id)
    return store.save_tracking(site_id, tracking.model_dump())


@app.get("/api/sites/{site_id}/dns", dependencies=[Depends(require_admin)])
def list_dns_records(site_id: int) -> list[dict]:
    site = get_site_or_404(site_id)
    if not site["hosted_zone_id"]:
        raise HTTPException(status_code=400, detail="Set a Route 53 hosted zone ID for this site first")
    try:
        return get_dns_client().list_records(site["hosted_zone_id"], site["domain"])
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (BotoCoreError, ClientError) as error:
        raise HTTPException(status_code=502, detail="Unable to read DNS records from Route 53") from error


@app.put("/api/sites/{site_id}/dns", dependencies=[Depends(require_admin)])
def upsert_dns_record(site_id: int, record: DnsRecord) -> dict:
    site = get_site_or_404(site_id)
    if not site["hosted_zone_id"]:
        raise HTTPException(status_code=400, detail="Set a Route 53 hosted zone ID for this site first")
    try:
        return get_dns_client().upsert_record(
            site["hosted_zone_id"], site["domain"], record.name, record.type, record.ttl, record.values
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (BotoCoreError, ClientError) as error:
        raise HTTPException(status_code=502, detail="Unable to update DNS record in Route 53") from error


@app.delete("/api/sites/{site_id}/dns", status_code=204, dependencies=[Depends(require_admin)])
def delete_dns_record(site_id: int, name: str, record_type: Literal["A", "AAAA", "CNAME", "TXT"]) -> Response:
    site = get_site_or_404(site_id)
    if not site["hosted_zone_id"]:
        raise HTTPException(status_code=400, detail="Set a Route 53 hosted zone ID for this site first")
    try:
        deleted = get_dns_client().delete_record(
            site["hosted_zone_id"], site["domain"], normalize_domain(name), record_type
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (BotoCoreError, ClientError) as error:
        raise HTTPException(status_code=502, detail="Unable to delete DNS record from Route 53") from error
    if not deleted:
        raise HTTPException(status_code=404, detail="DNS record not found")
    return Response(status_code=204)


@app.get("/api/public/{site_id}/{slug}")
def public_post(site_id: int, slug: str) -> dict:
    post = store.get_public_post(site_id, slug)
    if post is None:
        raise HTTPException(status_code=404, detail="Published post not found")
    return post
