import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const VERSION = 1;
const ADDRESS = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const ADDRESSES = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function foldContactReference(value) {
  return String(value || "").trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

// 「AI-Nian」「AI-Kai🐋」→「Nian」「Kai」：去掉 AI- 前缀和结尾的表情/空白，只用于找不到精确名时的宽松比对
function bareContactReference(value) {
  return foldContactReference(value).replace(/^ai[-_\s]+/u, "").replace(/[\p{Extended_Pictographic}\uFE0F\s]+$/u, "");
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length];
}

export function normalizeMailAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return ADDRESS.test(address) ? address : "";
}

export function emptyMailContacts() {
  return { version: VERSION, updatedAt: "", contacts: {} };
}

function validateMailContacts(book) {
  if (book?.version !== VERSION || !book.contacts || typeof book.contacts !== "object" || Array.isArray(book.contacts)) throw new Error("invalid mail contacts");
  const ids = new Set();
  for (const [address, contact] of Object.entries(book.contacts)) {
    if (normalizeMailAddress(address) !== address || !contact || typeof contact !== "object" || Array.isArray(contact)) throw new Error("invalid mail contact");
    if (!/^c_[a-zA-Z0-9_-]{16}$/.test(contact.id) || ids.has(contact.id)) throw new Error("invalid mail contact id");
    if (typeof contact.name !== "string" || contact.name.length > 120 || typeof contact.style !== "string" || !/^[a-z0-9_-]{0,40}$/.test(contact.style)) throw new Error("invalid mail contact label");
    if (contact.aliases !== undefined && (!Array.isArray(contact.aliases) || contact.aliases.length > 20 || contact.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 120))) throw new Error("invalid mail contact aliases");
    ids.add(contact.id);
  }
  return book;
}

export function loadMailContacts(file) {
  try {
    return validateMailContacts(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyMailContacts();
    throw error;
  }
}

export function saveMailContacts(file, book) {
  validateMailContacts(book);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(book, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

export function ensureMailContact(book, value, name = "", style = "") {
  const address = normalizeMailAddress(value);
  if (!address) throw new Error("无效邮箱联系人");
  if (book.contacts[address]) return { contact: book.contacts[address], created: false };
  const contact = {
    id: `c_${randomBytes(12).toString("base64url")}`,
    name: typeof name === "string" ? name.trim().slice(0, 120) : "",
    style: typeof style === "string" && /^[a-z0-9_-]{1,40}$/.test(style) ? style : "",
  };
  book.contacts[address] = contact;
  book.updatedAt = new Date().toISOString();
  return { contact, created: true };
}

export function publicMailContact(book, value) {
  const address = normalizeMailAddress(value);
  const contact = address && book.contacts[address];
  if (!contact) throw new Error("未知邮箱联系人");
  return {
    id: contact.id,
    name: contact.name || `未备注笔友 · ${contact.id.slice(-4).toUpperCase()}`,
    style: contact.style,
  };
}

export function resolveMailContact(book, value) {
  const reference = String(value || "").trim();
  const address = normalizeMailAddress(reference);
  if (address && book.contacts[address]) return address;
  const folded = foldContactReference(reference);
  const matches = Object.entries(book.contacts).filter(([, contact]) => contact.id === reference || [contact.name, ...(contact.aliases || [])].some((label) => label && foldContactReference(label) === folded));
  if (matches.length > 1) throw new Error("联系人名或别名有重名，请让你的人类确认主邮箱");
  // 实际踩过的坑：笔友备注常是「AI-Nian」，信末署名却是「Nian」。AI 照署名写 to=Nian → 精确匹配找不到，
  // ta 会去翻记忆、换好几个名字重试。所以去掉 AI- 前缀和结尾表情再比一次，唯一命中才算，多个命中就报出来让 ta 写全名。
  if (!matches.length) {
    const b = bareContactReference(reference);
    if (b) {
      const loose = Object.entries(book.contacts).filter(([, contact]) => [contact.name, ...(contact.aliases || [])].some((label) => label && bareContactReference(label) === b));
      if (loose.length === 1) return loose[0][0];
      if (loose.length > 1) throw new Error(`“${reference}”对得上好几个笔友：${loose.map(([, c]) => c.name).join("、")}，请写全名`);
    }
  }
  if (!matches.length) {
    // ponytail: this O(n*m) hint scan is fine for a personal contact book (dozens to a few hundred); index it if yours is much larger.
    const bareRef = bareContactReference(reference);
    const suggestions = !bareRef ? [] : Object.values(book.contacts).flatMap((contact) => {
      if (!contact.name) return [];
      const score = Math.min(...[contact.name, ...(contact.aliases || [])].map((label) => {
        const candidate = foldContactReference(label), bareCand = bareContactReference(label);
        if (bareCand && (bareCand.includes(bareRef) || bareRef.includes(bareCand))) return 0;
        if (folded.length < 2) return Infinity;
        return candidate.includes(folded) || folded.includes(candidate) ? 0 : editDistance(folded, candidate);
      }));
      const longest = Math.max(folded.length, ...[contact.name, ...(contact.aliases || [])].map((label) => foldContactReference(label).length));
      return score <= Math.max(1, Math.floor(longest / 3)) ? [{ name: contact.name, score }] : [];
    }).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "zh-CN")).slice(0, 3).map(({ name }) => name);
    if (suggestions.length) throw new Error(`找不到“${reference}”。你是不是要找：${suggestions.join("、")}？`);
    throw new Error("找不到这个笔友，请先补联系人备注");
  }
  return matches[0][0];
}

export function replaceMailAddresses(value, book) {
  return String(value || "").replace(ADDRESSES, (match) => {
    const contact = book.contacts[normalizeMailAddress(match)];
    return contact?.name || "未备注邮箱";
  });
}
