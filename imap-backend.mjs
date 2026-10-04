/**
 * imap-backend.mjs — 非 Gmail 邮箱（163 / 126 / QQ / 雅虎 / 其他支持 IMAP+SMTP 的）
 *
 * 收信 IMAP、发信 SMTP，用邮箱里开出来的「授权码」当密码。
 * 给 mail-mcp.mjs 提供跟 Gmail 那套一样形状的四件事：列未读、读一封、寄信、寄出后把对方的来信标已读。
 * 消息 id 写成 "INBOX:<UIDVALIDITY>:<UID>"，AI 照抄给 get_message / inReplyTo 就行。
 */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

// 常见邮箱的服务器（都走 SSL：IMAP 993 / SMTP 465）。不在表里的就在 .env 里写 IMAP_HOST / SMTP_HOST。
export const PRESETS = {
  "163":   { imap: "imap.163.com", smtp: "smtp.163.com" },
  "126":   { imap: "imap.126.com", smtp: "smtp.126.com" },
  yeah:    { imap: "imap.yeah.net", smtp: "smtp.yeah.net" },
  qq:      { imap: "imap.qq.com", smtp: "smtp.qq.com" },
  foxmail: { imap: "imap.qq.com", smtp: "smtp.qq.com" },
  yahoo:   { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  icloud:  { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587, smtpSecure: false },
};

export function createImapBackend({ provider, user, password, from, proxy, env = process.env }) {
  const p = PRESETS[provider] || {};
  const imapHost = env.IMAP_HOST || p.imap, smtpHost = env.SMTP_HOST || p.smtp;
  if (!imapHost || !smtpHost) throw new Error(`不认识的邮箱类型「${provider}」：在 .env 里写 IMAP_HOST 和 SMTP_HOST`);
  if (!user || !password) throw new Error("非 Gmail 邮箱要在 .env 里填 MAIL_USER 和 MAIL_PASSWORD（邮箱设置里开 IMAP/SMTP 后生成的授权码，不是登录密码）");
  const imapPort = Number(env.IMAP_PORT || p.imapPort || 993);
  const smtpPort = Number(env.SMTP_PORT || p.smtpPort || 465);
  const smtpSecure = env.SMTP_SECURE ? env.SMTP_SECURE !== "false" : (p.smtpSecure ?? smtpPort === 465);

  // 163/126 不发 ID 命令会报「Unsafe Login」，imapflow 会在登录后自动发 clientInfo 里的 ID
  const imapOptions = () => ({ host: imapHost, port: imapPort, secure: imapPort === 993, auth: { user, pass: password }, logger: false,
    clientInfo: { name: "ai-penpal-mail", version: "1.0", vendor: "ai-penpal-mail" }, ...(proxy ? { proxy } : {}) });
  const transport = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpSecure, auth: { user, pass: password }, ...(proxy ? { proxy } : {}) });

  // 任何一步出错都要放锁、退出登录，不然国内邮箱几次抽风就堆一串没关的连接撞限频
  async function withClient(fn) {
    const client = new ImapFlow(imapOptions());
    try {
      try { await client.connect(); }
      catch (e) {
        if (e?.authenticationFailed || /auth|login|unsafe/i.test(String(e?.responseText || e?.message))) throw new Error(`邮箱登录失败（${e?.responseText || e?.message}）：检查 MAIL_USER 和 MAIL_PASSWORD——要填授权码不是登录密码，并确认邮箱设置里 IMAP/SMTP 服务已开启`);
        throw new Error(`连不上 ${imapHost}:${imapPort}（${e?.message || e}）`);
      }
      return await fn(client);
    }
    finally { try { await client.logout(); } catch { try { client.close(); } catch {} } }
  }
  async function withInbox(fn, { readOnly = true } = {}) {
    return withClient(async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly });
      try { return await fn(client, client.mailbox?.uidValidity); } finally { lock.release(); }
    });
  }
  // id 带上 UIDVALIDITY：邮箱重建索引后 UID 会换主，旧 id 不能悄悄指到另一封信
  const idOf = (uidValidity, uid) => `INBOX:${uidValidity}:${uid}`;
  function parseId(id) {
    const m = /^INBOX:(\d{1,20}):(\d{1,12})$/.exec(String(id || ""));
    if (!m) throw new Error("id 要照抄 list_recent / get_message 给的（形如 INBOX:1700000000:123）");
    return { uidValidity: m[1], uid: m[2] };
  }
  function checkValidity(want, have) {
    if (String(want) !== String(have)) throw new Error("这封信的编号已经失效（邮箱重建过索引），请重新 list_recent 拿新的 id");
  }
  const addr = (list) => (list || []).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ");
  function summary(msg, uidValidity) {
    const e = msg.envelope || {};
    const date = e.date || msg.internalDate;
    return {
      id: idOf(uidValidity, msg.uid), threadId: "", snippet: "",
      labelIds: ["INBOX", ...(msg.flags && msg.flags.has("\\Seen") ? [] : ["UNREAD"])],
      subject: e.subject || "", from: addr(e.from), to: addr(e.to),
      date: date ? new Date(date).toUTCString() : "", internalDate: date ? String(new Date(date).getTime()) : "",
    };
  }

  // 未读（或带 query 时在最近 300 封里按标题/发件人搜，含已读），新的在前
  async function listMessageSummaries(maxResults, unreadOnly, query) {
    return withInbox(async (client, uv) => {
      // 关键词搜索不交给服务器：163 的 IMAP 对标题/发件人/正文搜索一律返回空（10/2 实测），只认已读未读和日期。
      // 所以有 query 时取最近 300 封的信封，在这边按标题和发件人（名字或地址）过滤。
      if (query) {
        const all = ((await client.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a).slice(0, 300);
        const q = String(query).toLowerCase();
        const hits = [];
        if (all.length) for await (const msg of client.fetch(all, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const e = msg.envelope || {};
          const hay = [e.subject, ...(e.from || []).flatMap((a) => [a.name, a.address])].filter(Boolean).join(" ").toLowerCase();
          if (hay.includes(q)) hits.push(summary(msg, uv));
        }
        hits.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        return { messages: hits.slice(0, maxResults), total: hits.length };
      }
      const uids = (await client.search(unreadOnly ? { seen: false } : { all: true }, { uid: true })) || [];
      const pick = uids.sort((a, b) => b - a).slice(0, maxResults);
      const messages = [];
      if (pick.length) for await (const msg of client.fetch(pick, { envelope: true, flags: true, internalDate: true }, { uid: true })) messages.push(summary(msg, uv));
      messages.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      return { messages, total: uids.length };
    });
  }

  // 自动认回信用：在全部未读里从新到旧找「这个地址发来、标题对得上」的信，找到就停（只取信封，不会把信标成已读）。
  // 不能只看收件箱最新几十封——别人的未读一多，要找的那封就被挤出去、悄悄漏掉。
  // 最多翻 maxScan 封；翻到上限还没找到，回 truncated: true，让调用方明说「没翻完」，不假装「确实没有」。
  async function findUnreadFrom(address, matchesSubject, maxScan = 1000) {
    return withInbox(async (client, uv) => {
      const want = String(address || "").toLowerCase();
      const uids = ((await client.search({ seen: false }, { uid: true })) || []).sort((a, b) => b - a);
      const limit = Math.min(uids.length, maxScan);
      for (let i = 0; i < limit; i += 100) {
        const batch = uids.slice(i, Math.min(i + 100, limit));
        const found = [];
        for await (const msg of client.fetch(batch, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const e = msg.envelope || {};
          const fromAddrs = (e.from || []).map((a) => String(a.address || "").toLowerCase());
          if (fromAddrs.includes(want) && matchesSubject(e.subject || "")) found.push(summary(msg, uv));
        }
        if (found.length) {
          found.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
          return { message: found[0], truncated: false, total: uids.length };
        }
      }
      return { message: null, truncated: uids.length > maxScan, total: uids.length };
    });
  }

  // 读一封全文（读了就算已读，跟在邮箱里点开一样）
  async function readMessage(id) {
    const { uidValidity, uid } = parseId(id);
    return withInbox(async (client, uv) => {
      checkValidity(uidValidity, uv);
      const msg = await client.fetchOne(uid, { envelope: true, flags: true, internalDate: true, source: true }, { uid: true });
      if (!msg) throw new Error("没找到这封信（可能被删了或挪走了）");
      const parsed = await simpleParser(msg.source);
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }).catch((e) => console.error(`[mail-mcp] 标已读失败（这封会一直显示未读）：${e?.message || e}`));
      const text = parsed.text || "";
      return { ...summary(msg, uv), snippet: text.replace(/\s+/g, " ").slice(0, 160), text, html: parsed.html || null,
        attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || "", mimeType: a.contentType, size: a.size })) };
    }, { readOnly: false });
  }

  // 回信要串进原来那封：查原信的 Message-ID / References，也把参与者交给上层核对
  async function replyHeaders(id) {
    const { uidValidity, uid } = parseId(id);
    return withInbox(async (client, uv) => {
      checkValidity(uidValidity, uv);
      const msg = await client.fetchOne(uid, { headers: ["message-id", "references", "from", "to", "cc"] }, { uid: true });
      if (!msg) throw new Error("没找到 inReplyTo 那封原信");
      const h = msg.headers.toString();
      const get = (name) => (new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n\\S|$)`, "im").exec(h) || [])[1]?.replace(/\s+/g, " ").trim() || "";
      const mid = get("message-id");
      if (!mid) throw new Error("原信没有 Message-ID，没法串进同一个对话；去掉 inReplyTo 当新信寄");
      return {
        inReplyTo: mid,
        references: [get("references"), mid].filter(Boolean).join(" "),
        headers: { from: get("from"), to: get("to"), cc: get("cc") },
      };
    });
  }

  // 寄信：SMTP 寄出；之后往「已发送」放一份，并且只把明确回复的那一个 UID 标已读
  async function sendRaw(rawMime, envelope, ackId = null) {
    const info = await transport.sendMail({ envelope, raw: rawMime });
    if (!info.accepted || !info.accepted.length) throw new Error("对方服务器没收下：" + JSON.stringify(info.rejected || []));
    let archived = false;
    let acknowledged = ackId ? false : null;
    try {
      await withClient(async (client) => {
        if (env.SAVE_SENT !== "false") {
          try {
            const boxes = await client.list();
            const sent = boxes.find((b) => b.specialUse === "\\Sent") || boxes.find((b) => /^(sent|sent messages|sent items|已发送)$/i.test(b.name));
            if (sent) {
              // 有的邮箱（163 实测时有时无）SMTP 寄出会自己存一份到已发送：等两秒看看最近几封里有没有同一个 Message-ID，有就不重复放
              const mid = (/^Message-ID:\s*(<[^>]+>)/im.exec(rawMime) || [])[1] || info.messageId;
              await new Promise((r) => setTimeout(r, 2000));
              let exists = false;
              const lk = await client.getMailboxLock(sent.path, { readOnly: true });
              try {
                const total = client.mailbox?.exists || 0;
                if (total && mid) for await (const m of client.fetch(`${Math.max(1, total - 9)}:*`, { envelope: true })) if (m.envelope?.messageId === mid) exists = true;
              } finally { lk.release(); }
              if (!exists) await client.append(sent.path, rawMime, ["\\Seen"]);
              archived = true;
            }
          } catch (e) { console.error(`[mail-mcp] 已寄出，但往「已发送」放副本失败：${e?.message || e}`); }
        }
        if (ackId) {
          const { uidValidity, uid } = parseId(ackId);
          const lock = await client.getMailboxLock("INBOX");
          try {
            checkValidity(uidValidity, client.mailbox?.uidValidity);
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            acknowledged = true;
          } finally { lock.release(); }
        }
      });
    } catch (e) { console.error(`[mail-mcp] 已寄出，但寄后收尾（存已发送/确认原信）失败：${e?.message || e}`); }
    return { id: info.messageId || "", threadId: "", accepted: info.accepted, archived, acknowledged };
  }

  return { listMessageSummaries, findUnreadFrom, readMessage, replyHeaders, sendRaw, describe: `${provider} · IMAP ${imapHost}:${imapPort} · SMTP ${smtpHost}:${smtpPort}` };
}
