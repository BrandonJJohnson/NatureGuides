# Cloud backup setup (iNaturalist Highlights)

`iNaturalistHighlights.html` can save its backup file straight to **OneDrive**, **Google Drive** and
**Dropbox**. Each service needs a free one-time "app registration" that tells it this site may ask
for access.

**Visitors set this up themselves, in the browser.** In the **Backup data file** panel, each service
has a **Set up** button that opens a step-by-step guide. The guide links to the right console page,
offers copy buttons for the exact redirect address and permissions, and checks the pasted ID before
connecting. The ID is kept in that browser's own storage and included in every backup file, so
importing a backup on another device (or sharing it with a friend) carries the setup along. Sign-in
tokens never leave the browser.

The sections below match the steps in the guide, for reference.

**Optional site-wide default:** if you put client IDs in [`shared/cloud.json`](shared/cloud.json),
every visitor can use them without running the guide. A visitor's own setup always takes priority.
These are public client IDs, safe to commit.

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

## Site-wide defaults

To give every visitor a ready-made setup, paste the IDs into `shared/cloud.json`, then commit and push.
GitHub Pages picks up the change on its next rebuild.
