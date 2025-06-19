# 2FacTrac – Chrome Extension

This extension surfaces the latest verification **code** or **link** that it finds in your Gmail inbox and shows it in a handy popup.

---

## ⚠️ Google OAuth set-up (fixes the `400 invalid_request` / "Access blocked" error)

Google no longer allows the legacy *out-of-band* OAuth flow.  If you try to use the extension without first creating your own OAuth credentials you will see the following message when the Gmail authorisation page opens:

> 400 – invalid_request / Access blocked: This app uses a request that Google doesn’t allow.

Follow the steps below **once** to create a compliant OAuth Client ID and wire it into the extension.

1.  Open the [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and **create a project** (or pick an existing one).
2.  Click **Create credentials → OAuth client ID**.
3.  For *Application type* choose **Chrome App** (not *Web* or *Desktop*).
4.  Enter your extension ID (you will see it after you have loaded the unpacked extension once – you can change it later in *OAuth consent screen → Edit app*) and a name such as `2FacTrac`.
5.  After the client is created copy the **Client ID** – it ends in `.apps.googleusercontent.com`.
6.  Duplicate `manifest.json.example` → `manifest.json` (the real file is ignored by Git).
7.  Paste the Client ID into the `oauth2.client_id` field inside the new `manifest.json`.
8.  Make sure the `oauth2.scopes` array contains at least `https://www.googleapis.com/auth/gmail.readonly`.
9.  In Chrome/Brave/Edge visit `chrome://extensions`, **Remove** any previous version of 2FacTrac, then **Load unpacked** and select the repo folder again.
10. Click the extension; the Google login page will now show the consent screen instead of the error.

That’s it – the extension now has a modern, Google-approved authorisation flow.

---

## Development

```
# auto-reload the service-worker while developing
npm i -g crxjs@latest  # optional helper
crx watch
```

---

## Security note
The extension never leaves your browser; it requests **read-only** access to Gmail and only downloads the message bodies locally in order to extract verification codes/links.
