import { spawnSync } from "node:child_process";
import process from "node:process";

const wrangler = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(npm, ["run", "build"]);
run(wrangler, ["d1", "migrations", "apply", "CFORUM_DB", "--remote"]);
run(wrangler, ["deploy"]);
