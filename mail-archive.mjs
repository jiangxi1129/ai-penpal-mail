import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;

export function emptyMailArchive(since = "2026-04-01") {
  return {
    version: VERSION,
    since,
    initialComplete: false,
    lastSyncAt: "",
    updatedAt: "",
    messages: {},
  };
}

export async function loadMailArchive(file, since = "2026-04-01") {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== VERSION || !value.messages || typeof value.messages !== "object" || Array.isArray(value.messages)) {
      throw new Error("invalid mail archive");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return emptyMailArchive(since);
    throw error;
  }
}

export async function saveMailArchive(file, archive) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(archive)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export function upsertMailArchive(archive, records) {
  let added = 0;
  for (const record of records) {
    if (!record?.id || typeof record.id !== "string") continue;
    if (!archive.messages[record.id]) added += 1;
    archive.messages[record.id] = record;
  }
  if (records.length) archive.updatedAt = new Date().toISOString();
  return added;
}

function messageMs(message) {
  return Number.parseInt(message.internalDate, 10) || Date.parse(message.date) || 0;
}

// 按哪个时区切「这一天」：MAIL_TZ_OFFSET_HOURS，默认东八区
const TZ_OFFSET_MS = (Number(process.env.MAIL_TZ_OFFSET_HOURS ?? 8) || 0) * 60 * 60 * 1000;
function localDay(message) {
  const ms = messageMs(message);
  return ms ? new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10) : "";
}

function includesContact(message, address) {
  return Array.isArray(message.contacts) && message.contacts.some((contact) => contact?.address === address);
}

function matchesFilters(message, filters) {
  if (filters.direction && filters.direction !== "all" && message.direction !== filters.direction) return false;
  const day = localDay(message);
  if (filters.from && (!day || day < filters.from)) return false;
  if (filters.to && (!day || day > filters.to)) return false;
  const needle = String(filters.q || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  const attachments = Array.isArray(message.attachments) ? message.attachments.map((item) => item?.filename || "").join("\n") : "";
  const haystack = [message.subject, message.text, message.from, message.to, attachments].join("\n").toLocaleLowerCase("zh-CN");
  return haystack.includes(needle);
}

export function searchMailArchive(archive, address, filters = {}) {
  const target = String(address || "").trim().toLowerCase();
  return Object.values(archive.messages)
    .filter((message) => includesContact(message, target) && matchesFilters(message, filters))
    .sort((a, b) => messageMs(b) - messageMs(a));
}

export function pageMailArchive(archive, address, filters = {}, limit = 12, pageToken = "") {
  const matches = searchMailArchive(archive, address, filters);
  const offset = /^local_(\d+)$/.test(pageToken) ? Number.parseInt(pageToken.slice(6), 10) : 0;
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 12, 1), 12);
  const selected = matches.slice(offset, offset + size).sort((a, b) => messageMs(a) - messageMs(b));
  const nextOffset = offset + selected.length;
  return {
    messages: selected,
    total: matches.length,
    nextPageToken: nextOffset < matches.length ? `local_${nextOffset}` : "",
  };
}

export function listMailArchiveConversations(archive, limit = 200) {
  const conversations = new Map();
  for (const message of Object.values(archive.messages)) {
    const latestMs = messageMs(message);
    for (const contact of message.contacts || []) {
      if (!contact?.address) continue;
      const current = conversations.get(contact.address);
      if (current && current.latestMs >= latestMs) continue;
      conversations.set(contact.address, {
        id: Buffer.from(contact.address, "utf8").toString("base64url"),
        address: contact.address,
        name: contact.name || contact.address.split("@")[0],
        subject: message.subject || "",
        snippet: message.snippet || String(message.text || "").slice(0, 180),
        date: message.date || "",
        latestMs,
        direction: message.direction === "outgoing" ? "outgoing" : "incoming",
      });
    }
  }
  return [...conversations.values()].sort((a, b) => b.latestMs - a.latestMs).slice(0, limit);
}
