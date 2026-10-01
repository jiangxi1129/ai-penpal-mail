#!/usr/bin/env node
/**
 * get-token.mjs — 拿 Gmail 的 refresh token（只需要跑一次）
 *
 * 前提：.env 里已经填了 GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET（OAuth 客户端类型选「桌面应用 Desktop app」）。
 * 用法：node get-token.mjs
 *   1. 它打印一个链接，主人用 AI 那个 Gmail 账号在浏览器里打开、同意授权；
 *   2. 浏览器跳回 http://127.0.0.1:<随机端口>/，这里收下授权码（带 state 校验和 PKCE）；
 *   3. 把 refresh token 写进 .env 的 GMAIL_REFRESH_TOKEN，.env 权限设成 600。终端不显示令牌本身。
 * 需要代理时 .env 里填 PROXY（授权码换令牌那一步也走代理）。
 */
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from "node:fs";
import "dotenv/config";

const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret, PROXY } = process.env;
if (!id || !secret) { console.error("先在 .env 里填 GMAIL_CLIENT_ID 和 GMAIL_CLIENT_SECRET"); process.exit(1); }
if (!existsSync(".env")) { console.error("没找到 .env：先 cp .env.example .env 并填好"); process.exit(1); }
// 换令牌的请求走 google-auth-library 自己的传输层，google.options 管不到它；它认环境变量里的代理
if (PROXY) { process.env.HTTPS_PROXY = PROXY; process.env.HTTP_PROXY = PROXY; }
const { google } = await import("googleapis");
const { HttpsProxyAgent } = await import("https-proxy-agent");
if (PROXY) google.options({ agent: new HttpsProxyAgent(PROXY) });

function saveToken(token) {
  let env = readFileSync(".env", "utf8");
  env = /^GMAIL_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, () => "GMAIL_REFRESH_TOKEN=" + token) : env.replace(/\n?$/, "\nGMAIL_REFRESH_TOKEN=" + token + "\n");
  writeFileSync(".env.tmp", env, { mode: 0o600 });
  chmodSync(".env.tmp", 0o600);
  renameSync(".env.tmp", ".env");
  chmodSync(".env", 0o600);
}

const state = crypto.randomBytes(16).toString("hex");
let handled = false;
const server = http.createServer();
server.listen(0, "127.0.0.1", async () => {
  const redirect = `http://127.0.0.1:${server.address().port}/`;
  const oauth = new google.auth.OAuth2(id, secret, redirect);
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", state, code_challenge_method: "S256", code_challenge: codeChallenge,
    scope: ["https://www.googleapis.com/auth/gmail.modify"] });
  console.log("\n用 AI 的那个 Gmail 账号打开这个链接并同意授权：\n\n" + url + "\n\n（等你点完，这里会自动继续）");
  server.on("request", async (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    if (!q.get("code") && !q.get("error")) { res.statusCode = 404; res.end(); return; }   // favicon 之类
    if (handled) { res.end("已经处理过了，回终端看结果。"); return; }
    // 先核 state 再占位：别的本机请求带个错 state 不能把这次授权机会吃掉
    if (q.get("state") !== state) { res.statusCode = 400; res.end("state 对不上，不是这次发起的授权，忽略。"); return; }
    handled = true;
    const finish = (msg, ok) => { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.end(msg); (ok ? console.log : console.error)("\n" + msg); server.close(); if (!ok) process.exitCode = 1; };
    if (q.get("error")) return finish("授权被拒绝或出错：" + q.get("error"), false);
    try {
      const { tokens } = await oauth.getToken({ code: q.get("code"), codeVerifier });
      if (!tokens.refresh_token) throw new Error("Google 没给 refresh token：去 https://myaccount.google.com/permissions 删掉这个应用的授权再跑一次");
      saveToken(tokens.refresh_token);
      finish("✓ 拿到了，已写进 .env 的 GMAIL_REFRESH_TOKEN（.env 已设为只有自己可读）。可以关掉这个页面。", true);
    } catch (e) { finish("出错了：" + e.message, false); }
  });
});
