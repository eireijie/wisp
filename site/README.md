# Wisp website

Wisp's marketing and docs site: the landing page, Download, Docs, Privacy policy and Terms. It's a static
[Astro](https://astro.build) site that deploys to Cloudflare Pages.

It lives outside `apps/` on purpose: `apps/*` are npm workspaces, and the site keeps its own `package.json` and
`package-lock.json` so its dependencies stay out of the root lockfile. Run everything below inside `site/`.

```bash
npm install
npm run dev       # http://localhost:4321, reloads as you edit
npm run build     # static site in dist/
npm run preview   # serve dist/ to check the build
npm run deploy    # build, then upload dist/ to the Cloudflare Pages project "wisp-app"
```

`npm run deploy` uses Wrangler, so the first time you'll need `npx wrangler login` (or a `CLOUDFLARE_API_TOKEN`) and a
Pages project named `wisp-app` (so it lives at wisp-app.pages.dev). Or connect the repo in the Cloudflare dashboard with root directory `site`, build
command `npm run build` and output directory `dist`. Node 22.12 or newer.

## Where things are

| What | Where |
| --- | --- |
| **The domain** | `SITE_URL` in `astro.config.mjs`, the only place it's set. It's `https://wisp-app.pages.dev`, the Cloudflare Pages project `wisp-app` (see `wrangler.toml`); canonical links and social tags follow it. |
| Contact link (GitHub Issues), download links, install commands, doc order | `src/lib/site.ts` |
| Pages | `src/pages/` (`index`, `download`, `privacy`, `terms`, `404`, `docs/`) |
| Look: colors, fonts, shared styles | `src/styles/global.css`, Wisp's Moonlight colors, rounded type (SF Pro Rounded on Apple devices, Nunito self-hosted through Fontsource) and glass, matching the apps |
| The ghost | `src/components/Ghost.astro`, the app's classic ghost shape |
| Icons | `public/` (`favicon.svg`, PNGs made from `apps/desktop/build/icon.png`) |

## Docs come from the repo

The docs pages are not copies. `src/content.config.ts` reads `../INSTALL.md` and `../docs/*.md` at build time, so
editing those files updates the site on the next build. `src/lib/rehype-doc-links.mjs` points links between docs at
the docs pages here and other relative links (like `README.md`) at GitHub, and wraps tables so they scroll on phones.
To add a doc, put the markdown in `docs/` and add it to `DOC_ORDER` in `src/lib/site.ts` (and to `DOC_PAGES` in the
link plugin so links to it stay on the site).

## Downloads

Download buttons use GitHub's `releases/latest/download/<file>` links, so they always point at the newest release as
long as each release has files with these exact names: `Wisp-mac-arm64.dmg`, `Wisp-mac-x64.dmg`, `Wisp-win-x64.exe`,
`Wisp-linux-x86_64.AppImage`, `Wisp-linux-amd64.deb` and `Wisp-android.apk`.

## Rules for this site

No analytics, trackers, cookies or third-party requests (the privacy policy says so). Keep JavaScript to the one copy
button script. Light and dark follow the visitor's system setting.
