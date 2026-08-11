# University Mail WhatsApp Bot 📧

A Cloudflare Worker that integrates with Green API and the Gmail API to seamlessly forward emails from your university email account directly into your WhatsApp chat.

## Features

### 1. Automatic Background Email Fetching
Runs automatically every minute (`* * * * *` Cron Trigger) to securely query the Gmail API for newly received unread emails.
- Reads email metadata (Subject, Sender, Date).
- Securely processes email body payloads.
- Marks forwarded emails as "read" via the Gmail API to avoid duplicate forwards.
- Tracks its state using Cloudflare KV Storage (`MAIL_STATE`).

### 2. Full Text & Rich Formatting
Emails are extracted and cleaned up, providing up to **4,000 characters** of the email body cleanly formatted directly in your WhatsApp message.

### 3. Native Attachment Support (NEW)
When emails contain attachments (such as PDFs, photos, or documents), the bot detects them and securely downloads the raw binary data directly from Google servers.
- Automatically handles base64 streaming.
- Uploads attachments up to **5MB** to Green API (`sendFileByUpload`).
- Delivers attachments to you as native WhatsApp file messages!

### 4. On-Demand Checks
Send any of the following trigger words to your bot on WhatsApp to force an immediate background check:
- `email`
- `emails`
- `mail`

Note: It will reply with a confirmation message while fetching the latest emails in the background.

## Architecture & Integration
Green API only supports setting a single webhook URL per instance. Therefore, this bot acts as an internal microservice. 
The **`myslt-whatsapp-bot`** handles the public webhook and asynchronously routes all incoming text messages to this bot via a Cloudflare **Service Binding**, ensuring zero conflict between the SLT features and the Email features.

## Deployment

Deploy using Wrangler:

```bash
npx wrangler deploy
```

Ensure your `wrangler.toml` is configured with the following bindings:
- `MAIL_STATE`: KV Namespace binding.

Environment variables (Secrets):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GREENAPI_API_URL`
- `GREENAPI_ID_INSTANCE`
- `GREENAPI_API_TOKEN`
- `GREENAPI_CHAT_ID`
