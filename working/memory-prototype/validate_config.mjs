import { readFileSync } from "node:fs";
import { schemaMap } from "./config_schemas.mjs";

const [, , kind, filePath] = process.argv;

if (!kind || !filePath || !(kind in schemaMap)) {
  console.error("Usage: node validate_config.mjs <migration|recall|write> <file>");
  process.exit(2);
}

try {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  schemaMap[kind].parse(raw);
  process.stdout.write(JSON.stringify({ ok: true, kind, filePath }));
} catch (error) {
  const payload = {
    ok: false,
    kind,
    filePath,
    error: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(JSON.stringify(payload));
  process.exit(1);
}
