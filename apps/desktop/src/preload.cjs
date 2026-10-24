// What the desktop app adds to pages: the web app can set the Dock badge and connect this
// computer as a device; the app's own setup page gets its setup calls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("warrenDesktop", {
  setBadge: (n) => ipcRenderer.send("badge", n),
  info: () => ipcRenderer.invoke("desktop:info"),
  connectDevice: (claim) => ipcRenderer.invoke("desktop:connect-device", claim),
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
    create: (opts) => ipcRenderer.invoke("setup:create", opts),
    discover: () => ipcRenderer.invoke("setup:discover"),
    requestJoin: (input) => ipcRenderer.invoke("setup:request-join", input),
    pollJoin: () => ipcRenderer.invoke("setup:poll-join"),
    cancelJoin: () => ipcRenderer.invoke("setup:cancel-join"),
    retry: () => ipcRenderer.invoke("setup:retry"),
    cloudPlans: (token) => ipcRenderer.invoke("setup:cloud-plans", token),
    cloudCreate: (token, choice) => ipcRenderer.invoke("setup:cloud-create", token, choice),
    cloudKeep: () => ipcRenderer.invoke("setup:cloud-keep"),
    cloudDelete: (token, id) => ipcRenderer.invoke("setup:cloud-delete", token, id),
    onCloudStep: (fn) => ipcRenderer.on("setup:cloud-step", (_event, step) => fn(step)),
  });

if (location.protocol === "file:")
  contextBridge.exposeInMainWorld("warrenScreenCode", {
    save: (input) => ipcRenderer.invoke("screen-code:save", input),
  });
