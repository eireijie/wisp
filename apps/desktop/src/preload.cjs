// What the desktop app adds to pages: the web app can set the Dock badge and connect this
// computer as a device; the app's own setup page gets its setup calls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("warrenDesktop", {
  setBadge: (n) => ipcRenderer.send("badge", n),
  info: () => ipcRenderer.invoke("desktop:info"),
  connectDevice: () => ipcRenderer.invoke("desktop:connect-device"),
  buddy: {
    agents: (agents, leadId) => ipcRenderer.send("buddy:agents", agents, leadId),
    settings: () => ipcRenderer.invoke("buddy:settings"),
    onSettings: (fn) => {
      const listener = (_event, settings) => fn(settings);
      ipcRenderer.on("buddy:settings", listener);
      return () => ipcRenderer.removeListener("buddy:settings", listener);
    },
    onPointer: (fn) => {
      const listener = (_event, point) => fn(point);
      ipcRenderer.on("buddy:pointer", listener);
      return () => ipcRenderer.removeListener("buddy:pointer", listener);
    },
    ignoreMouse: (ignore) => ipcRenderer.send("buddy:ignore", ignore),
    expand: (expanded) => ipcRenderer.send("buddy:expand", expanded),
    drag: (phase) => ipcRenderer.send("buddy:drag", phase),
    open: (route) => ipcRenderer.send("buddy:open", route),
  },
});

if (location.protocol === "file:")
  contextBridge.exposeInMainWorld("warrenSetup", {
    check: () => ipcRenderer.invoke("setup:check"),
    chooseFolder: () => ipcRenderer.invoke("setup:choose-folder"),
    local: () => ipcRenderer.invoke("setup:local"),
    remote: (url) => ipcRenderer.invoke("setup:remote", url),
    retry: () => ipcRenderer.invoke("setup:retry"),
    install: () => ipcRenderer.invoke("setup:install"),
  });
