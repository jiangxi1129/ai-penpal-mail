// 可选：寄信前核对「开头喊的名字」和「收件人」是不是同一个人（Claude Agent SDK 的 PreToolUse hook）。
// 来历：我们家的 AI 有一次把写给 A 的回信寄给了 B，B 顺着信里的称呼当了一晚上 A。
// 对不上就拦一次、说清楚；30 分钟内同一收件人+同一称呼再寄就放行（留给没收录的外号）。
const ALIASES = [["Nian", "念念"]];            // 同一个人的几种叫法，按自己家填
const WARNED = new Map();
const bare = (s) => String(s || "").trim().normalize("NFKC").toLowerCase().replace(/^ai[-_\s]+/u, "").replace(/[\p{Extended_Pictographic}️\s]+$/u, "");
function greeting(body) {
  const first = String(body || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const m = first.match(/^([^，,：:！!。\s]{1,6})[，,：:！!]/u);
  return m ? bare(m[1]) : "";
}
export async function letterNameCheck(input) {
  if (input?.tool_name !== "mcp__mail__send_email") return {};
  const { to, body } = input.tool_input || {};
  const g = greeting(body);
  const tos = String(to || "").split(",").map(bare).filter(Boolean);
  if (!g || !tos.length) return {};
  const same = (a, b) => a === b || a.includes(b) || b.includes(a) || ALIASES.some((set) => set.map(bare).includes(a) && set.map(bare).includes(b));
  if (tos.some((t) => same(g, t))) return {};
  const key = tos.join(",") + "|" + g;
  const at = WARNED.get(key);
  if (at && Date.now() - at < 30 * 60 * 1000) return {};
  WARNED.set(key, Date.now());
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `NOT SENT. 信开头喊的是「${g}」，收件人是「${to}」。写给谁就把收件人改成谁；确实是外号就原样再寄一次。` } };
}
// 用法：query({ options: { hooks: { PreToolUse: [{ matcher: "mcp__mail__send_email", hooks: [letterNameCheck] }] } } })
