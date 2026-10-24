import { configDefaults, defineConfig } from "vitest/config";

// Other sessions' worktrees live under .claude/worktrees; running the suite from the repo root
// must not pick up their copies of every test.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
