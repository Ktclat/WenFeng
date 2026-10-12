import { build } from "vite";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectPath = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({ configFile: projectPath("../vite.pages.config.ts") });
// Publish the already built site exactly as produced, without Jekyll processing.
await writeFile(projectPath("../dist-pages/.nojekyll"), "");
await copyFile(projectPath("../LICENSE"), projectPath("../dist-pages/LICENSE"));

// Minification can remove package license comments. Ship the complete notices
// with the built application, including Lucide's upstream Feather notice.
const require = createRequire(import.meta.url);
const reactDomRequire = createRequire(require.resolve("react-dom/package.json"));
const packages = ["react", "react-dom", "scheduler", "zod", "lucide-react", "tailwindcss", "vite"];
const notices = await Promise.all(packages.map(async (name) => {
  const resolver = name === "scheduler" ? reactDomRequire : require;
  const packagePath = resolver.resolve(`${name}/package.json`);
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  const licenseName = name === "vite" ? "LICENSE.md" : "LICENSE";
  const license = await readFile(join(dirname(packagePath), licenseName), "utf8");
  return `${name} ${metadata.version}\n${"=".repeat(60)}\n${license.trim()}\n`;
}));
await writeFile(projectPath("../dist-pages/THIRD_PARTY_NOTICES.txt"),
  `Third-party software distributed with WenFeng\n\n${notices.join("\n\n")}`, "utf8");
