const ADDRESS_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function extractMailAddresses(value) {
  return [...new Set((String(value || "").match(ADDRESS_RE) || []).map((x) => x.toLowerCase()))];
}

export function headersObject(payload) {
  const out = {};
  for (const h of payload?.headers || []) out[String(h.name || "").toLowerCase()] = String(h.value || "");
  return out;
}

export function threadCorrespondents(headers, selfAddress) {
  const self = String(selfAddress || "").trim().toLowerCase();
  const from = extractMailAddresses(headers.from);
  const outgoing = from.includes(self);
  const raw = outgoing ? [headers.to, headers.cc] : [headers.from];
  return [...new Set(raw.flatMap(extractMailAddresses).filter((x) => x !== self))];
}

export function assertThreadRecipients(headers, selfAddress, recipients, labelFor = (x) => x) {
  const expected = threadCorrespondents(headers, selfAddress);
  const actual = [...new Set(extractMailAddresses(recipients).filter((x) => x !== String(selfAddress || "").toLowerCase()))];
  const same = expected.length === actual.length && actual.every((x) => expected.includes(x));
  if (!expected.length || !same) {
    const original = expected.map(labelFor).join("、") || "未知笔友";
    const current = actual.map(labelFor).join("、") || "无人";
    throw new Error(`这封原信属于 ${original}，当前却要寄给 ${current}；请重新选原信或收件人`);
  }
  return expected;
}

// 回信没填 inReplyTo 时，按「Re: 原标题」认回这个人最近一封同标题的未读（不然寄完原信一直挂着未读）。
// 只认 Re: / 回复: / 答复: 开头才算在回信；Fwd: 是转发，不当证据。比较前做 NFKC、折叠空白、英文小写。
export function normalizeSubject(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function replyBaseSubject(value) {
  return normalizeSubject(value).replace(/^((re|回复|答复|fwd?)\s*[:：]\s*)+/i, "").trim();
}

export function looksLikeReply(subject) {
  return /^(re|回复|答复)\s*[:：]/i.test(normalizeSubject(subject)) && Boolean(replyBaseSubject(subject));
}

// 回信起了新标题（去掉 Re:/回复:/答复: 以后跟原信不一样）就另开一条线：不带 threadId / In-Reply-To / References，
// 原信照样标成回过了。标题一样（「Re: 原标题」）才串进原来的对话。
// 这里只剥回复前缀：「Fwd: 原标题」是转发，算新标题，另开一条线。
const stripReplyPrefix = (value) => normalizeSubject(value).replace(/^((re|回复|答复)\s*[:：]\s*)+/i, "").trim();
export function startsNewThread(subject, originalSubject) {
  return stripReplyPrefix(subject) !== stripReplyPrefix(originalSubject);
}

// 对方信里的标题是不可信输入：要拼进给 AI 看的提示里时，去掉换行和控制字符、折叠空白、截到 max 字
export function safeSubject(value, max = 120) {
  const t = String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? t.slice(0, max) + "…" : t) : "（无标题）";
}

// candidates：[{ id, subject, internalDate }]，都是这个收件人发来的未读。挑标题对得上的最新一封，没有就 null。
export function pickReplyTarget(candidates, subject) {
  const want = replyBaseSubject(subject);
  if (!want) return null;
  let best = null;
  for (const c of candidates || []) {
    if (replyBaseSubject(c.subject) !== want) continue;
    if (!best || Number(c.internalDate || 0) > Number(best.internalDate || 0)) best = c;
  }
  return best;
}

// 自动认到的那封如果本身不能用（收件人对不上、没有 Message-ID），退回当新信寄；别的错误（网络、服务器）照常报错，让 AI 重试。
export function isUnusableReplyTarget(error) {
  return /这封原信属于|原信没有 Message-ID/.test(String(error?.message || error || ""));
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, n) => ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[n.toLowerCase()]);
}

export function htmlToPlainText(value) {
  return decodeEntities(String(value || "")
    .replace(/<(script|style|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeData(data) {
  return Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export async function decodeMessageBody(gmail, messageId, payload, maxBytes = 1024 * 1024) {
  let plain = null, html = null, used = 0, truncated = false, unavailable = false, sawTextPart = false;
  async function dataFor(part) {
    if (part.body?.data) return decodeData(part.body.data);
    if (!part.body?.attachmentId || !/^text\/(plain|html)$/i.test(part.mimeType || "")) return null;
    try {
      const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: part.body.attachmentId });
      return decodeData(res.data?.data);
    } catch {
      unavailable = true;
      return null;
    }
  }
  async function walk(part) {
    if (!part) return;
    if (/^text\/(plain|html)$/i.test(part.mimeType || "") && ((plain === null && part.mimeType === "text/plain") || (html === null && part.mimeType === "text/html"))) {
      sawTextPart = true;
      const buf = await dataFor(part);
      if (buf) {
        const left = Math.max(0, maxBytes - used);
        const slice = buf.subarray(0, left);
        used += slice.length;
        if (slice.length < buf.length) truncated = true;
        const decoded = slice.toString("utf8");
        if (part.mimeType === "text/plain") plain = decoded;
        else html = decoded;
      }
    }
    for (const child of part.parts || []) await walk(child);
  }
  await walk(payload);
  const text = plain ?? (html !== null ? htmlToPlainText(html) : "");
  return { text, bodyTruncated: truncated, bodyUnavailable: unavailable || (!sawTextPart && Boolean(payload?.parts?.length)) };
}

export async function markReplyRead(gmail, messageId) {
  await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { removeLabelIds: ["UNREAD"] } });
  return true;
}
