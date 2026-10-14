import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fitInto, type KeyCombo } from "@warren/core";
import { ActionError, cached, type Button, type Direction, type Driver, type Shot, type Size } from "./driver.ts";

/**
 * A Windows PC's own screen, through one long-lived PowerShell helper (Win32 SendInput for the
 * mouse and keyboard, System.Drawing for screenshots), so each action doesn't pay PowerShell's
 * startup. It reads one JSON command per line and answers with one JSON line.
 */
const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
# commands and answers are UTF-8 JSON, so typed text in any script comes through unchanged
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WarrenInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); Send(i); }
  public static void Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? 2u : 0u; Send(i); }
  public static void Unicode(char c, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wScan = c; i.u.ki.dwFlags = 4u | (up ? 2u : 0u); Send(i); }
}
"@
[WarrenInput]::SetProcessDPIAware() | Out-Null
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$BTN = @{ left = @(2, 4); right = @(8, 16); middle = @(32, 64) }
$MODS = @{ ctrl = 17; alt = 18; shift = 16; meta = 91 }

function Shot($c) {
  $w = [WarrenInput]::GetSystemMetrics(0); $h = [WarrenInput]::GetSystemMetrics(1)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size); $g.Dispose()
  $out = New-Object System.Drawing.Bitmap ([int]$c.width), ([int]$c.height)
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, [int]$c.width, [int]$c.height); $g2.Dispose(); $bmp.Dispose()
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)
  $ms = New-Object System.IO.MemoryStream; $out.Save($ms, $jpeg, $ep); $out.Dispose()
  return [Convert]::ToBase64String($ms.ToArray())
}

function Press($vk, $mods) {
  foreach ($m in $mods) { [WarrenInput]::Key($MODS[$m], $false) }
  [WarrenInput]::Key($vk, $false); [WarrenInput]::Key($vk, $true)
  [array]::Reverse($mods); foreach ($m in $mods) { [WarrenInput]::Key($MODS[$m], $true) }
}

function Handle($c) {
  switch ($c.op) {
    'size' { return @{ width = [WarrenInput]::GetSystemMetrics(0); height = [WarrenInput]::GetSystemMetrics(1) } }
    'shot' { return Shot $c }
    'move' { [WarrenInput]::SetCursorPos($c.x, $c.y) | Out-Null }
    'click' {
      [WarrenInput]::SetCursorPos($c.x, $c.y) | Out-Null
      for ($i = 0; $i -lt $c.count; $i++) { [WarrenInput]::Mouse($BTN[$c.button][0], 0); [WarrenInput]::Mouse($BTN[$c.button][1], 0); Start-Sleep -Milliseconds 40 }
    }
    'mouse' { [WarrenInput]::SetCursorPos($c.x, $c.y) | Out-Null; [WarrenInput]::Mouse($BTN[$c.button][$(if ($c.down) { 0 } else { 1 })], 0) }
    'drag' {
      [WarrenInput]::SetCursorPos($c.x, $c.y) | Out-Null; [WarrenInput]::Mouse(2, 0)
      for ($i = 1; $i -le 12; $i++) { [WarrenInput]::SetCursorPos([int]($c.x + ($c.toX - $c.x) * $i / 12), [int]($c.y + ($c.toY - $c.y) * $i / 12)) | Out-Null; Start-Sleep -Milliseconds 15 }
      [WarrenInput]::Mouse(4, 0)
    }
    'scroll' {
      [WarrenInput]::SetCursorPos($c.x, $c.y) | Out-Null
      $d = 120 * $c.amount
      switch ($c.direction) { 'up' { [WarrenInput]::Mouse(0x800, $d) } 'down' { [WarrenInput]::Mouse(0x800, -$d) } 'left' { [WarrenInput]::Mouse(0x1000, -$d) } 'right' { [WarrenInput]::Mouse(0x1000, $d) } }
    }
    'type' {
      foreach ($ch in $c.text.ToCharArray()) {
        if ($ch -eq [char]10) { Press 13 @() } elseif ($ch -eq [char]9) { Press 9 @() } elseif ($ch -ne [char]13) { [WarrenInput]::Unicode($ch, $false); [WarrenInput]::Unicode($ch, $true) }
      }
    }
    'key' {
      $vk = $c.vk
      if ($vk -eq $null) { $vk = [WarrenInput]::VkKeyScan([char]$c.char) -band 0xff }
      Press $vk @($c.mods)
    }
    'open' { Start-Process $c.target }
  }
  return 'ok'
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try { $r = Handle ($line | ConvertFrom-Json); $reply = @{ ok = $true; result = $r } }
  catch { $reply = @{ ok = $false; error = $_.Exception.Message } }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;

const VK: Record<string, number> = {
  Enter: 0x0d, Tab: 0x09, Space: 0x20, Backspace: 0x08, Escape: 0x1b, Delete: 0x2e, Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28, CapsLock: 0x14, Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Meta: 0x5b,
};
for (let i = 1; i <= 24; i++) VK[`F${i}`] = 0x6f + i;

export class WindowsDesktop implements Driver {
  readonly label = "this PC";
  readonly screenSize: () => Promise<Size>;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private waiting: ((line: string) => void)[] = [];
  private buf = "";

  constructor() {
    this.screenSize = cached(10_000, () => this.call<Size>({ op: "size" }));
  }

  private helper(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const file = path.join(os.tmpdir(), `warren-input-${process.pid}.ps1`);
    // with a BOM, PowerShell reads the script as UTF-8 whatever the system code page is
    fs.writeFileSync(file, "\ufeff" + HELPER);
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    p.stdin.setDefaultEncoding("utf8");
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line.startsWith("{")) this.waiting.shift()?.(line);
      }
    });
    p.on("close", () => {
      for (const w of this.waiting.splice(0)) w(JSON.stringify({ ok: false, error: "the input helper stopped" }));
      this.proc = null;
    });
    this.proc = p;
    return p;
  }

  /** One command at a time; answers come back in order. */
  private call<T>(cmd: object): Promise<T> {
    const next = this.queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const p = this.helper();
          const timer = setTimeout(() => {
            this.waiting = this.waiting.filter((w) => w !== onLine);
            p.kill();
            reject(new ActionError("the input helper didn't answer"));
          }, 30_000);
          const onLine = (line: string) => {
            clearTimeout(timer);
            const r = JSON.parse(line);
            if (r.ok) resolve(r.result as T);
            else reject(new ActionError(r.error));
          };
          this.waiting.push(onLine);
          p.stdin.write(JSON.stringify(cmd) + "\n");
        }),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  async screenshot(box: Size = { width: 1280, height: 800 }): Promise<Shot> {
    const screen = await this.screenSize();
    const fit = fitInto(screen.width, screen.height, box);
    const b64 = await this.call<string>({ op: "shot", ...fit });
    return { jpeg: Buffer.from(b64, "base64"), ...fit };
  }

  async move(x: number, y: number) {
    await this.call({ op: "move", x, y });
  }
  async click(x: number, y: number, button: Button, count: number) {
    await this.call({ op: "click", x, y, button, count });
  }
  async mouse(x: number, y: number, button: Button, down: boolean) {
    await this.call({ op: "mouse", x, y, button, down });
  }
  async drag(x: number, y: number, toX: number, toY: number) {
    await this.call({ op: "drag", x, y, toX, toY });
  }
  async scroll(x: number, y: number, direction: Direction, amount: number) {
    await this.call({ op: "scroll", x, y, direction, amount });
  }
  async type(text: string) {
    await this.call({ op: "type", text });
  }
  async key(c: KeyCombo) {
    const vk = VK[c.key] ?? (/^[a-z0-9]$/i.test(c.key) ? c.key.toUpperCase().charCodeAt(0) : null);
    if (vk === null && c.key.length !== 1) throw new ActionError(`can't press "${c.key}" on Windows`);
    await this.call({ op: "key", vk, char: vk === null ? c.key : null, mods: c.mods });
  }
  async open(target: string) {
    await this.call({ op: "open", target });
  }
}
