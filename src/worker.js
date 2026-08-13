// uni-mail-whatsapp: Forward university Gmail emails to WhatsApp in near real-time.
// Runs as a Cloudflare Worker with a 1-minute cron trigger.

// ── Gmail API helpers ──

async function getAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error("Failed to get access token: " + JSON.stringify(json));
  return json.access_token;
}

async function gmailApi(accessToken, endpoint) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getNewEmails(accessToken, afterTimestamp) {
  // Gmail uses epoch seconds for the "after:" query
  const afterSec = Math.floor(afterTimestamp / 1000);
  const query = encodeURIComponent(`after:${afterSec} is:inbox`);
  const list = await gmailApi(accessToken, `messages?q=${query}&maxResults=10`);

  if (!list.messages || list.messages.length === 0) return [];

  const emails = [];
  for (const msg of list.messages) {
    const full = await gmailApi(accessToken, `messages/${msg.id}?format=full`);
    emails.push(parseEmail(full));
  }
  return emails;
}

function parseEmail(msg) {
  const headers = msg.payload?.headers || [];
  const get = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";

  let body = "";
  const attachments = [];

  function scanParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.mimeType === "text/plain" && !body) {
        if (part.body?.data) body = decodeBase64Url(part.body.data);
      }
      
      // Look for attachments
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0
        });
      }
      
      if (part.parts) scanParts(part.parts);
    }
  }

  if (msg.payload?.body?.data && !msg.payload.parts) {
    body = decodeBase64Url(msg.payload.body.data);
  } else {
    scanParts(msg.payload?.parts);
  }

  // Clean up the body - remove excessive whitespace and limit length
  body = body.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length > 4000) body = body.substring(0, 4000) + "\n\n[...Message Truncated...]";

  // Limit attachments to < 5MB total or individual (to prevent Worker timeouts/OOM)
  const validAttachments = attachments.filter(a => a.size < 5 * 1024 * 1024);

  return {
    id: msg.id,
    from: get("From"),
    subject: get("Subject"),
    date: get("Date"),
    snippet: msg.snippet || "",
    body,
    internalDate: parseInt(msg.internalDate || "0"),
    attachments: validAttachments
  };
}

function decodeBase64Url(data) {
  try {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

async function getAttachment(accessToken, messageId, attachmentId) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Gmail attachment fetch failed: ${res.status}`);
  const json = await res.json();
  return decodeBase64UrlToBytes(json.data);
}

function decodeBase64UrlToBytes(data) {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

// ── Beautiful WhatsApp formatting ──

function formatEmailMessage(email) {
  const lines = [];

  lines.push("╔══════════════════════╗");
  lines.push("║  📧 *New Email*        ║");
  lines.push("╚══════════════════════╝");
  lines.push("");

  // Parse sender name
  const fromMatch = email.from.match(/^(.+?)\s*<(.+)>$/);
  const senderName = fromMatch ? fromMatch[1].replace(/"/g, "") : email.from;
  const senderEmail = fromMatch ? fromMatch[2] : email.from;

  lines.push(`👤 *From:* ${senderName}`);
  lines.push(`📮 ${senderEmail}`);
  lines.push(`📌 *Subject:* ${email.subject || "(No subject)"}`);
  lines.push(`🕐 ${email.date}`);
  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━");

  if (email.body) {
    lines.push("");
    lines.push(email.body);
  } else if (email.snippet) {
    lines.push("");
    lines.push(`_${email.snippet}_`);
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("⚡ _uni-mail-whatsapp_");

  return lines.join("\n");
}

function formatSummaryMessage(count) {
  return `📬 *${count} new email${count > 1 ? "s" : ""}* forwarded to WhatsApp!`;
}

// ── Green API ──

async function sendWhatsApp(env, message) {
  const base = env.GREENAPI_API_URL.replace(/\/+$/, "");
  const url = `${base}/waInstance${env.GREENAPI_ID_INSTANCE}/sendMessage/${env.GREENAPI_API_TOKEN}`;
  const chatId = env.GREENAPI_CHAT_ID.includes("@") ? env.GREENAPI_CHAT_ID : `${env.GREENAPI_CHAT_ID}@c.us`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, message }),
  });
  if (!res.ok) throw new Error("WhatsApp send failed: " + await res.text());
}

async function sendWhatsAppFile(env, fileBytes, filename, mimeType, caption) {
  const base = env.GREENAPI_API_URL.replace(/\/+$/, "");
  const url = `${base}/waInstance${env.GREENAPI_ID_INSTANCE}/sendFileByUpload/${env.GREENAPI_API_TOKEN}`;
  const chatId = env.GREENAPI_CHAT_ID.includes("@") ? env.GREENAPI_CHAT_ID : `${env.GREENAPI_CHAT_ID}@c.us`;

  const blob = new Blob([fileBytes], { type: mimeType });
  const formData = new FormData();
  formData.append("chatId", chatId);
  formData.append("file", blob, filename);
  if (caption) {
    formData.append("caption", caption);
  }

  const res = await fetch(url, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error("WhatsApp file send failed: " + await res.text());
}

// ── Cloudflare Worker ──

export default {
  // Cron trigger: runs every 1 minute
  async scheduled(event, env, ctx) {
    try {
      // Get last checked timestamp from KV (default: 5 minutes ago)
      const lastChecked = parseInt(await env.MAIL_STATE.get("lastChecked") || "0");
      const now = Date.now();

      // If first run, only check last 5 minutes to avoid flooding
      const checkFrom = lastChecked > 0 ? lastChecked : now - 5 * 60 * 1000;

      // Get access token and fetch new emails
      const accessToken = await getAccessToken(env);
      const emails = await getNewEmails(accessToken, checkFrom);

      if (emails.length > 0) {
        // Sort by date (oldest first) so they arrive in order
        emails.sort((a, b) => a.internalDate - b.internalDate);

        // Filter out emails we've already seen (by checking internalDate > lastChecked)
        const newEmails = lastChecked > 0
          ? emails.filter(e => e.internalDate > lastChecked)
          : emails;

        // Send each email to WhatsApp
        for (const email of newEmails) {
          const msg = formatEmailMessage(email);
          await sendWhatsApp(env, msg);
          await new Promise(r => setTimeout(r, 500));

          if (email.attachments && email.attachments.length > 0) {
            for (const att of email.attachments) {
              try {
                const bytes = await getAttachment(accessToken, email.id, att.attachmentId);
                await sendWhatsAppFile(env, bytes, att.filename, att.mimeType, `📎 ${att.filename}`);
                await new Promise(r => setTimeout(r, 1000));
              } catch (e) {
                console.error("Attachment err:", e);
                await sendWhatsApp(env, `⚠️ Failed to forward attachment: ${att.filename}`);
              }
            }
          }
        }

        if (newEmails.length > 0) {
          console.log(`Forwarded ${newEmails.length} new email(s) to WhatsApp`);
        }
      }

      // Update last checked timestamp
      await env.MAIL_STATE.put("lastChecked", String(now));

    } catch (err) {
      console.error("Error:", err.message || err);
    }
  },

  // HTTP handler: health check & webhooks
  async fetch(request, env) {
    // Dashboard API: return JSON status when called from AutoHub
    if (request.headers.get("X-Dashboard") === "true") {
      try {
        const lastChecked = await env.MAIL_STATE.get("lastChecked") || "0";
        return new Response(JSON.stringify({
          lastCheck: lastChecked !== "0" ? new Date(parseInt(lastChecked)).toISOString() : null,
          status: "active",
          checkInterval: "1 minute"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, status: "error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (request.method === "GET") {
      return new Response("✅ uni-mail-whatsapp is running! Emails are checked every minute.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (request.method === "POST") {
      try {
        let isManualCheck = false;
        let replyChatId = env.GREENAPI_CHAT_ID.includes("@") ? env.GREENAPI_CHAT_ID : `${env.GREENAPI_CHAT_ID}@c.us`;

        // Check if it's a webhook from Green API
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const body = await request.json();
          
          if (body.typeWebhook === "incomingMessageReceived") {
            const text = body.messageData?.textMessageData?.textMessage?.toLowerCase().trim() || "";
            const senderId = body.senderData?.chatId;

            // Only allow the authorized user to trigger this
            if (senderId === replyChatId && (text === "email" || text === "emails" || text === "mail")) {
              isManualCheck = true;
            } else {
              return new Response("Ignored", { status: 200 }); // Ignore other messages silently
            }
          }
        } else {
          // If it's not JSON, assume it's a generic manual POST trigger (e.g. from curl)
          isManualCheck = true;
        }

        if (isManualCheck) {
          const now = Date.now();
          const checkFrom = now - 10 * 60 * 1000; // Last 10 minutes

          // Send a quick acknowledgment so the user knows we're checking
          const ackRes = await fetch(`${env.GREENAPI_API_URL.replace(/\/+$/, "")}/waInstance${env.GREENAPI_ID_INSTANCE}/sendMessage/${env.GREENAPI_API_TOKEN}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: replyChatId, message: "🔄 Checking your university inbox..." }),
          });

          const accessToken = await getAccessToken(env);
          const emails = await getNewEmails(accessToken, checkFrom);

          if (emails.length === 0) {
            await sendWhatsApp(env, "📭 No new emails in the last 10 minutes.");
            return new Response("No new emails", { status: 200 });
          }

          emails.sort((a, b) => a.internalDate - b.internalDate);
          for (const email of emails) {
            await sendWhatsApp(env, formatEmailMessage(email));
            await new Promise(r => setTimeout(r, 500));

            if (email.attachments && email.attachments.length > 0) {
              for (const att of email.attachments) {
                try {
                  const bytes = await getAttachment(accessToken, email.id, att.attachmentId);
                  await sendWhatsAppFile(env, bytes, att.filename, att.mimeType, `📎 ${att.filename}`);
                  await new Promise(r => setTimeout(r, 1000));
                } catch (e) {
                  console.error("Attachment err:", e);
                  await sendWhatsApp(env, `⚠️ Failed to forward attachment: ${att.filename}`);
                }
              }
            }
          }

          await env.MAIL_STATE.put("lastChecked", String(now));
          return new Response(`Forwarded ${emails.length} email(s)`, { status: 200 });
        }

        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error(err);
        return new Response("Error: " + (err.message || "unknown"), { status: 500 });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
