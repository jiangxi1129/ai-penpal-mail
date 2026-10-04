#!/usr/bin/env node
/**
 * mail-mcp — Self-hosted email MCP server (Gmail REST API backend)
 *
 * Why Gmail API instead of SMTP/IMAP:
 *   - Many proxy nodes block SMTP ports (587/465/993) — typical anti-abuse policy
 *   - HTTPS:443 to googleapis.com goes through any HTTP proxy fine
 *   - Gmail API offers richer query syntax (Gmail-native search) than IMAP
 *
 * Run modes:
 *   stdio:  node mail-mcp.mjs            (local Claude Code)
 *   sse:    node mail-mcp.mjs --sse      (remote via tunnel)
 *
 * Required .env:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   MAIL_USER (the gmail address)
 *   MAIL_FROM (display name + address, e.g. "Mira <mira.ai@gmail.com>")
 *   PROXY (optional, e.g. http://127.0.0.1:7890)
 *   PORT (default 3457)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { google } from "googleapis";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolve } from "node:path";
import "dotenv/config";
import { createImapBackend } from "./imap-backend.mjs";
import {
  emptyMailArchive,
  listMailArchiveConversations,
  loadMailArchive,
  pageMailArchive,
  saveMailArchive,
  upsertMailArchive,
} from "./mail-archive.mjs";
import {
  ensureMailContact,
  loadMailContacts,
  publicMailContact,
  replaceMailAddresses,
  resolveMailContact,
  saveMailContacts,
} from "./mail-contacts.mjs";
import { assertThreadRecipients, decodeMessageBody, headersObject, isUnusableReplyTarget, looksLikeReply, markReplyRead, pickReplyTarget, replyBaseSubject } from "./mail-safety.mjs";

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const MAIL_USER = process.env.MAIL_USER;
const MAIL_FROM = process.env.MAIL_FROM || `${process.env.MAIL_FROM_NAME || ""} <${MAIL_USER}>`.trim();
const PROXY = process.env.PROXY || null;
// 邮箱类型：gmail（默认，走 Gmail API）或 163 / 126 / qq / yahoo / icloud / imap（走 IMAP+SMTP + 授权码，见 imap-backend.mjs）
const PROVIDER = String(process.env.MAIL_PROVIDER || "gmail").trim().toLowerCase();
const IS_GMAIL = PROVIDER === "gmail";
const MISSING_ENV = (IS_GMAIL ? ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "MAIL_USER"] : ["MAIL_USER", "MAIL_PASSWORD"]).filter((k) => !String(process.env[k] || "").trim());
if (MISSING_ENV.length) {
  console.error(`[mail-mcp] 缺少必填环境变量：${MISSING_ENV.join(", ")}（照 .env.example 填）`);
  process.exit(1);
}
const MAIL_READ_TOKEN = (process.env.MAIL_READ_TOKEN || "").trim();
const MAIL_ARCHIVE_FILE = resolve(process.env.MAIL_ARCHIVE_FILE || "./data/mail-archive.json");
const MAIL_CONTACTS_FILE = resolve(process.env.MAIL_CONTACTS_FILE || "./data/mail-contacts.json");
const MAIL_ARCHIVE_SINCE = process.env.MAIL_ARCHIVE_SINCE || "2026/01/01";
const MAIL_ARCHIVE_SINCE_DASH = MAIL_ARCHIVE_SINCE.replace(/\//g, "-");
const MAIL_ARCHIVE_INTERVAL_MS = 10 * 60 * 1000;

const backend = IS_GMAIL ? null : createImapBackend({ provider: PROVIDER, user: MAIL_USER, password: process.env.MAIL_PASSWORD, from: MAIL_FROM, proxy: PROXY });
if (backend) console.error(`[mail-mcp] 邮箱类型 ${backend.describe}`);

// Configure global axios/gaxios agent so Gmail API calls go through PROXY when set
// 刷新令牌那一步走 google-auth-library 自己的传输层，google.options 管不到；它认环境变量里的代理
if (PROXY) { process.env.HTTPS_PROXY = PROXY; process.env.HTTP_PROXY = PROXY; }   // .env 里写明的 PROXY 优先，两条腿走同一条线
if (PROXY) {
  const agent = new HttpsProxyAgent(PROXY);
  google.options({ agent });
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, "http://localhost:9876/callback");
oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth: oauth2 });
const mailContacts = loadMailContacts(MAIL_CONTACTS_FILE);
const selfContact = ensureMailContact(mailContacts, MAIL_USER, process.env.MAIL_FROM_NAME || "");
if (selfContact.created) saveMailContacts(MAIL_CONTACTS_FILE, mailContacts);

// ═══════════════════════════════════════════════════════════════
// MIME helpers
// ═══════════════════════════════════════════════════════════════

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * MIME-encode a header that may contain a display name with non-ASCII chars.
 * "小明 <foo@gmail.com>" → "=?UTF-8?B?5bCP5piO?= <foo@gmail.com>"
 * Plain ASCII pass-through unchanged.
 */
function encodeAddressHeader(value) {
  if (!value) return value;
  // Multi-address: split on commas (outside angle brackets) and recurse
  if (value.includes(",")) {
    const parts = [];
    let depth = 0, buf = "";
    for (const ch of value) {
      if (ch === "<") depth++;
      else if (ch === ">") depth--;
      if (ch === "," && depth === 0) { parts.push(buf.trim()); buf = ""; }
      else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts.map(encodeAddressHeader).join(", ");
  }
  const m = value.match(/^(.+?)\s*<(.+)>\s*$/);
  if (!m) return value;
  const name = m[1].replace(/^["']|["']$/g, "").trim();
  const addr = m[2].trim();
  // ASCII-only name: still wrap in quotes if contains spaces
  if (/^[\x00-\x7F]*$/.test(name)) return name ? `${name} <${addr}>` : addr;
  const encoded = `=?UTF-8?B?${Buffer.from(name).toString("base64")}?=`;
  return `${encoded} <${addr}>`;
}

/**
 * Compose body with optional signature.
 * Per user spec: signature is optional. If absent, body is sent as-is.
 */
function composeBody(body, signature) {
  if (!signature || !signature.trim()) return body;
  return `${body}\n\n${signature}`;
}

/**
 * Build a simple text-only RFC822 message.
 */
function buildSimpleMessage({ from, to, cc, bcc, subject, body, replyTo, inReplyTo, references, smtp = false }) {
  const domain = String(MAIL_USER || "localhost").split("@").pop();
  const headers = [
    smtp ? `Date: ${new Date().toUTCString().replace("GMT", "+0000")}` : null,
    smtp ? `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}>` : null,
    `From: ${encodeAddressHeader(from)}`,
    `To: ${encodeAddressHeader(to)}`,
    cc ? `Cc: ${encodeAddressHeader(cc)}` : null,
    bcc && !smtp ? `Bcc: ${encodeAddressHeader(bcc)}` : null,   // SMTP 直寄时密送只放信封，不进信头（不然收件人看得见）
    replyTo ? `Reply-To: ${encodeAddressHeader(replyTo)}` : null,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean).join("\r\n");

  const encodedBody = Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return `${headers}\r\n\r\n${encodedBody}`;
}


/**
 * Decode a Gmail message (from messages.get) to a friendly summary.
 */
function summarizeMessage(msg) {
  const headers = {};
  for (const h of msg.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
  return {
    id: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet,
    labelIds: msg.labelIds,
    subject: headers.subject || "",
    from: headers.from || "",
    to: headers.to || "",
    date: headers.date || "",
    internalDate: msg.internalDate || "",
  };
}

async function listMessageSummaries(maxResults, labelIds, q) {
  if (backend) return backend.listMessageSummaries(maxResults, !q, q);
  const list = await gmail.users.messages.list({ userId: "me", maxResults, ...(labelIds ? { labelIds } : {}), ...(q ? { q: `${q} -in:spam -in:trash` } : {}) });
  const items = list.data.messages || [];
  const messages = await Promise.all(items.map(async (m) => {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
    return summarizeMessage(full.data);
  }));
  return { messages, total: list.data.resultSizeEstimate || 0 };
}

async function readMessage(id) {
  if (backend) return backend.readMessage(id);
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const summary = summarizeMessage(res.data);
  const body = await decodeMessageBody(gmail, id, res.data.payload);
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename) attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body?.size, attachmentId: part.body?.attachmentId });
    for (const child of part.parts || []) walk(child);
  };
  walk(res.data.payload);
  return { ...summary, text: body.text, bodyTruncated: body.bodyTruncated, bodyUnavailable: body.bodyUnavailable, attachments };
}

function extractAddresses(value) {
  const matches = String(value || "").match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(matches.map((address) => address.toLowerCase()))];
}

function addressName(value, address) {
  const source = String(value || "");
  const end = source.toLowerCase().indexOf(`<${address}>`);
  const prefix = end >= 0 ? source.slice(0, end).trimEnd() : "";
  let named = "";
  if (prefix.endsWith('"')) {
    const start = prefix.lastIndexOf('"', prefix.length - 2);
    if (start >= 0) named = prefix.slice(start + 1, -1).trim();
  } else if (prefix) {
    const start = Math.max(prefix.lastIndexOf(","), prefix.lastIndexOf(">"));
    named = prefix.slice(start + 1).trim();
  }
  return named && named.toLowerCase() !== address ? named : address.split("@")[0];
}

function contactForAddress(address) {
  const ensured = ensureMailContact(mailContacts, address);
  if (ensured.created) saveMailContacts(MAIL_CONTACTS_FILE, mailContacts);
  return publicMailContact(mailContacts, address);
}

// 没备注的联系人：只给对方自报的显示名 + 内部 id 尾码，绝不把邮箱地址交给 AI。地址在 data/mail-contacts.json 里，主人自己看。
function originalAddressLabel(name, address) {
  const original = String(name || "").trim();
  const folded = original.toLowerCase();
  const id = (mailContacts.contacts[address]?.id || "").slice(-4).toUpperCase();
  const usable = original && !original.includes("@") && folded !== address.split("@")[0];
  return usable ? `${original}（未备注 · ${id}）` : `未备注笔友 · ${id}`;
}

function publicAddressHeader(value) {
  return extractAddresses(value).map((address) => {
    const contact = contactForAddress(address);
    return { name: mailContacts.contacts[address]?.name ? contact.name : originalAddressLabel(addressName(value, address), address) };
  });
}

function publicMessage(message) {
  const result = {
    id: message.id,
    threadId: message.threadId,
    snippet: replaceMailAddresses(message.snippet, mailContacts),
    labelIds: message.labelIds,
    subject: replaceMailAddresses(message.subject, mailContacts),
    from: publicAddressHeader(message.from),
    to: publicAddressHeader(message.to),
    date: message.date,
    internalDate: message.internalDate,
  };
  if (Object.hasOwn(message, "text")) result.text = replaceMailAddresses(message.text, mailContacts);
  if (Object.hasOwn(message, "bodyTruncated")) result.bodyTruncated = Boolean(message.bodyTruncated);
  if (Object.hasOwn(message, "bodyUnavailable")) result.bodyUnavailable = Boolean(message.bodyUnavailable);
  if (Array.isArray(message.attachments)) {
    result.attachments = message.attachments.map((attachment) => ({
      filename: replaceMailAddresses(attachment?.filename, mailContacts),
      mimeType: attachment?.mimeType || "application/octet-stream",
      size: Number.isFinite(attachment?.size) ? attachment.size : 0,
    }));
  }
  return result;
}

function publicConversation(conversation) {
  const contact = contactForAddress(conversation.address);
  return {
    ...contact,
    name: mailContacts.contacts[conversation.address]?.name ? contact.name : originalAddressLabel(conversation.name, conversation.address),
    subject: replaceMailAddresses(conversation.subject, mailContacts),
    snippet: replaceMailAddresses(conversation.snippet, mailContacts),
    date: conversation.date || "",
    direction: conversation.direction === "outgoing" ? "outgoing" : "incoming",
    unreadCount: Number.isSafeInteger(conversation.unreadCount) && conversation.unreadCount > 0 ? conversation.unreadCount : 0,
  };
}

function conversationAddress(id) {
  try { return resolveMailContact(mailContacts, id); } catch { return ""; }
}

function resolveRecipients(value) {
  if (!value) return undefined;
  return String(value).split(",").map((reference) => resolveMailContact(mailContacts, reference)).join(", ");
}

function groupConversationSummaries(messages, maxResults) {
  const ownAddress = String(MAIL_USER || "").trim().toLowerCase();
  const grouped = new Map();
  for (const message of messages) {
    const outgoing = message.labelIds?.includes("SENT") || extractAddresses(message.from).includes(ownAddress);
    const addresses = outgoing ? extractAddresses(message.to).filter((address) => address !== ownAddress) : extractAddresses(message.from);
    for (const address of addresses) {
      const source = outgoing ? message.to : message.from;
      const latestMs = Number.parseInt(message.internalDate, 10) || Date.parse(message.date) || 0;
      const current = grouped.get(address);
      if (!current || latestMs > current.latestMs) {
        grouped.set(address, {
          address,
          name: addressName(source, address),
          subject: message.subject || "",
          snippet: message.snippet || "",
          date: message.date || "",
          latestMs,
          direction: outgoing ? "outgoing" : "incoming",
        });
      }
    }
  }
  return [...grouped.values()].sort((a, b) => b.latestMs - a.latestMs).slice(0, maxResults);
}

let mailArchive = emptyMailArchive(MAIL_ARCHIVE_SINCE_DASH);
let mailArchiveLoaded = false;
let mailArchiveLoadError = "";
let mailArchiveSyncPromise = null;
let mailArchiveSavePromise = Promise.resolve();
let mailArchiveSyncState = { syncing: false, phase: "waiting", fetched: 0, added: 0, error: "" };

function saveCurrentMailArchive() {
  mailArchiveSavePromise = mailArchiveSavePromise.catch(() => {}).then(() => saveMailArchive(MAIL_ARCHIVE_FILE, mailArchive));
  return mailArchiveSavePromise;
}

function archiveStatus() {
  return {
    ready: mailArchiveLoaded && !mailArchiveLoadError,
    initialComplete: mailArchive.initialComplete === true,
    syncing: mailArchiveSyncState.syncing,
    phase: mailArchiveSyncState.phase,
    messageCount: Object.keys(mailArchive.messages).length,
    fetched: mailArchiveSyncState.fetched,
    added: mailArchiveSyncState.added,
    lastSyncAt: mailArchive.lastSyncAt || "",
    error: mailArchiveLoadError || mailArchiveSyncState.error || "",
  };
}

function archiveMessage(message) {
  const ownAddress = String(MAIL_USER || "").trim().toLowerCase();
  const outgoing = message.labelIds?.includes("SENT") || extractAddresses(message.from).includes(ownAddress);
  const addresses = outgoing
    ? extractAddresses(message.to).filter((address) => address !== ownAddress)
    : extractAddresses(message.from).filter((address) => address !== ownAddress);
  const source = outgoing ? message.to : message.from;
  const body = String(message.text || "");
  return {
    id: message.id,
    threadId: message.threadId || "",
    contacts: addresses.map((address) => ({ address, name: addressName(source, address) })),
    direction: outgoing ? "outgoing" : "incoming",
    subject: message.subject || "",
    snippet: message.snippet || "",
    from: message.from || "",
    to: message.to || "",
    date: message.date || "",
    internalDate: message.internalDate || "",
    text: body.slice(0, 200000),
    truncated: body.length > 200000,
    attachments: message.attachments.map(({ filename, mimeType, size }) => ({ filename, mimeType, size })),
  };
}

function publicArchiveMessage(message) {
  const body = String(message.text || "");
  return {
    id: message.id,
    direction: message.direction === "outgoing" ? "outgoing" : "incoming",
    subject: replaceMailAddresses(message.subject, mailContacts),
    date: message.date || "",
    internalDate: message.internalDate || "",
    text: replaceMailAddresses(body.slice(0, 30000), mailContacts),
    truncated: message.truncated === true || body.length > 30000,
    attachments: Array.isArray(message.attachments) ? message.attachments.map(({ filename, mimeType, size }) => ({ filename: replaceMailAddresses(filename, mailContacts), mimeType, size })) : [],
  };
}

function archiveSyncQuery() {
  if (!mailArchive.initialComplete || !mailArchive.lastSyncAt) return `after:${MAIL_ARCHIVE_SINCE} -in:spam -in:trash`;
  const overlap = new Date(Date.parse(mailArchive.lastSyncAt) - 2 * 24 * 60 * 60 * 1000);
  const day = Number.isNaN(overlap.getTime()) ? MAIL_ARCHIVE_SINCE : overlap.toISOString().slice(0, 10).replace(/-/g, "/");
  return `after:${day} -in:spam -in:trash`;
}

async function syncMailArchive() {
  if (mailArchiveSyncPromise || !mailArchiveLoaded || mailArchiveLoadError) return mailArchiveSyncPromise;
  mailArchiveSyncPromise = (async () => {
    const initial = !mailArchive.initialComplete;
    mailArchiveSyncState = { syncing: true, phase: initial ? "initial" : "incremental", fetched: 0, added: 0, error: "" };
    let pageToken = "";
    do {
      const request = { userId: "me", q: archiveSyncQuery(), maxResults: 25 };
      if (pageToken) request.pageToken = pageToken;
      const list = await gmail.users.messages.list(request);
      const items = list.data.messages || [];
      const records = [];
      let pageError = null;
      for (const { id } of items) {
        if (mailArchive.messages[id]) continue;
        try {
          records.push(archiveMessage(await readMessage(id)));
        } catch (error) {
          if (error?.code !== 404) { pageError = error; break; }
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
      mailArchiveSyncState.fetched += records.length;
      mailArchiveSyncState.added += upsertMailArchive(mailArchive, records);
      await saveCurrentMailArchive();
      if (pageError) throw pageError;
      pageToken = list.data.nextPageToken || "";
      if (pageToken) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
    } while (pageToken);
    mailArchive.initialComplete = true;
    mailArchive.lastSyncAt = new Date().toISOString();
    mailArchiveSyncState.syncing = false;
    mailArchiveSyncState.phase = "idle";
    await saveCurrentMailArchive();
  })().catch((error) => {
    mailArchiveSyncState.syncing = false;
    mailArchiveSyncState.error = error?.message || "mail archive sync failed";
    console.error(`[mail-mcp] 存档同步失败：${mailArchiveSyncState.error}`);
  }).finally(() => { mailArchiveSyncPromise = null; });
  return mailArchiveSyncPromise;
}

async function startMailArchive() {
  try {
    mailArchive = await loadMailArchive(MAIL_ARCHIVE_FILE, MAIL_ARCHIVE_SINCE_DASH);
    mailArchiveLoaded = true;
    syncMailArchive();
    const timer = setInterval(syncMailArchive, MAIL_ARCHIVE_INTERVAL_MS);
    timer.unref();
  } catch (error) {
    mailArchiveLoadError = error?.message || "mail archive unavailable";
    console.error(`[mail-mcp] 存档读不进来，存档功能停用：${mailArchiveLoadError}`);
  }
}

async function archiveSentMessage(id) {
  if (!id || !mailArchiveLoaded || mailArchiveLoadError) return false;
  try {
    upsertMailArchive(mailArchive, [archiveMessage(await readMessage(id))]);
    await saveCurrentMailArchive();
    return true;
  } catch {
    return false;
  }
}

let conversationIndex = [];
let conversationIndexUpdatedAt = 0;
let conversationIndexPromise = null;

async function fetchConversationPage(pageToken = "") {
  const request = { userId: "me", q: `after:${MAIL_ARCHIVE_SINCE} -in:spam -in:trash`, maxResults: 60 };
  if (pageToken) request.pageToken = pageToken;
  const list = await gmail.users.messages.list(request);
  const items = list.data.messages || [];
  const messages = await Promise.all(items.map(async (message) => {
    const full = await gmail.users.messages.get({ userId: "me", id: message.id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
    return summarizeMessage(full.data);
  }));
  return { messages, nextPageToken: list.data.nextPageToken || "" };
}

function mergeConversationLists(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const conversation of list) {
      const current = merged.get(conversation.address);
      if (!current || conversation.latestMs > current.latestMs) merged.set(conversation.address, conversation);
    }
  }
  return [...merged.values()].sort((a, b) => b.latestMs - a.latestMs);
}

async function scanConversationIndex() {
  let pageToken = "";
  do {
    const page = await fetchConversationPage(pageToken);
    conversationIndex = mergeConversationLists(
      groupConversationSummaries(page.messages, page.messages.length),
      conversationIndex
    );
    pageToken = page.nextPageToken;
    if (pageToken) await new Promise((resolve) => setTimeout(resolve, 250));
  } while (pageToken);
  return conversationIndex;
}

function warmConversationIndex() {
  if (conversationIndexPromise || Date.now() - conversationIndexUpdatedAt < 3600000) return;
  conversationIndexPromise = scanConversationIndex().then((conversations) => {
    conversationIndexUpdatedAt = Date.now();
    return conversations;
  }).catch(() => conversationIndex).finally(() => { conversationIndexPromise = null; });
}

let unreadSnapshot = { expiresAt: 0, counts: new Map() };
let unreadSnapshotPromise = null;
let unreadSnapshotGeneration = 0;

async function currentUnreadCounts() {
  if (Date.now() < unreadSnapshot.expiresAt) return unreadSnapshot.counts;
  if (unreadSnapshotPromise) return unreadSnapshotPromise;
  const generation = unreadSnapshotGeneration;
  unreadSnapshotPromise = (async () => {
    const counts = new Map();
    let pageToken = "";
    do {
      const request = { userId: "me", labelIds: ["UNREAD"], q: `after:${MAIL_ARCHIVE_SINCE} -in:spam -in:trash`, maxResults: 100 };
      if (pageToken) request.pageToken = pageToken;
      const list = await gmail.users.messages.list(request);
      const records = await Promise.all((list.data.messages || []).map(async ({ id }) => {
        const archived = mailArchive.messages[id];
        if (archived) return archived;
        try {
          const full = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To"] });
          const message = summarizeMessage(full.data);
          const ownAddress = String(MAIL_USER || "").trim().toLowerCase();
          const outgoing = message.labelIds?.includes("SENT") || extractAddresses(message.from).includes(ownAddress);
          return {
            direction: outgoing ? "outgoing" : "incoming",
            contacts: (outgoing ? extractAddresses(message.to) : extractAddresses(message.from)).filter((address) => address !== ownAddress).map((address) => ({ address })),
          };
        } catch (error) {
          if (error?.code === 404) return null;
          throw error;
        }
      }));
      for (const record of records) {
        if (!record || record.direction !== "incoming") continue;
        for (const contact of record.contacts || []) {
          const address = String(contact?.address || "").trim().toLowerCase();
          if (extractAddresses(address)[0] !== address) continue;
          counts.set(address, (counts.get(address) || 0) + 1);
        }
      }
      pageToken = list.data.nextPageToken || "";
      if (pageToken) await new Promise((resolve) => setTimeout(resolve, 250));
    } while (pageToken);
    if (generation !== unreadSnapshotGeneration) return unreadSnapshot.counts;
    unreadSnapshot = { expiresAt: Date.now() + 5 * 60 * 1000, counts };
    return counts;
  })().catch(() => unreadSnapshot.counts).finally(() => { unreadSnapshotPromise = null; });
  return unreadSnapshotPromise;
}

async function acknowledgeReply(messageId, addresses = []) {
  try {
    await markReplyRead(gmail, messageId);
    const counts = new Map(unreadSnapshot.counts);
    for (const address of addresses) {
      const n = counts.get(address) || 0;
      if (n <= 1) counts.delete(address); else counts.set(address, n - 1);
    }
    unreadSnapshotGeneration += 1;
    unreadSnapshot = { expiresAt: 0, counts };
    return true;
  } catch (error) {
    console.error(`[mail-mcp] 寄出后确认原信失败：${error?.message || error}`);
    unreadSnapshotGeneration += 1;
    unreadSnapshot = { expiresAt: 0, counts: new Map(unreadSnapshot.counts) };
    return false;
  }
}

async function listConversationSummaries(maxResults) {
  const unreadCounts = unreadSnapshot.counts;
  if (Date.now() >= unreadSnapshot.expiresAt) void currentUnreadCounts();
  if (mailArchiveLoaded && Object.keys(mailArchive.messages).length) {
    return { conversations: listMailArchiveConversations(mailArchive, maxResults).map((conversation) => publicConversation({ ...conversation, unreadCount: unreadCounts.get(conversation.address) || 0 })), archive: archiveStatus() };
  }
  warmConversationIndex();
  const page = await fetchConversationPage();
  const recent = groupConversationSummaries(page.messages, page.messages.length);
  return { conversations: mergeConversationLists(recent, conversationIndex).slice(0, maxResults).map((conversation) => publicConversation({ ...conversation, unreadCount: unreadCounts.get(conversation.address) || 0 })), archive: archiveStatus() };
}

async function listConversationMessages(address, maxResults, pageToken) {
  if (mailArchiveLoaded && Object.keys(mailArchive.messages).length) {
    const page = pageMailArchive(mailArchive, address, {}, maxResults, pageToken);
    return { ...page, messages: page.messages.map(publicArchiveMessage), archive: archiveStatus() };
  }
  const request = { userId: "me", q: `{from:${address} to:${address}} -in:spam -in:trash`, maxResults };
  if (pageToken) request.pageToken = pageToken;
  const list = await gmail.users.messages.list(request);
  const messages = await Promise.all((list.data.messages || []).map(async ({ id }) => {
    const message = await readMessage(id);
    const ownAddress = String(MAIL_USER || "").trim().toLowerCase();
    const outgoing = message.labelIds?.includes("SENT") || extractAddresses(message.from).includes(ownAddress);
    const body = String(message.text || "");
    return {
      id: message.id,
      direction: outgoing ? "outgoing" : "incoming",
      subject: replaceMailAddresses(message.subject, mailContacts),
      date: message.date,
      internalDate: message.internalDate,
      text: replaceMailAddresses(body.slice(0, 30000), mailContacts),
      truncated: body.length > 30000,
      attachments: message.attachments.map(({ filename, mimeType, size }) => ({ filename: replaceMailAddresses(filename, mailContacts), mimeType, size })),
    };
  }));
  messages.sort((a, b) => (Number.parseInt(a.internalDate, 10) || Date.parse(a.date) || 0) - (Number.parseInt(b.internalDate, 10) || Date.parse(b.date) || 0));
  return { messages, nextPageToken: list.data.nextPageToken || "" };
}

// ═══════════════════════════════════════════════════════════════
// MCP server factory
// ═══════════════════════════════════════════════════════════════

function createServer() {
  const server = new McpServer({ name: "mail-mcp", version: "2.0.0" });

  // 这个收件人发来的未读里，挑标题跟这封回信对得上的最新一封（Gmail 和 IMAP 两种邮箱都走这里）。
  // 没翻完就找不到的时候抛错，调用方会在回执里写 replyInferenceFailed，不假装「确实没有这封」。
  async function findUnreadReplyTarget(address, subject) {
    if (backend) {
      const want = replyBaseSubject(subject);
      const r = await backend.findUnreadFrom(address, (s) => replyBaseSubject(s) === want);
      if (!r.message && r.truncated) throw new Error(`未读太多（${r.total} 封），只翻了最新 1000 封，没找到这封回信对应的原信`);
      return r.message ? { id: r.message.id, subject: r.message.subject, internalDate: r.message.internalDate } : null;
    }
    const list = await gmail.users.messages.list({ userId: "me", q: `from:${address} is:unread in:inbox`, maxResults: 20 });
    const candidates = [];
    for (const m of list.data.messages || []) {
      const d = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["Subject"] });
      candidates.push({ id: d.data.id || m.id, subject: headersObject(d.data.payload).subject, internalDate: d.data.internalDate });
    }
    const best = pickReplyTarget(candidates, subject);
    if (!best && list.data.nextPageToken) throw new Error("这个人的未读超过 20 封，只翻了最新 20 封，没找到这封回信对应的原信");
    return best;
  }

  // ─── send_email ──────────────────────────────────────────────
  server.registerTool(
    "send_email",
    {
      title: "Send Email",
      description: "Send a plain-text email to a pen pal by contact name or alias. Signature is OPTIONAL — only set it if you wrote a custom signature for this specific letter.",
      inputSchema: {
        to: z.string().describe("Recipient contact name(s) or alias(es), comma-separated"),
        subject: z.string(),
        body: z.string().describe("Plain text body. Do NOT include signature here unless intentional."),
        signature: z.string().optional().describe("Optional. If provided, appended after a blank line."),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        replyTo: z.string().optional(),
        inReplyTo: z.string().optional().describe("Optional. The message id you are answering (the `id` from list_recent/get_message). The reply joins that conversation thread and that letter is marked read. If omitted but the subject starts with \"Re:\" and there is exactly one recipient, the latest unread letter from that person with the same subject is used."),
      },
    },
    async ({ to, subject, body, signature, cc, bcc, replyTo, inReplyTo }) => {
      const recipients = resolveRecipients(to);
      const ccRecipients = resolveRecipients(cc);
      const bccRecipients = resolveRecipients(bcc);
      // 回信串线：AI 只给 Gmail 的 message id，这里替它查出原信的 Message-ID / References / threadId
      let thread = {};
      const currentRecipients = [recipients, ccRecipients, bccRecipients].filter(Boolean).join(", ");
      const labelFor = (address) => { try { return publicMailContact(mailContacts, address).name; } catch { return "未备注笔友"; } };
      // AI 回信常常不填 inReplyTo，只把标题写成「Re: 原标题」，结果原信一直挂着未读。没填时替它认一次：
      // 只有一个收件人、标题以 Re:/回复:/答复: 开头，就找这个人发来的、标题去掉前缀后一样的未读，取最新一封。
      // 只认同一个人、同一个标题，不会把这人别的信一起标成已读。
      let inferred = "", inferenceFailed = "";
      if (!inReplyTo && !ccRecipients && !bccRecipients && looksLikeReply(subject)) {
        const addrs = extractAddresses(recipients || "");
        if (addrs.length === 1) {
          try {
            const target = await findUnreadReplyTarget(addrs[0], subject);
            if (target) { inReplyTo = target.id; inferred = target.id; console.error(`[mail-mcp] 没填 inReplyTo，按标题认成回 ${target.id}`); }
          } catch (e) {
            inferenceFailed = "查未读失败：" + String(e?.message || e).slice(0, 80);
            console.error(`[mail-mcp] 自动认回信失败（照常当新信寄）：${e?.message || e}`);
          }
        }
      }
      // 自动认到的那封不能用（收件人对不上、没有 Message-ID）就退回当新信寄；AI 自己填的 inReplyTo 出错，或者网络/服务器出错，照常报错
      const dropInferred = (e) => {
        if (!inferred || !isUnusableReplyTarget(e)) throw e;
        const msg = String(e?.message || e);
        console.error(`[mail-mcp] 自动认的回信 ${inferred} 对不上（${msg}），照常当新信寄`);
        inferenceFailed = "认到的那封对不上：" + msg.slice(0, 80);
        inReplyTo = ""; inferred = ""; thread = {};
      };
      const inferenceNote = () => ({ ...(inferred ? { inferredReplyTo: inferred } : {}), ...(inferenceFailed ? { replyInferenceFailed: inferenceFailed } : {}) });
      if (backend) {
        try {
          if (inReplyTo) {
            thread = await backend.replyHeaders(inReplyTo);
            thread.correspondents = assertThreadRecipients(thread.headers, MAIL_USER, currentRecipients, labelFor);
          }
        } catch (e) { dropInferred(e); }
        const raw = buildSimpleMessage({ from: MAIL_FROM, to: recipients, cc: ccRecipients, bcc: bccRecipients, replyTo: resolveRecipients(replyTo), subject,
          body: composeBody(body, signature), inReplyTo: thread.inReplyTo, references: thread.references, smtp: true });
        const envelope = { from: MAIL_USER, to: [...new Set(extractAddresses(currentRecipients))] };
        const res = await backend.sendRaw(raw, envelope, inReplyTo || null);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, sent: true, archived: res.archived, acknowledged: res.acknowledged, ...inferenceNote(), id: res.id }, null, 2) }] };
      }
      try {
        if (inReplyTo) {
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(inReplyTo)) throw new Error("inReplyTo 要填 list_recent/get_message 给的 id");
          const orig = await gmail.users.messages.get({ userId: "me", id: inReplyTo, format: "metadata", metadataHeaders: ["Message-ID", "References", "From", "To", "Cc"] });
          const h = headersObject(orig.data.payload);
          if (!h["message-id"]) throw new Error("原信没有 Message-ID，没法串进同一个对话；去掉 inReplyTo 当新信寄，或换一封");
          const correspondents = assertThreadRecipients(h, MAIL_USER, currentRecipients, labelFor);
          thread = { inReplyTo: h["message-id"], references: [h.references, h["message-id"]].filter(Boolean).join(" "), threadId: orig.data.threadId, correspondents };
        }
      } catch (e) { dropInferred(e); }
      const raw = b64url(buildSimpleMessage({
        from: MAIL_FROM,
        to: recipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        replyTo: resolveRecipients(replyTo),
        subject,
        body: composeBody(body, signature),
        inReplyTo: thread.inReplyTo,
        references: thread.references,
      }));
      const res = await gmail.users.messages.send({ userId: "me", requestBody: thread.threadId ? { raw, threadId: thread.threadId } : { raw } });
      const archived = await archiveSentMessage(res.data.id);
      const acknowledged = inReplyTo ? await acknowledgeReply(inReplyTo, thread.correspondents || []) : null;
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, sent: true, archived, acknowledged, ...inferenceNote(), id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds }, null, 2) }] };
    }
  );

  // ─── list_recent ─────────────────────────────────────────────
  server.registerTool(
    "list_recent",
    {
      title: "List Recent Unread Messages",
      description: "List the most recent N unread messages (newest first). Returns headers/snippets, not full bodies.",
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional().describe("Default 10 for unread, 30 when searching with query."),
        labelIds: z.array(z.string()).optional().default(["INBOX"]).describe("Default: INBOX. Without query, results are limited to unread messages."),
        query: z.string().max(200).optional().describe(IS_GMAIL ? "Optional Gmail search (e.g. subject:xxx, newer_than:7d). With a query, read messages are included too." : "Optional keyword: matches subject or sender among the latest 300 messages. With a query, read messages are included too."),
      },
    },
    async ({ maxResults, labelIds, query }) => {
      const result = query
        ? await listMessageSummaries(maxResults ?? 30, undefined, query)
        : await listMessageSummaries(maxResults ?? 10, [...new Set([...labelIds, "UNREAD"])]);
      return { content: [{ type: "text", text: JSON.stringify({ ...result, messages: result.messages.map(publicMessage) }, null, 2) }] };
    }
  );

  // ─── get_message ─────────────────────────────────────────────
  server.registerTool(
    "get_message",
    {
      title: "Get Message",
      description: "Fetch full content of a message by id. Contact identity uses remark names; email addresses and internal contact fields are hidden.",
      inputSchema: {
        id: z.string().describe("Message id (from list_recent)"),
      },
    },
    async ({ id }) => {
      const message = await readMessage(id);
      return { content: [{ type: "text", text: JSON.stringify(publicMessage(message), null, 2) }] };
    }
  );

  return server;
}

// ═══════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════

const mode = process.argv.includes("--sse") ? "sse" : "stdio";

if (mode === "sse") {
  const PORT = parseInt(process.env.PORT || "3457");
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  const sessions = {};
  // 审查修复：每个 MCP 请求都记活动；请求（含一直开着的事件流）没结束前算「在用」，清理时跳过
  async function trackSession(id, res, run) {
    const s = sessions[id];
    if (!s) return run();
    s.active = (s.active || 0) + 1; s.lastSeen = Date.now();
    let done = false;
    const finish = () => { if (done) return; done = true; s.active = Math.max(0, (s.active || 1) - 1); s.lastSeen = Date.now(); };
    res.on("close", finish); res.on("finish", finish);
    try { return await run(); } catch (e) { finish(); throw e; }
  }

  const allowReadonly = (req) => IS_GMAIL && MAIL_READ_TOKEN && req.headers.authorization === `Bearer ${MAIL_READ_TOKEN}`;   // 只读接口只支持 Gmail
  const readonlyHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

  app.get("/readonly/messages", async (req, res) => {
    if (!allowReadonly(req)) { res.status(401).set(readonlyHeaders).json({ error: "unauthorized" }); return; }
    const requested = Number.parseInt(String(req.query.limit || "24"), 10);
    const maxResults = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 30) : 24;
    try {
      const result = await listMessageSummaries(maxResults, ["INBOX"]);
      res.set(readonlyHeaders).json({ ...result, messages: result.messages.map(publicMessage) });
    } catch {
      res.status(502).set(readonlyHeaders).json({ error: "mail unavailable" });
    }
  });

  app.get("/readonly/messages/:id", async (req, res) => {
    if (!allowReadonly(req)) { res.status(401).set(readonlyHeaders).json({ error: "unauthorized" }); return; }
    const id = String(req.params.id || "");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) { res.status(400).set(readonlyHeaders).json({ error: "invalid id" }); return; }
    try {
      const message = publicMessage(await readMessage(id));
      const body = String(message.text || "");
      res.set(readonlyHeaders).json({
        id: message.id,
        subject: message.subject,
        from: message.from,
        to: message.to,
        date: message.date,
        text: body.slice(0, 200000),
        truncated: body.length > 200000,
        attachments: message.attachments.map(({ filename, mimeType, size }) => ({ filename, mimeType, size })),
      });
    } catch (error) {
      const status = error?.code === 404 ? 404 : 502;
      res.status(status).set(readonlyHeaders).json({ error: status === 404 ? "not found" : "mail unavailable" });
    }
  });

  app.get("/readonly/archive/status", (req, res) => {
    if (!allowReadonly(req)) { res.status(401).set(readonlyHeaders).json({ error: "unauthorized" }); return; }
    res.set(readonlyHeaders).json(archiveStatus());
  });

  app.get("/readonly/conversations", async (req, res) => {
    if (!allowReadonly(req)) { res.status(401).set(readonlyHeaders).json({ error: "unauthorized" }); return; }
    const requested = Number.parseInt(String(req.query.limit || "24"), 10);
    const maxResults = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 24;
    try {
      res.set(readonlyHeaders).json(await listConversationSummaries(maxResults));
    } catch {
      res.status(502).set(readonlyHeaders).json({ error: "mail unavailable" });
    }
  });

  app.get("/readonly/conversations/:id", async (req, res) => {
    if (!allowReadonly(req)) { res.status(401).set(readonlyHeaders).json({ error: "unauthorized" }); return; }
    const address = conversationAddress(String(req.params.id || ""));
    const pageToken = String(req.query.pageToken || "");
    const requested = Number.parseInt(String(req.query.limit || "12"), 10);
    const maxResults = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 12) : 12;
    if (!address || (pageToken && !/^[a-zA-Z0-9_-]{1,2048}$/.test(pageToken))) {
      res.status(400).set(readonlyHeaders).json({ error: "invalid conversation" });
      return;
    }
    try {
      res.set(readonlyHeaders).json(await listConversationMessages(address, maxResults, pageToken));
    } catch {
      res.status(502).set(readonlyHeaders).json({ error: "mail unavailable" });
    }
  });

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions[sessionId]) {
      await trackSession(sessionId, res, () => sessions[sessionId].transport.handleRequest(req, res, req.body));
      return;
    }
    const srv = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
    if (transport.sessionId) sessions[transport.sessionId] = { server: srv, transport, lastSeen: Date.now(), active: 0 };
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions[sessionId]) { res.status(400).send("invalid session"); return; }
    await trackSession(sessionId, res, () => sessions[sessionId].transport.handleRequest(req, res, req.body));
  });


  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions[sessionId]) {
      try { await sessions[sessionId].server.close(); } catch {}
      delete sessions[sessionId];
    }
    res.status(200).end();
  });

  // 客户端没走 DELETE 就断了（进程崩、隧道抖），会话会一直挂着：闲置 2 小时的清掉
  setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, s] of Object.entries(sessions)) {
      if ((s.active || 0) === 0 && (s.lastSeen || 0) < cutoff) { delete sessions[id]; void Promise.resolve().then(() => s.server.close()).catch(() => {}); }
    }
  }, 10 * 60 * 1000).unref();

  // 按笔友在存档里搜（hub 的 /api/mail/search 代理到这里）
  app.get("/readonly/search/:id", (req, res) => {
    if (!allowReadonly(req)) { res.status(401).set(readonlyHeaders).json({ error: "unauthorized" }); return; }
    const address = conversationAddress(String(req.params.id || ""));
    const q = String(req.query.q || "").slice(0, 160);
    const direction = String(req.query.direction || "all");
    const from = String(req.query.from || ""), to = String(req.query.to || "");
    const isDay = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
    const pageToken = String(req.query.pageToken || "");
    // 跟 hub 同一套口径：条件不合法就 400，不悄悄放宽成全搜
    if (!address || String(req.query.q || "").length > 160 || !["all", "incoming", "outgoing"].includes(direction) || !isDay(from) || !isDay(to) || (from && to && from > to) || (pageToken && !/^local_\d{1,7}$/.test(pageToken))) {
      res.status(400).set(readonlyHeaders).json({ error: "invalid search" }); return;
    }
    // 审查修复：初次同步没跑完、或同步/加载出过错，都不给半截结果（不然会像「确实没有」）
    if (!mailArchiveLoaded || mailArchive.initialComplete !== true || mailArchiveLoadError || mailArchiveSyncState.error) { res.status(503).set(readonlyHeaders).json({ error: "archive not ready", archive: archiveStatus() }); return; }
    const page = pageMailArchive(mailArchive, address, { q, direction, from, to }, req.query.limit, pageToken);
    res.set(readonlyHeaders).json({ ...page, messages: page.messages.map(publicArchiveMessage), archive: archiveStatus() });
  });

  app.get("/health", (_, res) => res.json({ ok: true, backend: "gmail-api", proxy: PROXY ? "configured" : "none" }));   // 不回显代理地址（可能带账号密码）

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[mail-mcp] HTTP server on http://localhost:${PORT}/mcp`);
    console.log(`[mail-mcp] account: ${MAIL_USER}`);
    console.log(`[mail-mcp] from:    ${MAIL_FROM}`);
    console.log(`[mail-mcp] proxy:   ${PROXY ? "configured" : "direct"}`);
    // 常驻（SSE/HTTP）模式下 Gmail 本地存档始终开启：send_email 的 archived 回执靠它；MAIL_READ_TOKEN 只控制只读 HTTP 接口和会话索引。
    // stdio 模式不开：每个会话各起一个进程，同时后台全量同步、同时写一份存档文件，会互相覆盖。
    if (MAIL_READ_TOKEN && !IS_GMAIL) console.error("[mail-mcp] 只读看信接口目前只支持 Gmail，这次没开");
    if (IS_GMAIL) {
      startMailArchive();
      if (MAIL_READ_TOKEN) warmConversationIndex();
    }
  });
} else {
  const srv = createServer();
  const transport = new StdioServerTransport();
  await srv.connect(transport);
  console.error(`[mail-mcp] stdio mode, account: ${MAIL_USER}`);
}
