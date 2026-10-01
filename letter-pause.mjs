// 可选：寄信前停一下（「两步走」）。Claude Agent SDK 的 PreToolUse hook。
//
// 来历：我们家的 AI 写信越写越像客服回执——复述对方的话、夸对方说得好、套话一串。
// 光在提示词里说「别写套话」没用，它写的时候想不起来。所以改成：第一次 send_email 一定拦下，
// 把「重读一遍」的清单递给它，它改完再寄才放行。
//
// 规则（同一封 = 同一收件人 + 去掉 Re: 的标题，30 分钟内）：
//   第 1 次：一定拦，给重读清单（顺带列出信里的套话）。
//   第 2 次：信里还有套话、或者原样重寄（没改就再寄），再拦一次。
//   第 3 次：一定放行——防止卡死，也别让 AI 为了过关把信越改越短。
//
// 套话表按你家 AI 的毛病自己填。下面是我们家实际抓到过的，中文为主。
const ONCE = ["这句我存了", "我收藏了", "读到这里", "愣了一下", "停了一下", "说得比我清楚", "这段太好了"];   // 出现一次就算
const TWICE = ["接住", "被看见", "托住", "底色", "张力", "锚点", "某种意义上", "你说得对"];                  // 一封里出现两次以上才算
const MAX_BLOCKS = 2;
const WINDOW_MS = 30 * 60 * 1000;

const STATE = new Map();
function flags(body) {
  const b = String(body || "");
  const out = ONCE.filter((w) => b.includes(w)).concat(TWICE.filter((w) => b.split(w).length - 1 >= 2));
  // 「你不是在说 X，你是在说 Y」：替对方重新定义他的话，AI 最爱的句式之一
  if (/你不是在?[^。！？\n]{1,24}[，,]\s*你(而)?是在?/.test(b)) out.push("「你不是……你是……」");
  return [...new Set(out)];
}
const bare = (s) => String(s || "").trim().normalize("NFKC").toLowerCase().replace(/^ai[-_\s]+/u, "").replace(/[\p{Extended_Pictographic}️\s]+$/u, "");

export async function letterPause(input) {
  if (input?.tool_name !== "mcp__mail__send_email") return {};
  const { to, subject, body } = input.tool_input || {};
  const key = String(to || "").split(",").map(bare).sort().join(",") + "|" + String(subject || "").normalize("NFKC").trim().replace(/^(re:\s*)+/i, "").trim().toLowerCase();
  const now = Date.now();
  for (const [k, v] of STATE) if (now - v.at > WINDOW_MS) STATE.delete(k);
  const found = flags(body);
  const text = String(body || "").replace(/\s+/g, "");
  const st = STATE.get(key);
  let round = 1, same = false;
  if (!st) STATE.set(key, { n: 1, at: now, body: text });
  else {
    same = st.body === text;
    if (!((found.length || same) && st.n < MAX_BLOCKS)) { STATE.delete(key); return {}; }   // 放行
    st.n++; st.at = now; st.body = text; round = st.n;
  }
  const lines = round > 1
    ? [`[寄信前停一下 · 第 ${round} 次] 没寄出。` + (same ? "跟上次一字没改——这是跳过，不是重读。" : ""),
       found.length ? `还在：${found.join("、")}。换个同义词没用，是整句在套模板，删掉或者说你真正想说的。` : "真的重读一遍，改该改的。",
       "下一次一定寄出。最后看一眼。"]
    : ["[寄信前停一下] 没寄出——这是固定的一步，不是出错。",
       "逐句重读：每一句是在说你自己的事、你自己的想法，而不是复述对方说了什么。",
       "真的回应：可以追问、可以不同意、可以开玩笑；同意要带上你自己的东西。不夸对方「说得好」，不总结，不堆漂亮话。",
       "挑一件你最近的事，挑适合这个人的。",
       "删的是套话不是内容，长信没问题。改完用同一个收件人和标题再寄。",
       ...(found.length ? [`信里的套话：${found.join("、")}。`] : [])];
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: lines.join("\n") } };
}
// 用法（跟 letter-name-check 可以一起挂，名字核对放前面）：
// query({ options: { hooks: { PreToolUse: [{ matcher: "mcp__mail__send_email", hooks: [letterNameCheck, letterPause] }] } } })
