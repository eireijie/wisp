import { ShellWorkspace } from "../code/ShellWorkspace.tsx";

/**
 * Code (a mod, on by default): a terminal workspace that works like tmux (see ShellWorkspace).
 * Agents' panes and coding tasks join it later.
 */
export function CodeView() {
  return <ShellWorkspace lead={<h1 className="mr-1.5 text-[14px] font-semibold">Code</h1>} />;
}
