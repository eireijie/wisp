import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false, useAppearance: () => ({ resolvedMode: "light", toggleMode: () => {} }) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
import { PasswordInput } from "./PasswordInput.tsx";
import { Input } from "./ui.tsx";
import { AuthInput } from "./auth.tsx";
import { TextBox } from "./MarketParts.tsx";
import { CodeInput } from "./ScreenCode.tsx";
import { InPlace } from "../views/AgentSections.tsx";

const eye = 'aria-label="Show password"';

describe("Show password", () => {
  it("puts an eye on the right of a password field, hidden to start", () => {
    const html = renderToStaticMarkup(createElement(PasswordInput, { value: "secret", onChange: () => {}, "aria-label": "Password" }));
    expect(html).toContain('type="password"');
    expect(html).toContain(eye);
    expect(html).toContain('aria-pressed="false"');
  });
  it("comes with every shared field when it holds a password, key or code", () => {
    for (const el of [
      createElement(Input, { type: "password" }),
      createElement(AuthInput, { type: "password" }),
      createElement(TextBox, { type: "password" }),
      createElement(CodeInput, { kind: "pin", value: "", onChange: () => {} }),
    ])
      expect(renderToStaticMarkup(el)).toContain(eye);
    // a plain field gets none
    expect(renderToStaticMarkup(createElement(Input, { type: "text" }))).not.toContain(eye);
    expect(renderToStaticMarkup(createElement(TextBox, {}))).not.toContain(eye);
  });
});

describe("A name you can tell is editable", () => {
  it("is a field with a pencil by default, and a plain line when asked", () => {
    const field = renderToStaticMarkup(createElement(InPlace, { value: "Ivy", onSave: async () => {}, label: "Name" }));
    expect(field).toContain("data-inplace-field");
    expect(field).toContain("lucide-pencil");
    const bare = renderToStaticMarkup(createElement(InPlace, { value: "gpt", onSave: async () => {}, label: "Model id", look: "bare" }));
    expect(bare).not.toContain("data-inplace-field");
    expect(bare).not.toContain("lucide-pencil");
  });
});
