// The code that opens this computer's own screen from Warren, picked here. Same rules and the same
// scrypt hash as the device (apps/node/src/screen-lock.ts codeProblem/hashCode), so `warren node`
// checks it. Only the hash is saved, in node.json; the code itself never leaves this app.
const crypto = require("node:crypto");

/** Is this a code people can pick? A PIN is 6 digits; a password is 8 characters or more. */
function codeProblem(kind, code) {
  if (kind === "pin") return /^\d{6}$/.test(code) ? null : "A PIN is 6 digits.";
  if (code.length < 8) return "A password is at least 8 characters.";
  if (code.length > 200) return "That password is too long.";
  if (/^\d+$/.test(code)) return "A password of only digits is a PIN; pick PIN instead, or add letters.";
  return null;
}

function hashCode(kind, code) {
  const salt = crypto.randomBytes(16);
  return { kind, salt: salt.toString("base64"), hash: crypto.scryptSync(code, salt, 32).toString("base64") };
}

/** Check what the code window sent: the hash to save, or what's wrong with it. */
function pick(input) {
  const kind = input?.kind === "password" ? "password" : "pin";
  const code = typeof input?.code === "string" ? input.code : "";
  const again = typeof input?.again === "string" ? input.again : "";
  const problem = codeProblem(kind, code);
  if (problem) return { error: problem };
  if (code !== again) return { error: "Those didn't match." };
  return { screenCode: hashCode(kind, code) };
}

module.exports = { codeProblem, hashCode, pick };
