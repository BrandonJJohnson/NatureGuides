# Cloud backup setup (iNaturalist Highlights)

`iNaturalistHighlights.html` can save its backup file straight to **OneDrive**, **Google Drive** and
**Dropbox**. Each service needs a free "app registration" that identifies this site. Once you paste
its client ID into [`shared/cloud.json`](shared/cloud.json), that service shows up in the
**Backup data file** panel with *Connect*, *Save now*, *Load backup* and *Auto-save*. A service with
a blank client ID stays hidden.

No secrets are involved: these are public client IDs, safe to commit. Visitors sign in with their own
accounts, and their tokens stay in their own browser.

**iCloud and Box** have no sign-in a static website can use without a server. They work through
their desktop sync folders (*Link auto-save file…* or *Export to file*) and, on phones, the
*Share…* button → Files / Box app. The help text in the panel explains this to visitors.

## Redirect URI (use for every service)

```
https://brandonjjohnson.github.io/NatureGuides/cloud-callback.html
```

For local testing, also add:

```
http://localhost:8765/cloud-callback.html
```

## OneDrive (Microsoft)

1. Go to <https://entra.microsoft.com> → **App registrations** → **New registration**.
2. Name: `Louisiana Field Guides`. Supported account types: **Accounts in any organizational
   directory and personal Microsoft accounts**.
3. Redirect URI: platform **Single-page application (SPA)**, then paste the URI above. Add the
   localhost one under **Authentication** afterwards. It must be the SPA platform, not "Web".
4. **API permissions** → Microsoft Graph → Delegated: `Files.ReadWrite.AppFolder`, `User.Read`
   and `offline_access`.
5. Copy **Application (client) ID** into `"onedrive": { "clientId": "…" }`.

The file is saved as `inat-highlights-backup.zip` in **OneDrive › Apps › Louisiana Field Guides**.
Microsoft keeps a browser sign-in for about a day; after that the panel asks you to reconnect.

## Google Drive

1. Go to <https://console.cloud.google.com> → create a project → **APIs & Services** → **Library**
   → enable **Google Drive API**.
2. **OAuth consent screen**: choose External, then add the scope `.../auth/drive.file`. Publish the app;
   while it is in "Testing", only the test users you list can sign in.
3. **Credentials** → **Create credentials** → **OAuth client ID** → **Web application**.
   - Authorized JavaScript origins: `https://brandonjjohnson.github.io` and
     `http://localhost:8765`
   - Authorized redirect URIs: the callback URIs above
4. Copy the **Client ID** (`….apps.googleusercontent.com`) into `"gdrive": { "clientId": "…" }`.

The file is saved as `inat-highlights-backup.zip` in **My Drive**. The `drive.file` permission only
lets the page see files it created. Google browser sign-ins last about an hour, so auto-save
pauses until you click **Reconnect**.

## Dropbox

1. Go to <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped access** →
   **App folder**. Name it, e.g. `Louisiana Field Guides`.
2. **Permissions** tab: tick `files.metadata.read`, `files.content.read`,
   `files.content.write`, `account_info.read`, then **Submit**.
3. **Settings** tab: add both redirect URIs under OAuth 2 → Redirect URIs, and set **Allow public
   clients (Implicit Grant & PKCE)** to *Allow*.
4. Copy the **App key** into `"dropbox": { "clientId": "…" }`.

The file is saved in **Dropbox › Apps › (your app name)**. New Dropbox apps allow 500 users until you
use **Apply for production** in the app console.

## After editing `shared/cloud.json`

Commit and push. GitHub Pages picks up the change on its next rebuild, with no other code changes needed.
