# Ghost arms

Small, stubby arms that grow out of the ghost's body, for all five shapes and five moods.

| File | What it is |
| --- | --- |
| `ghost-arms-preview.html` | Standalone preview: 5 shapes × 5 moods at 170px, plus 46px and 60px. Open it in a browser. |
| `GhostArms.tsx` | Drop-in module for `apps/web/src/components/`: geometry, per-shape rig, and `ghostArms()` which returns the SVG layers. |
| `ghost-arms.css` | Keyframes, pose classes, reduced-motion still poses. Append it to `apps/web/src/index.css`. |
| `ghost-arms.js`, `preview.html`, `build.py` | The preview's sources. Run `python3 build.py` to rebuild the standalone page. |

## How the arms become part of the body

Each arm is **one piece**: a simple capsule (half-width 3.6, round end as the hand) drawn in a **shoulder frame**. The frame's origin is on the body's edge at about mouth height, +x points out of the body and +y runs down along the edge. The left arm uses the same frame, mirrored. The arm rotates about a pivot 3.8 units inside the edge, so its rounded root stays hidden inside the body at any angle. About 10 units show past the edge, roughly 15% of the body's width.

1. **Same gradient as the body.** The body gradient becomes `gradientUnits="userSpaceOnUse"` from `shape.top` to `shape.bottom`, which looks exactly like the old bounding-box gradient. The arms are not filled directly: a rect painted with that same gradient is clipped to the arm shapes. So at any height, angle or animation frame, an arm is exactly the body's color there, with no seam. Where the arm comes out, it covers the body's rim.
2. **An even rim that follows the outline.** The arm's rim is a stroke clipped inside the capsule, so the lighter middle is the same shape as the arm, just inset. It's thinner than the body's (1.7 vs 3.5 units), so a narrow arm doesn't go dark. A hard-edged radial-gradient stroke hides the rim within 4.2 units of the pivot, so no line shows where the arm leaves the body. When an arm lies across the body (working, sheet), the rim is what separates it from the body.
3. **No outline anywhere.**

There are no filters, so this is cheap with 20+ ghosts. Each ghost adds 2 small clipPaths, 1 gradient rect and 2 rim paths. Each moving arm part is a single element whose transform comes from CSS:

```css
transform: var(--ga-f) rotate(calc(var(--ga-a) + var(--ga-w)));
```

`--ga-f` is the static shoulder frame, set inline. `--ga-a` (pose angle) and `--ga-w` (wiggle) are registered with `@property` so they can be animated. This works inside `<clipPath>`, which can't contain `<g>`, and lets two animations (such as a raise and a wiggle) run on one element at once.

## The markup (placeholders)

`{u}` is a unique id, `{top}`/`{bottom}` are the body's gradient colors, and `{T}`/`{B}` are `shape.top`/`shape.bottom`. Each side's frame in CSS is `{F}` = `translate({Sx}px, {Sy}px) scale({±1}, 1) rotate({tilt}deg) scale({s}) translate(-3.8px, 0px)`. Per-shape values are in `ARM_RIG`:

| shape | Sy | Sx left / right | tilt left / right | s | bottom |
| --- | --- | --- | --- | --- | --- |
| classic | 66 | 30 / 90 | 0 / 0 | 0.95 | 100 |
| round | 70 | 22 / 98 | 0 / 0 | 1.08 | 96 |
| tall | 58 | 38 / 82 | 0 / 0 | 0.82 | 106 |
| sheet | 67 | 38.5 / 81.5 | −20.4 / −20.4 | 0.86 | 102 |
| wisp | 62 | 30.4 / 89 | 6.9 / 11.4 | 0.98 | 109 |

```html
<defs>
  <linearGradient id="b{u}" gradientUnits="userSpaceOnUse" x1="0" y1="{T}" x2="0" y2="{B}">
    <stop offset="0.08" stop-color="{top}"/><stop offset="0.95" stop-color="{bottom}"/>
  </linearGradient>
  <clipPath id="gk{u}">           <!-- both arms, animated by CSS -->
    <path class="ga-arm ga-{pose} ga-l" style="--ga-f: {F left}"  d="ARM"/>
    <path class="ga-arm ga-{pose} ga-r" style="--ga-f: {F right}" d="ARM"/>
  </clipPath>
  <clipPath id="gko{u}"><path d="ARM"/></clipPath>
  <radialGradient id="gkf{u}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="4.2">
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.1"/>
  </radialGradient>
</defs>

<!-- …body fill, highlight, rim, then: -->
<rect x="-10" y="-10" width="140" height="140" fill="url(#b{u})" clip-path="url(#gk{u})"/>
<path class="ga-arm ga-{pose} ga-l" style="--ga-f: {F left}"  d="ARM" fill="none" stroke="url(#gkf{u})" stroke-width="{3.4/s}" clip-path="url(#gko{u})"/>
<path class="ga-arm ga-{pose} ga-r" style="--ga-f: {F right}" d="ARM" fill="none" stroke="url(#gkf{u})" stroke-width="{3.4/s}" clip-path="url(#gko{u})"/>
```

The arm path:

```
ARM  M0 -3.6 H10.6 A3.6 3.6 0 0 1 10.6 3.6 H0 A3.6 3.6 0 0 1 0 -3.6 Z
```

Poses are only a class change: `{pose}` is one of `awake | done | waiting | working | asleep | rest`.

| Mood | Still pose (deg, 0 = out, 90 = down) | Motion |
| --- | --- | --- |
| Hi (`awake`) | 52 / 52 | Every 5s the right arm lifts and waves three times. On hover it waves right away. The left arm breathes. |
| Done | −52 / −52 (V) | Arms pump −36↔−76 in time with a 1.1s hop. Eight gold sparkles twinkle. |
| Needs your OK (`waiting`) | 52 / −30 | The right hand grips the sign's stick and bobs −22↔−40. The sign stays nearly upright, so it reads as waving it. |
| Working | 120 / 120 | The hands rest on the keyboard and tap in turn. Some keys flash. |
| Asleep | 80 / 80 | Tucked against the sides with a slow breath. The gray comes from the body colors, so the arms follow it automatically. |
| listening / thinking / error (`rest`) | 52 / 52 | Breathing only. |

With `prefers-reduced-motion`, the app's `data-motion="reduce"`, or `animate={false}`, every animation stops. Each class already sets its still pose, so nothing jumps.

### Working: why the laptop faces the ghost

Stubby arms attached at mouth height can reach about 10 units. A laptop with its screen facing us would put the keyboard 20+ units lower and cover the face. So the laptop faces the ghost. We see the dark lid from behind, and over its top edge the keyboard deck, lit mint by the screen, with both hands resting on it. The mint shows on the keys, as a glow on the ghost's body and lid edge, and as a small ghost logo on the lid. The lid covers the lower body. The hands are the body's color and sit on top of the deck, and you can see the arms running from the shoulders down to them.

## Integrating into Ghost.tsx

1. Add `bottom` to `ShapeDef`: classic 100, round 96, tall 106, sheet 102, wisp 109. Switch `b${uid}` to `gradientUnits="userSpaceOnUse" x1="0" y1={shape.top} x2="0" y2={shape.bottom}`.
2. Call `const arms = details ? ghostArms({ shape: look.shape, mood, uid, grad: \`b${uid}\`, bodyClip: \`c${uid}\`, bottom: shape.bottom }) : null` (`details` is the existing `size >= 26`).
3. Put `{arms?.defs}` in `<defs>`. Put `{arms?.under}{arms?.arms}{arms?.over}` right after the rim path, before `<g ref={face}>`.
4. Delete the old `mood === "working"` laptop block and the old `mood === "waiting"` sign block.
5. Done: on the outer group, use `ga-hop` with `style={{ "--ga-ground": \`${shape.ground}px\` }}` in place of `ghost-done`. You can also replace the three sparkles with the eight in `ghost-arms.js`.
6. Append `ghost-arms.css` to `index.css`. You can drop `.ghost-sign`, `.ghost-type` and `.ghost-key` with their keyframes.
7. Hover-to-wave uses `.ghost:hover`. If it should only happen on interactive ghosts, change it to `.ghost-interactive:hover`.

Note on the existing `.ghost svg g { transform-box: fill-box }` rule: it changes the origin of any `<g>` that has a rotate or scale. The arm rule is written as `.ghost .ga-arm` so it wins, and the sign's inner group sets `transform-box: view-box` inline.
