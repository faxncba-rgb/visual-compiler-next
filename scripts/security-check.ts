import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((file) => !file.endsWith("package-lock.json"));
const probableSecrets = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[opusr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const assignmentPattern =
  /(?:OPENAI_API_KEY|GITHUB_TOKEN|API_TOKEN|PASSWORD|CLIENT_SECRET)[ \t]*[:=][ \t]*["']?([^"'\s#]{8,})/gi;
const placeholderPrefixes = [
  "$",
  "<",
  "your-",
  "changeme",
  "example",
  "placeholder",
];
const violations: string[] = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  const assignmentValues = [...content.matchAll(assignmentPattern)].map(
    (match) => match[1].toLowerCase(),
  );
  const hasAssignedSecret = assignmentValues.some(
    (value) => !placeholderPrefixes.some((prefix) => value.startsWith(prefix)),
  );
  if (
    probableSecrets.some((pattern) => pattern.test(content)) ||
    hasAssignedSecret
  )
    violations.push(`${file}: probable secret`);
}
const runtimeSource = readFileSync("packages/runtime/src/index.ts", "utf8");
const runtimePackage = JSON.parse(
  readFileSync("packages/runtime/package.json", "utf8"),
);
if (/from ["']openai["']|require\(["']openai["']\)/.test(runtimeSource))
  violations.push("runtime imports OpenAI");
if (
  runtimePackage.dependencies?.openai ||
  runtimePackage.devDependencies?.openai
)
  violations.push("runtime depends on OpenAI");
const forbiddenTracked = files.filter(
  (file) =>
    /(^|\/)(\.env|cookies?|storage-state|playwright\/.auth)(\.|\/|$)/i.test(
      file,
    ) && !file.endsWith(".example"),
);
violations.push(
  ...forbiddenTracked.map(
    (file) => `${file}: forbidden session or environment file`,
  ),
);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(`Security checks passed for ${files.length} repository files.`);
