# Sitecraft administration

Sitecraft is a small, self-hosted site administration app. The Python FastAPI service stores sites, posts, and tracking settings in SQLite. A Node.js/Express dashboard provides the admin UI and proxies API requests.

## Features

- Manage multiple sites and their domain names
- Draft, edit, publish, and delete posts
- Preview published posts at `/p/{site-id}/{slug}`
- Configure Google Tag Manager, Google Analytics 4, Meta Pixel, and TikTok Pixel IDs per site
- Require visitor consent before tracking scripts load on published posts
- List, create/update, and delete simple A, AAAA, CNAME, and TXT records in AWS Route 53
- Protect administrative API actions with an admin password and an internal API token

Published post bodies are rendered as plain text, not executable HTML. Posts are served on this app's host; adding a domain or DNS record does not automatically configure custom-domain hosting or TLS.

## Configure and run

1. Copy `.env.example` to `.env`.
2. Set a strong `ADMIN_PASSWORD` and a separate random `API_ADMIN_TOKEN`.
3. If you want live Route 53 operations, supply AWS credentials with permissions for the intended hosted zones.
4. Start the app:

   ```sh
   docker compose up --build
   ```

Open [http://localhost:3000](http://localhost:3000) and sign in using `ADMIN_PASSWORD`. The API is internal to the Compose network; it is not published directly to the host. SQLite data persists in the `site-data` Docker volume.

Generate secret values locally (do not commit them):

```sh
openssl rand -hex 32
```

The AWS SDK uses the environment variables in `.env` and `AWS_REGION`. Limit the AWS identity's Route 53 permissions to the intended hosted zones. The app restricts record names to a site's domain and subdomains, and supports only simple A, AAAA, CNAME, and TXT records.

DNS changes are live and can interrupt a site. Do not expose the admin service over public HTTP; put it behind HTTPS and appropriate network controls before remote use.

## Local development

Configure `ADMIN_PASSWORD`, `API_ADMIN_TOKEN`, and AWS environment variables in your shell, then start the API:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r api/requirements.txt
cd api
uvicorn main:app --reload
```

In another terminal:

```sh
cd web
npm ci
API_ORIGIN=http://localhost:8000 npm start
```

Open [http://localhost:3000](http://localhost:3000). AWS credentials are only needed for DNS operations. For local API access, set the same `API_ADMIN_TOKEN` in both services; the web server passes it to the API after checking the admin password.

## API

Administrative routes require the internal `X-Admin-Token` header:

- `GET/POST /api/sites`
- `PUT/DELETE /api/sites/{site_id}`
- `GET/POST /api/sites/{site_id}/posts`
- `PUT/DELETE /api/posts/{post_id}`
- `GET/PUT /api/sites/{site_id}/tracking`
- `GET/PUT/DELETE /api/sites/{site_id}/dns`

Published posts are available without admin authentication at `GET /api/public/{site_id}/{slug}`. Health checks use `GET /api/health`.

## Wix CMS GitHub sync

`page.js` is a Wix Velo page script for exporting collections to GitHub and importing their JSON exports back into Wix. Add page elements with these IDs in the Wix editor:

- Inputs: `githubTokenInput`, `githubOwnerInput`, `githubRepositoryInput`, `githubBranchInput`, `githubPathInput`, `githubCollectionsInput`, and `githubMessageInput`
- Buttons: `githubSyncButton` and `githubImportButton`
- Status/loading elements: `githubStatusText` and `githubLoadingBox`

Enter one or more Wix collection IDs in `githubCollectionsInput`, separated by commas or newlines. For a single collection, `githubPathInput` can be a fixed file path. For multiple collections, include `{collection}` in the path (for example, `content/{collection}.json`). Exports include all query pages, not only the first 1,000 records.

Import saves each record by its Wix `_id`, creating missing records and updating matching records; it does not delete records from Wix. GitHub files must be JSON exports for the matching collection. Imports and exports can partially complete if an operation fails, and the status reports progress.

Restrict the Wix page and collection permissions to trusted editors. The GitHub token is entered and used in the browser, so do not publish this page for unrestricted access. Use a fine-grained GitHub token with only the required repository contents read/write access.

## Checks

```sh
python -m unittest discover -s api/tests
npm --prefix web run check
docker compose config --quiet
```
