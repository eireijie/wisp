/**
 * Runs in the VM's Node: puts a login from the password manager into the page open in the
 * visible Chrome, over its debugging port. The login arrives on stdin (never in arguments, which
 * other processes can see). Nothing is filled unless the front page is on the login's site over
 * https, so a look-alike page gets nothing. Prints a LoginFillResult as JSON.
 */
export const FILL_LOGIN_SCRIPT = String.raw`
const read = () => new Promise((resolve) => { let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => resolve(s)); });
const login = JSON.parse(await read());
const cdp = process.env.CDP || "http://127.0.0.1:9222";
const call = (url, expression) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const done = (v) => { try { ws.close(); } catch {} resolve(v); };
  setTimeout(() => done(null), 5000);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  ws.onmessage = (m) => { const r = JSON.parse(m.data); if (r.id === 1) done(r.result?.result?.value ?? null); };
  ws.onerror = () => done(null);
});
const inPage = (d) => {
  const shown = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.disabled && !e.readOnly; };
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const words = (e) => (e.name + " " + e.id + " " + (e.getAttribute("placeholder") || "") + " " + (e.getAttribute("aria-label") || "")).toLowerCase();
  const pw = inputs.find((e) => e.type === "password" && e.autocomplete !== "new-password");
  const otp = inputs.find((e) => e.autocomplete === "one-time-code" || /\botp\b|one.?time|2fa|totp|verification code|security code/.test(words(e)));
  const textish = (e) => ["text", "email", "tel", ""].includes(e.type) && e !== otp;
  const user =
    inputs.find((e) => /username|email/.test(e.autocomplete) && textish(e)) ||
    (pw ? inputs.slice(0, inputs.indexOf(pw)).reverse().find(textish) : inputs.find((e) => textish(e) && (e.type === "email" || /user|email|login|account/.test(words(e)))));
  const set = (e, v) => {
    e.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, v);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const filled = [];
  if (pw && d.password) {
    if (user && d.username) { set(user, d.username); filled.push("username"); }
    set(pw, d.password);
    filled.push("password");
  } else if (otp && d.otp) {
    set(otp, d.otp);
    filled.push("otp");
  } else if (user && d.username) {
    set(user, d.username);
    filled.push("username");
  }
  if (!filled.length) return { filled, submitted: false, problem: pw ? "the password box is there but the login has no password" : otp ? "it wants a one-time code and the login has none saved" : "there are no sign-in boxes on the page" };
  const last = filled.includes("password") ? pw : filled.includes("otp") ? otp : user;
  const named = (b) => /sign.?in|log.?in|continue|next|submit|verify/i.test(b.innerText || b.value || b.getAttribute("aria-label") || "");
  const form = last.form;
  const buttons = [...(form || document).querySelectorAll("button, input[type=submit]")].filter((b) => shown(b) && (b.type !== "button" || named(b)));
  const button = buttons.find((b) => b.type === "submit" && (!form || form.contains(b))) || buttons.find(named);
  let submitted = false;
  try {
    if (form && form.requestSubmit) { form.requestSubmit(button && button.form === form && button.type === "submit" ? button : undefined); submitted = true; }
    else if (button) { button.click(); submitted = true; }
  } catch {}
  return { filled, submitted };
};
const pages = (await fetch(cdp + "/json/list").then((r) => r.json(), () => [])).filter((p) => p.type === "page" && p.webSocketDebuggerUrl);
let front = null;
for (const p of pages) {
  const where = await call(p.webSocketDebuggerUrl, "({ host: location.hostname, protocol: location.protocol, visible: document.visibilityState === 'visible' })");
  if (where && where.visible) { front = { page: p, where }; break; }
  if (where && !front) front = { page: p, where };
}
const host = front ? front.where.host.toLowerCase().replace(/^www\./, "") : "";
const site = login.site.toLowerCase();
const local = ["localhost", "127.0.0.1"].includes(host);
if (!front) console.log(JSON.stringify({ filled: [], submitted: false, problem: "the browser has no page open" }));
else if (!(host === site || host.endsWith("." + site)) || (front.where.protocol !== "https:" && !local)) console.log(JSON.stringify({ filled: [], submitted: false, wrongSite: host || front.page.url }));
else console.log(JSON.stringify((await call(front.page.webSocketDebuggerUrl, "(" + inPage + ")(" + JSON.stringify(login) + ")")) ?? { filled: [], submitted: false, problem: "the page didn't answer" }));
`;
