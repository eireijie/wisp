// An eye on the right of every password, key and code field on the desktop's own pages (setup,
// screen code). Tap to show what you typed; it turns into the crossed eye. Same look as the web app.
(() => {
  const EYE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.65 0 8.6 2.92 9.94 7a10.6 10.6 0 0 1-1.67 3.13"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12a10.6 10.6 0 0 1 4.46-5.51"/><path d="m2 2 20 20"/></svg>';
  const style = document.createElement("style");
  style.textContent = `
    .pw-wrap { position: relative; display: block; }
    .pw-wrap > input { padding-right: 42px; }
    .pw-eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 34px; height: 34px; padding: 0; margin: 0;
      display: grid; place-items: center; border: 0; border-radius: 8px; background: none; box-shadow: none; color: var(--faint); cursor: pointer; }
    .pw-eye:hover { color: var(--ink); transform: translateY(-50%) !important; }
    .pw-eye:active { transform: translateY(-50%) !important; }`;
  document.head.append(style);
  for (const input of document.querySelectorAll('input[type="password"]')) {
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    // a margin set on the field moves to the wrapper, so the eye stays centred on the field
    if (input.style.marginTop) (wrap.style.marginTop = input.style.marginTop), (input.style.marginTop = "");
    input.replaceWith(wrap);
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "pw-eye";
    const show = (shown) => {
      input.type = shown ? "text" : "password";
      eye.innerHTML = shown ? EYE_OFF : EYE;
      eye.setAttribute("aria-label", shown ? "Hide password" : "Show password");
      eye.title = eye.getAttribute("aria-label");
    };
    show(false);
    // keep the caret in the field while tapping the eye
    eye.addEventListener("mousedown", (e) => e.preventDefault());
    eye.addEventListener("click", () => show(input.type === "password"));
    wrap.append(input, eye);
  }
})();
