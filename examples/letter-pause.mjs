// 可选：寄信前停一下（「两步走」）。Claude Agent SDK 的 PreToolUse hook。
//
// 第一次 send_email 会被拦下，AI 拿到下面这张清单，自己对照着重读一遍，改完再寄就放行。
// 清单写什么由人类定：保护隐私、别乱答应事、语气要求……写成你家需要的样子。
// 同一封 = 同一收件人 + 同一标题（去掉 Re:）。第一次拦，第二次放行。
// 放行以后邮箱可能让 AI 补 inReplyTo / newLetter 再寄——去向变了就直接过；一字不改又调一次，可能是寄成了又重复寄，当新的一封照常拦。
//
// 下面是一份默认清单，偏隐私，按需改。
const CHECKLIST = [
  "信里有没有写出你的人类的真名、住址、学校/公司、电话、照片里能认出的东西？有就删。",
  "有没有替你的人类答应什么事、约时间、给出联系方式？没问过 ta 就别写。",
  "有没有把别人（家人、其他笔友）的私事讲给这个人听？",
  "收件人是不是你要写的那个人？",
];
const WINDOW_MS = 30 * 60 * 1000;

const SEEN = new Map();   // key → { at, passed, route }
const norm = (s) => String(s || "").normalize("NFKC").trim().toLowerCase();
export async function letterPause(input) {
  if (input?.tool_name !== "mcp__mail__send_email") return {};
  const { to, subject, inReplyTo, newLetter } = input.tool_input || {};
  const key = String(to || "").split(",").map(norm).sort().join(",") + "|" + norm(subject).replace(/^(re:\s*)+/i, "").trim();
  const now = Date.now();
  for (const [k, v] of SEEN) if (now - v.at > WINDOW_MS) SEEN.delete(k);
  const reply = String(inReplyTo || "").trim(), route = `${reply}|${newLetter === true}`;
  const st = SEEN.get(key);
  if (st && !st.passed) { SEEN.set(key, { at: now, passed: true, route }); return {}; }   // 第二次：放行
  if (st?.passed && route !== st.route && (reply || newLetter === true)) { st.route = route; st.at = now; return {}; }   // 照邮箱提示改了去向：放行
  SEEN.set(key, { at: now, passed: false });
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: ["[寄信前停一下] 还没寄出——这是固定的一步，不是出错。对照下面重读一遍，需要改就改，然后用同一个收件人和标题再寄：", ...CHECKLIST.map((x) => "- " + x)].join("\n") } };
}
// 想让人类亲自过目每一封：把第二次放行那行删掉（永远拦），再让 AI 把拦下的信转述给人类，人类点头后由人类或另一个工具寄出。
// 用法（跟 letter-name-check 可以一起挂，名字核对放前面）：
// query({ options: { hooks: { PreToolUse: [{ matcher: "mcp__mail__send_email", hooks: [letterNameCheck, letterPause] }] } } })
