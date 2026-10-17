/* Ghost arms: geometry + markup, plus a small copy of the ghost body/face so the preview is
 * self-contained. The arm parts are what get ported to Ghost.tsx; see README.md. */
(function () {
  // --- body shapes (unchanged from Ghost.tsx) ---------------------------------------------------
  const swap = (d, a, b) => d.replaceAll(a, "§").replaceAll(b, a).replaceAll("§", b);
  const CLASSIC = "M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 104 80 96 Q75 88 70 96 Q65 104 60 96 Q55 88 50 96 Q45 104 40 96 Q35 88 30 96 Z";
  const ROUND = "M22 64 C22 38 38 26 60 26 C82 26 98 38 98 64 L98 92 Q92 100 86 92 Q80 84 74 92 Q67 100 60 92 Q53 84 46 92 Q40 100 34 92 Q28 84 22 92 Z";
  const TALL = "M38 52 C38 24 47 10 60 10 C73 10 82 24 82 52 L82 102 Q76.5 110 71 102 Q65.5 94 60 102 Q54.5 110 49 102 Q43.5 94 38 102 Z";
  const SHEET_A = "M42 52 C42 28 50 16 60 16 C70 16 78 28 78 52 C80 72 92 86 100 100 Q93 95 86 102 Q78 95 70 102 Q60 95 50 102 Q42 95 34 102 Q27 95 20 100 C28 86 40 72 42 52 Z";
  const SHEET_B = "M42 52 C42 28 50 16 60 16 C70 16 78 28 78 52 C80 72 92 86 100 100 Q93 105 86 98 Q78 105 70 98 Q60 105 50 98 Q42 105 34 98 Q27 105 20 100 C28 86 40 72 42 52 Z";
  const WISP_A = "M60 16 C80 16 90 32 90 52 C90 74 78 84 68 90 C60 95 58 104 66 108 C52 110 46 98 50 90 C36 84 30 72 30 52 C30 32 40 16 60 16 Z";
  const WISP_B = "M60 16 C80 16 90 32 90 52 C90 74 80 86 70 92 C62 97 64 106 72 110 C58 110 52 100 52 92 C38 86 30 72 30 52 C30 32 40 16 60 16 Z";

  /* `bottom` is the body's lowest point, so a userSpaceOnUse gradient from top..bottom paints
   * exactly like the old objectBoundingBox one, and arms can share it. */
  const SHAPES = {
    classic: { body: [CLASSIC, swap(CLASSIC, "104", "88")], eyes: { y: 54, x: [50, 70] }, mouthY: 66, top: 18, bottom: 100, ground: 111 },
    round: { body: [ROUND, swap(ROUND, "100", "84")], eyes: { y: 58, x: [47, 73] }, mouthY: 70, top: 26, bottom: 96, ground: 107 },
    tall: { body: [TALL, swap(TALL, "110", "94")], eyes: { y: 44, x: [52, 68] }, mouthY: 56, top: 10, bottom: 106, ground: 115 },
    sheet: { body: [SHEET_A, SHEET_B], eyes: { y: 46, x: [53, 67] }, mouthY: 57, top: 16, bottom: 102, ground: 110 },
    wisp: { body: [WISP_A, WISP_B], eyes: { y: 50, x: [50, 70] }, mouthY: 62, top: 16, bottom: 109, ground: 115 },
  };

  // --- arms ----------------------------------------------------------------------------------------
  /*
   * Each arm is one piece: a capsule, drawn in its own "shoulder frame" (origin on the body's
   * edge, +x pointing out of the body, +y running down along the edge; the left arm is the same
   * frame mirrored). It rotates about a pivot just inside the edge; its rounded root stays hidden
   * inside the body at any angle, and the round end is the hand, centered at (hand, 0).
   */
  const ARM = {
    limb: "M0 -3.6 H10.6 A3.6 3.6 0 0 1 10.6 3.6 H0 A3.6 3.6 0 0 1 0 -3.6 Z",
    hand: 10.6,
    handR: 3.6,
    depth: 3.8,
    /** width of the arm's rim band, a thinner version of the body's so the arm keeps its light middle */
    rim: 1.7,
  };

  /**
   * Where each shape's shoulders are: the edge point at about mouth height (y), per side x, the
   * edge's lean (deg; negative = the edge flares outward going down, like the sheet), and a
   * scale so arms stay ~12–16% of the body's width.
   */
  const RIG = {
    classic: { y: 66, x: [30, 90], tilt: [0, 0], s: 0.95 },
    round: { y: 70, x: [22, 98], tilt: [0, 0], s: 1.08 },
    tall: { y: 58, x: [38, 82], tilt: [0, 0], s: 0.82 },
    sheet: { y: 67, x: [38.5, 81.5], tilt: [-20.4, -20.4], s: 0.86 },
    wisp: { y: 62, x: [30.4, 89], tilt: [6.9, 11.4], s: 0.98 },
  };

  /** Still pose per mood, [left, right] in degrees: 0 = straight out, 90 = straight down. Mirrors the CSS. */
  const POSE = { awake: [52, 52], done: [-52, -52], waiting: [52, -30], working: [120, 120], asleep: [80, 80] };

  const r2 = (n) => Math.round(n * 100) / 100;
  /** the shoulder frame as an SVG transform attribute, and as a CSS transform (px = user units) */
  function frame(rig, side) {
    const i = side === "l" ? 0 : 1;
    const flip = side === "l" ? -1 : 1;
    return {
      attr: `translate(${rig.x[i]} ${rig.y}) scale(${flip} 1) rotate(${rig.tilt[i]}) scale(${rig.s}) translate(${-ARM.depth} 0)`,
      css: `translate(${rig.x[i]}px, ${rig.y}px) scale(${flip}, 1) rotate(${rig.tilt[i]}deg) scale(${rig.s}) translate(${-ARM.depth}px, 0px)`,
    };
  }
  /** a point in an arm's pivot frame (after the pose rotation), mapped to body coordinates */
  function toBody(rig, side, angle, [px, py]) {
    const i = side === "l" ? 0 : 1;
    const a = (angle * Math.PI) / 180;
    const t = (rig.tilt[i] * Math.PI) / 180;
    let x = px * Math.cos(a) - py * Math.sin(a) - ARM.depth;
    let y = px * Math.sin(a) + py * Math.cos(a);
    x *= rig.s;
    y *= rig.s;
    [x, y] = [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
    if (side === "l") x = -x;
    return { x: r2(rig.x[i] + x), y: r2(rig.y + y) };
  }

  const LAPTOP = { shell: "#343244", deck: "#4a4760", screen: "#a6e8d4" };
  const MARK = "#f5c542";

  /** The sign, upright, with the gripping hand at (0, 0). Drawn under the hand so the fist closes over the stick. */
  const SIGN = `
    <path d="M0 7.5 V-19" stroke="#8d8291" stroke-width="2.6" stroke-linecap="round"/>
    <rect x="-9.5" y="-37" width="19" height="19" rx="5" fill="${MARK}"/>
    <path d="M-6.2 -34.2 h5" stroke="#fff" stroke-opacity="0.55" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M-3.4 -30.4 C-3.4 -35 3.7 -35 3.7 -30.7 C3.7 -28.4 0.2 -28.3 0.2 -25.4" stroke="${LAPTOP.shell}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <circle cx="0.2" cy="-21.7" r="1.5" fill="${LAPTOP.shell}"/>`;

  /**
   * The arm layers for one ghost. `u` makes ids unique; `grad` is the id of the body gradient
   * (userSpaceOnUse); `bodyClip` the id of the clipPath holding the body path.
   * Returns pieces to slot into the ghost at the right depths:
   *   defs   -> inside <defs>
   *   under  -> after the body's rim (laptop deck, screen glow, sign)
   *   arms   -> right after `under`
   *   over   -> after the arms (laptop lid, which sits in front of the hands)
   */
  function arms({ shape, mood, u, grad, bodyClip }) {
    const rig = RIG[shape];
    const pose = POSE[mood] ?? POSE.awake;
    const sides = ["l", "r"];
    const f = { l: frame(rig, "l"), r: frame(rig, "r") };
    const moving = (side) => `class="ga-arm ga-${mood} ga-${side}" style="--ga-f: ${f[side].css}"`;
    const rimW = r2((2 * ARM.rim) / rig.s); // a clipped stroke shows half its width

    const defs = `
      <clipPath id="gk${u}">${sides.map((s) => `<path ${moving(s)} d="${ARM.limb}"/>`).join("")}</clipPath>
      <clipPath id="gko${u}"><path d="${ARM.limb}"/></clipPath>
      <radialGradient id="gkf${u}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${ARM.depth + 0.4}">
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.1"/>
      </radialGradient>`;

    let under = "";
    let over = "";
    if (mood === "working") {
      const hl = toBody(rig, "l", pose[0], [ARM.hand, 0]);
      const hr = toBody(rig, "r", pose[1], [ARM.hand, 0]);
      const hy = (hl.y + hr.y) / 2;
      const hand = ARM.handR * rig.s;
      const lidTop = r2(hy + hand + 0.6);
      const deckTop = r2(hy - 1.6 * rig.s);
      const w = r2(hr.x - hl.x + 18 * rig.s);
      const h = r2(Math.min(28, Math.max(18, SHAPES[shape].bottom - lidTop + 1.5)));
      const x0 = 60 - w / 2, x1 = 60 + w / 2, b0 = 60 - (w - 5) / 2, b1 = 60 + (w - 5) / 2, y1 = lidTop + h, c = 3.2;
      const lid = `M${r2(x0 + c)} ${lidTop} H${r2(x1 - c)} Q${r2(x1)} ${lidTop} ${r2(x1 - 0.3)} ${r2(lidTop + c)} L${r2(b1 + 0.2)} ${r2(y1 - c)} Q${r2(b1)} ${r2(y1)} ${r2(b1 - c)} ${r2(y1)} H${r2(b0 + c)} Q${r2(b0)} ${r2(y1)} ${r2(b0 - 0.2)} ${r2(y1 - c)} L${r2(x0 + 0.3)} ${r2(lidTop + c)} Q${r2(x0)} ${lidTop} ${r2(x0 + c)} ${lidTop} Z`;
      const dt = (w - 11) / 2, db = (w - 2) / 2;
      const deck = `M${r2(60 - dt)} ${deckTop} H${r2(60 + dt)} L${r2(60 + db)} ${r2(lidTop + 1)} H${r2(60 - db)} Z`;
      const rows = [0.38, 0.75].map((k) => r2(deckTop + (lidTop - deckTop) * k));
      const keys = rows
        .map((ky, row) => {
          const half = dt + (db - dt) * (row ? 0.75 : 0.38) - 3;
          const n = 7;
          return Array.from({ length: n }, (_, i) => {
            const kx = 60 - half + ((2 * half) / (n - 1)) * i;
            const lit = (i + row * 3) % 4 === 1;
            return `<path d="M${r2(kx - 1.3)} ${ky} h2.6" ${lit ? `class="ga-key" style="animation-delay:${r2(-((i * 0.37 + row * 0.21) % 0.9))}s"` : ""}/>`;
          }).join("");
        })
        .join("");
      under = `
        <radialGradient id="gsg${u}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${LAPTOP.screen}" stop-opacity="0.55"/><stop offset="1" stop-color="${LAPTOP.screen}" stop-opacity="0"/></radialGradient>
        <ellipse cx="60" cy="${lidTop}" rx="${r2(w * 0.48)}" ry="${r2(15 * rig.s)}" fill="url(#gsg${u})" clip-path="url(#${bodyClip})"/>
        <path d="${deck}" fill="${LAPTOP.deck}" stroke="${LAPTOP.deck}" stroke-width="1.6" stroke-linejoin="round"/>
        <g stroke="${LAPTOP.screen}" stroke-opacity="0.6" stroke-width="1.1" stroke-linecap="round">${keys}</g>
        ${[hl, hr].map((p) => `<ellipse cx="${p.x}" cy="${r2(hy + hand * 0.72)}" rx="${r2(hand * 1.05)}" ry="${r2(0.9 * rig.s)}" fill="#000" fill-opacity="0.3"/>`).join("")}`;
      over = `
        <path d="${lid}" fill="${LAPTOP.shell}"/>
        <path d="M${r2(x0 + 3.5)} ${r2(lidTop + 0.9)} H${r2(x1 - 3.5)}" stroke="${LAPTOP.screen}" stroke-opacity="0.75" stroke-width="1.1" stroke-linecap="round"/>
        <path d="${CLASSIC}" transform="translate(60 ${r2(lidTop + h / 2)}) scale(0.14) translate(-60 -59)" fill="${LAPTOP.screen}" fill-opacity="0.9"/>`;
    }
    if (mood === "waiting") {
      // keep the sign upright at the arm's middle angle; the bob then tilts it a little, like waving it
      const upright = -(pose[1] + rig.tilt[1]);
      under += `<g ${moving("r")}><g transform="translate(${ARM.hand} 0) rotate(${upright})" style="transform-box: view-box">${SIGN}</g></g>`;
    }

    const body = `<rect x="-10" y="-10" width="140" height="140" fill="url(#${grad})"`;
    const armsMarkup = `
      ${body} clip-path="url(#gk${u})"/>
      ${sides.map((s) => `<path ${moving(s)} d="${ARM.limb}" fill="none" stroke="url(#gkf${u})" stroke-width="${rimW}" clip-path="url(#gko${u})"/>`).join("")}`;
    return { defs, under, arms: armsMarkup, over };
  }

  // --- a minimal ghost, for the preview ------------------------------------------------------------
  let next = 0;
  function ghost({ shape: key, mood, colors: [top, bottom], size, animate }) {
    const u = `g${++next}`;
    const shape = SHAPES[key];
    const grad = `gb${u}`;
    const bodyClip = `gc${u}`;
    const showArms = size >= 26;
    const a = showArms ? arms({ shape: key, mood, u, grad, bodyClip }) : { defs: "", under: "", arms: "", over: "" };
    const ripple = animate && size >= 44 ? `<animate attributeName="d" dur="2.6s" repeatCount="indefinite" values="${shape.body[0]};${shape.body[1]};${shape.body[0]}" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>` : "";
    const body = (attrs) => `<path d="${shape.body[0]}" ${attrs}>${ripple}</path>`;
    const asleep = mood === "asleep";
    const happy = mood === "done";
    const ink = "#1d1d1f";
    const { x: [e1, e2], y: ey } = shape.eyes;
    const dy = mood === "working" ? 1.5 : 0;
    const eye = (cx) =>
      asleep ? `<path d="M${cx - 4.5} ${ey} Q${cx} ${ey + 3.6} ${cx + 4.5} ${ey}" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`
      : happy ? `<path d="M${cx - 4.8} ${ey + 1.5} Q${cx} ${ey - 4.5} ${cx + 4.8} ${ey + 1.5}" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
      : `<ellipse cx="${cx}" cy="${ey + dy}" rx="3.4" ry="4.4" fill="${ink}"/>`;
    const m = shape.mouthY;
    const mouth = happy
      ? `<ellipse cx="60" cy="${m + 1}" rx="3.4" ry="4" fill="${ink}"/><ellipse cx="60" cy="${m + 3}" rx="2.2" ry="1.4" fill="#ff7a93"/>`
      : asleep || mood === "working" ? `<path d="M56.8 ${m + 1.2} L63.2 ${m + 1.2}" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`
      : `<path d="M55.5 ${m} Q60 ${m + 4.2} 64.5 ${m}" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    const cheeks = asleep ? "" : `<ellipse cx="${e1 - 4}" cy="${ey + 8}" rx="4.5" ry="2.6" fill="#ff8fab" opacity="0.5"/><ellipse cx="${e2 + 4}" cy="${ey + 8}" rx="4.5" ry="2.6" fill="#ff8fab" opacity="0.5"/>`;
    const face = `<g transform="translate(0 ${mood === "working" ? 3 : 0})">${cheeks}<g class="${animate && !asleep && !happy ? "ghost-blink" : ""}">${eye(e1)}${eye(e2)}</g>${mouth}</g>`;
    const sparkle = (x, y, r, d) => `<path class="ga-sparkle" style="animation-delay:${d}s" d="M${x} ${y - r} Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y} Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r} Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y} Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r} Z"/>`;
    const t = shape.top;
    const sparkles = happy && size >= 26 ? `<g fill="${MARK}">${[[24, t + 4, 5, 0], [97, t + 2, 6, 0.35], [106, t + 34, 4, 0.7], [13, t + 38, 4.5, 0.2], [50, t - 9, 3.5, 0.55], [80, t - 8, 4, 0.9], [104, t + 62, 3, 0.45], [16, t + 66, 3.2, 1.05]].map((s) => sparkle(...s)).join("")}</g>` : "";
    const zz = asleep && size >= 26 ? `<g fill="${MARK}" font-family="ui-rounded, system-ui, sans-serif" font-weight="800"><text x="92" y="${t + 6}" font-size="15" class="${animate ? "ghost-z" : ""}">z</text><text x="101" y="${t - 5}" font-size="11" class="${animate ? "ghost-z ghost-z2" : ""}">z</text></g>` : "";
    const float = !animate ? "" : mood === "done" ? "" : mood === "asleep" ? "ghost-float-slow" : mood === "working" ? "" : "ghost-float";

    return `<span class="ghost" style="width:${size}px;height:${size}px" role="img" aria-label="${key} ghost, ${mood}">
<svg viewBox="4.5 8 111 111" width="${size}" height="${size}" overflow="visible">
  <defs>
    <linearGradient id="${grad}" gradientUnits="userSpaceOnUse" x1="0" y1="${shape.top}" x2="0" y2="${shape.bottom}">
      <stop offset="0.08" stop-color="${top}"/><stop offset="0.95" stop-color="${bottom}"/>
    </linearGradient>
    <radialGradient id="gl${u}" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="white" stop-opacity="${asleep ? 0.1 : 0.24}"/><stop offset="0.65" stop-color="white" stop-opacity="0.06"/><stop offset="1" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${bodyClip}">${body("")}</clipPath>
    ${a.defs}
  </defs>
  ${size >= 28 ? `<ellipse cx="60" cy="${shape.ground}" rx="24" ry="3.4" class="ghost-ground"/>` : ""}
  <g class="${animate && mood === "done" ? "ga-hop" : ""}" style="--ga-ground: ${shape.ground}px">
    <g class="${float}">
      ${body(`fill="url(#${grad})"`)}
      ${body(`fill="url(#gl${u})"`)}
      ${body(`fill="none" stroke="black" stroke-opacity="0.1" stroke-width="7" clip-path="url(#${bodyClip})"`)}
      ${a.under}
      ${a.arms}
      ${a.over}
      ${face}
    </g>
  </g>
  ${sparkles}${zz}
</svg></span>`;
  }

  window.GhostArms = { SHAPES, ARM, RIG, POSE, frame, toBody, arms, ghost };
})();
