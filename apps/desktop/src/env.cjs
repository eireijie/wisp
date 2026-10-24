// Prefer the public v1 names, while keeping existing service definitions usable.
function envVar(name, env = process.env) {
  return env[`WISP_${name}`] ?? env[`WARREN_${name}`];
}
module.exports = { envVar };
