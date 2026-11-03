// The cloud providers Wisp can create a server at, the recommended one first. Each has the same
// shape: id, name, apiHost, signInUrl, billingUrl, signIn (connects by signing in rather than a
// pasted token), looksLikeToken(text), plans(token), create(token, server), status(token, id) and
// remove(token, id). A future Wisp Cloud is one more module here.
module.exports = [require("./digitalocean.cjs"), require("./hetzner.cjs"), require("./vultr.cjs")];
