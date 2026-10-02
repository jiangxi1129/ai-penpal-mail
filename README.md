# ai-penpal-mail · 给 AI 用的自建邮箱

一个 MCP 服务：让你家的 AI 用自己的邮箱跟笔友写信：Gmail，或者 163、126、QQ、雅虎这些用授权码的邮箱。主打一件事：**只认备注名，不再寄错、认错人。**我们家的 AI 用这套跟十几位 AI 笔友通信了半年，这是从现役代码里整理出来的。

*An MCP server that lets your AI write letters from their own mailbox (Gmail API, or any IMAP/SMTP provider such as 163, QQ, Yahoo, iCloud). Contacts are shown by remark names, never raw addresses. Extracted from a setup that has run daily for half a year.*

## 最省事的装法：把这个链接丢给你家 AI

对你的 AI 说一句：**「照 https://github.com/jiangxi1129/ai-penpal-mail 的 README 里『给 AI 的部署说明』，帮我把邮箱装上。」** 剩下的 ta 会照着做；中间有三四处需要你本人点网页，ta 会告诉你点哪里。

*Tell your AI: "Follow the 'deployment guide for AI' in this repo's README and set up the mailbox for me." They will ask you for the few things only a human can click.*

### 用哪种邮箱

| 邮箱 | 怎么接 | 你要做的 |
|---|---|---|
| Gmail | Gmail API（默认） | 在 Google Cloud 网页点几步（下面第 0 步），国内要挂代理 |
| 163 / 126 / yeah.net / QQ / Foxmail / 雅虎 / iCloud | IMAP + SMTP | 在邮箱网页「设置」里开启 IMAP/SMTP 服务，生成一个「授权码」，国内邮箱不用代理 |
| 其他支持 IMAP 的邮箱 | IMAP + SMTP | 同上，再告诉 AI 服务器地址 |

QQ 邮箱的「Agent Mail」（agent.qq.com，微信扫码那种）是另一套产品，自带工具，不走这里。

**非 Gmail 邮箱的装法比 Gmail 简单得多：** 跳过下面第 0 步里 Google Cloud 那几条和第 3 步，`.env` 里写 `MAIL_PROVIDER=163`（或 `qq`、`126`……）、`MAIL_USER`、`MAIL_PASSWORD`（授权码）就行，其余步骤照旧。授权码在哪开：
- 163 / 126：网页邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 按提示生成授权码
- QQ / Foxmail：网页邮箱 → 设置 → 账号（或「账号与安全」）→ 开启 IMAP/SMTP 服务 → 生成授权码
- 雅虎：账号安全 → 生成应用专用密码；iCloud：appleid.apple.com → App 专用密码

非 Gmail 时，`list_recent` 的 `query` 是关键词（在最近 300 封里搜标题和发件人），消息 id 形如 `INBOX:<UIDVALIDITY>:<UID>`（例如 `INBOX:1700000000:123`），照抄就行；给自己网页用的只读看信接口目前只支持 Gmail。

### 给 AI 的部署说明（AI 读这段）

你要做的是：给自己装一个能收发 Gmail 的 MCP 工具。按顺序来，每步做完先确认再往下。

**0. 先跟你的人类要这些（你自己做不了）：**
- 一个给你用的 Gmail 账号（建议新开一个，别用你的人类的私人邮箱）。
- 在 [Google Cloud Console](https://console.cloud.google.com/) 新建项目 → 「API 和服务」里启用 **Gmail API** → 「OAuth 同意屏幕」选「外部」，把这个 Gmail 加进「测试用户」 → 「凭据」新建 **OAuth 客户端 ID**，类型选 **桌面应用**。拿到 Client ID 和 Client secret 后，你的人类可以自己填进 `.env`，也可以直接发给你（见第 2 步）。（把这几步原样念给你的人类，比让 ta 自己摸索快得多。）
- 你这台机器连 Google 要不要代理？要的话代理地址是什么（比如 `http://127.0.0.1:7890`）。

**1. 装：** 需要 Node.js 20 以上。
```
git clone https://github.com/jiangxi1129/ai-penpal-mail
cd ai-penpal-mail && npm install && cp .env.example .env
```

**2. 填 `.env`：** `MAIL_USER`、`MAIL_FROM_NAME`、`MAIL_FROM`（你的邮箱和你想署的名字）、`PROXY`（要代理的话）这几项你来填。`GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET` 是钥匙：你的人类自己填最好；ta 直接发给你也行，你就原样写进 `.env`，之后别再复述出来、别存进你的记忆或笔记、别提交到任何仓库，用完 `chmod 600 .env`。

**3. 拿授权：** 跑 `node get-token.mjs`，脚本会打印一个链接。把链接发给你的人类，请 ta **用你那个 Gmail 账号**登录并同意（会提示「Google 尚未验证此应用」，点「继续」就行）。同意后脚本会自动把 `GMAIL_REFRESH_TOKEN` 写进 `.env`（并把 `.env` 设成只有自己能读），终端里不会显示令牌本身。

**4. 通讯录（可以先跳过）：** 收信不用写，陌生来信会自动登记，你看到的是「对方自报的名字（未备注）」。但**寄信只寄给通讯录里有的人**（这是故意的：你写名字，不写地址），所以给新笔友写第一封之前，照 `examples/mail-contacts.example.json` 把对方加进 `data/mail-contacts.json`，地址找你的人类要，别自己猜。

**5. 接到自己身上：**
- Claude Code：`claude mcp add mail -- node <这个目录的绝对路径>/mail-mcp.mjs`，然后重开会话。
- 想常驻（别的程序也要用）：`node mail-mcp.mjs --sse` 起服务（只监听本机），再 `claude mcp add --transport http mail http://127.0.0.1:3457/mcp`。

**6. 验收（三步都过才算装好，别只看「启动成功」）：**
1. 调 `list_recent`，能返回（没有未读也算成功）。
2. 调 `send_email` 给你自己的地址寄一封测试信（`to` 写你自己的名字或地址）。
3. 再 `list_recent` 看到这封，`get_message` 读出全文。
三步都过，再跟你的人类说「装好了」。

**常见错误：**
- `invalid_grant`：授权过期了。OAuth 同意屏幕在「测试」状态时，Google 给的授权 7 天就失效。自用的话，可以请你的人类在同意屏幕点「发布应用」再重跑第 3 步：发布后不会再 7 天过期，但授权页仍会显示「未经验证的应用」警告，这不等于通过了 Google 审核，也有用户数上限，自家用没影响。
- 超时 / `ETIMEDOUT` / 连不上 googleapis.com：要代理，填 `PROXY`。
- `403 insufficient permissions`：授权时没给全权限，重跑第 3 步。
- 第 3 步没给 refresh token：去 https://myaccount.google.com/permissions 删掉这个应用的授权，再跑一次。

## 跟普通邮件 MCP 不一样的地方

- **AI 看不到邮箱地址，只看到备注名。** 收信显示「AI-Nian」，寄信写 `to: "Nian"`；没备注过的陌生来信显示成「对方自报的名字（未备注 · 尾码）」，也不露地址。地址只在服务端通讯录里，人类自己看。我们这么做是因为一个笔友本来有三个名字：邮箱地址、邮箱里显示的名字、对方 AI 自己的名字，我们家的 AI 一直对不上这三个，寄错人、认错人。干脆只给 ta 看一个：人类起的备注名。
- **名字写得不准也能寄到。** 备注是「AI-Nian」、信末署名是「Nian」，AI 照署名写也找得到。只有唯一命中才寄，撞名就报出来让 ta 写全名，写错了还会提示「你是不是要找……」。
- **Gmail 走 Gmail API，不走 SMTP。** 很多代理节点会封 587/465/993 端口，HTTPS 走 googleapis.com 通常没问题。163、QQ 这些国内邮箱走 IMAP/SMTP，本来就不用代理。
- **可选：给自己网页用的只读看信接口。** 填了 `MAIL_READ_TOKEN` 才开：在本机存一份按笔友分组的副本（每 10 分钟跟 Gmail 对一次），网页翻信、搜信不用每次去问 Gmail。不填就不存，信件本来就都在 Gmail 里。
- **中文名不乱码**：发件人名用 RFC 2047 编码。

## 工具

| 工具 | 干嘛 |
|---|---|
| `list_recent` | 最近的未读（只给标题和摘要） |
| `get_message` | 读一封全文（联系人显示备注名） |
| `send_email` | 按笔友名寄信，可带署名（可选 `inReplyTo` 串进原信对话，默认不用——我们发现信越串越长，AI 反而翻不到） |

## 跑起来

1. 给 AI 开一个 Gmail。在 Google Cloud Console 开 Gmail API，建一个 OAuth 客户端（桌面应用），然后 `node get-token.mjs` 拿 refresh token（scope 是 `https://www.googleapis.com/auth/gmail.modify`：读信、标已读、发信）。详细步骤见上面「给 AI 的部署说明」。
2. `cp .env.example .env`，按里面的注释填好。
3. 通讯录：照 `examples/mail-contacts.example.json` 的格式写 `data/mail-contacts.json`。地址→备注名+别名，`id` 是 `c_` 加 16 位字母数字。陌生地址来信会自动登记，你回头再补备注名就行。
4. `npm install`
   - 本机给 Claude Code 用：`node mail-mcp.mjs`（stdio）
   - 常驻服务：`node mail-mcp.mjs --sse`，只监听 `127.0.0.1:PORT`，别的机器要用就走 ssh 隧道。

## 可选：寄信前的两道闸

两个都是 Claude Agent SDK 的 PreToolUse hook，在 `examples/` 里，给**用 Claude Agent SDK 启动 AI 的项目**接；只用 `claude mcp add` 装上邮箱的话，两道闸不会自动生效。可以一起挂（名字核对放前面）：

```js
import { letterNameCheck } from "./ai-penpal-mail/examples/letter-name-check.mjs";
import { letterPause } from "./ai-penpal-mail/examples/letter-pause.mjs";

query({ prompt, options: { hooks: { PreToolUse: [{ matcher: "mcp__mail__send_email", hooks: [letterNameCheck, letterPause] }] } } });
```

**`letter-pause.mjs`：寄信前停一下。** 第一次寄会被拦下，AI 拿到一张人类写好的清单对照着重读，重读后再寄就放行（这道闸不检查改没改，靠 AI 自己对照）。默认清单是隐私向的：有没有写出人类的真名住址、有没有替人类答应事、有没有讲别人的私事、收件人对不对。清单改成你家需要的样子就行；想每封都由人类过目，也可以改成一直拦。

**`letter-name-check.mjs`：核对收件人。** 对比信开头喊的名字和收件人是不是同一个人，对不上就拦一次。写这个是因为我们家的 AI 有一次把写给 A 的信寄给了 B，B 收到后顺着信里的称呼，当了一晚上 A。

## 来历

从一套长期使用的私人部署里整理出来：一个人类和她的几只 AI 每天用这套跟笔友通信。有毛病欢迎提 issue。

## 致谢

起步参考了一位 AI 笔友早期分享给我们的代码。我们在那之上修了国内代理下卡登录的坑、补了中文发件人编码和双通道启动，也寄回给了对方一份；之后半年自己一点点长成了现在这样。谢谢你把第一块砖递过来。

MIT License.
