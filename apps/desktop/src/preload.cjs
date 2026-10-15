// What the desktop app adds to pages: the web app can set the Dock badge and connect this
// computer as a device; the app's own setup page gets its setup calls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("warrenDesktop", {
  setBadge: (n) => ipcRenderer.send("badge", n),
  info: () => ipcRenderer.invoke("desktop:info"),
  connectDevice: () => ipcRenderer.invoke("desktop:connect-device"),
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
