/** The parts of noVNC's RFB client Warren uses (https://github.com/novnc/noVNC/blob/master/docs/API.md). */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string | WebSocket, options?: { wsProtocols?: string[]; shared?: boolean; credentials?: { username?: string; password?: string; target?: string } });
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
  }
}
