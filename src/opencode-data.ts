import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve OpenCode's data home (`XDG_DATA_HOME` or `~/.local/share`). */
export function dataHome(): string {
  return (
    process.env.XDG_DATA_HOME ||
    join(process.env.HOME || homedir(), ".local", "share")
  );
}

export function opencodeDataPath(fileName: string): string {
  return join(dataHome(), "opencode", fileName);
}
