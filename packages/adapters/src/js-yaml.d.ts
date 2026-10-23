// js-yaml ships no types of its own; Warren only reads YAML with it
declare module "js-yaml" {
  export function load(text: string, opts?: { filename?: string; json?: boolean }): unknown;
  const yaml: { load: typeof load };
  export default yaml;
}
