import { readdir, readFile, rm, mkdir, cp, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const siteDir = path.join(rootDir, "_site");
const baseUrl = "https://evmnow.github.io/contract-metadata";

await rm(siteDir, { recursive: true, force: true });
await mkdir(path.join(siteDir, "v1", "interfaces"), { recursive: true });
await mkdir(path.join(siteDir, "v1", "extensions"), { recursive: true });

await copyFile(
  path.join(rootDir, "schema", "contract-metadata.schema.json"),
  path.join(siteDir, "v1", "schema.json"),
);
await copyFile(
  path.join(rootDir, "schema", "interface.schema.json"),
  path.join(siteDir, "v1", "interface.schema.json"),
);
await copyJsonFiles(path.join(rootDir, "schema", "interfaces"), path.join(siteDir, "v1", "interfaces"));
await copySchemaFiles(path.join(rootDir, "extensions"), path.join(siteDir, "v1", "extensions"));
await cp(path.join(rootDir, "contracts"), path.join(siteDir, "contracts"), { recursive: true });
await writeFile(path.join(siteDir, ".nojekyll"), "");

const resources = {
  schemas: [
    {
      title: "Contract metadata schema",
      href: "v1/schema.json",
      description: "JSON Schema for deployed contract metadata files.",
      meta: "$schema target for contracts/{chainId}/{address}.json",
    },
    {
      title: "Interface schema",
      href: "v1/interface.schema.json",
      description: "JSON Schema for reusable interface metadata files.",
      meta: "$schema target for schema/interfaces/*.json",
    },
  ],
  interfaces: await loadInterfaces(),
  extensions: await loadExtensions(),
  contracts: await loadContracts(),
};

await writeFile(path.join(siteDir, "index.html"), renderIndex(resources));

const fileCount =
  resources.schemas.length + resources.interfaces.length + resources.extensions.length + resources.contracts.length;
console.log(`Built ${path.relative(rootDir, siteDir)} with ${fileCount} linked resources.`);

async function copyJsonFiles(fromDir, toDir) {
  const entries = await readdir(fromDir, { withFileTypes: true });
  await mkdir(toDir, { recursive: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      await copyFile(path.join(fromDir, entry.name), path.join(toDir, entry.name));
    }
  }
}

async function copySchemaFiles(fromDir, toDir) {
  const entries = await readdir(fromDir, { withFileTypes: true });
  await mkdir(toDir, { recursive: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".schema.json")) {
      await copyFile(path.join(fromDir, entry.name), path.join(toDir, entry.name));
    }
  }
}

async function loadInterfaces() {
  const dir = path.join(rootDir, "schema", "interfaces");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();

  return Promise.all(
    files.map(async (file) => {
      const json = await readJson(path.join(dir, file));
      const slug = path.basename(file, ".json");
      const groupLabel = Object.values(json.groups ?? {})[0]?.label;
      const actionCount = Object.keys(json.actions ?? {}).length;
      const title = titleFromSlug(slug);

      return {
        title,
        href: `v1/interfaces/${file}`,
        description: `${actionCount} action${actionCount === 1 ? "" : "s"}`,
        meta: [json.interfaceId ? `interfaceId ${json.interfaceId}` : slug, groupLabel && groupLabel !== title ? groupLabel : ""]
          .filter(Boolean)
          .join(" / "),
      };
    }),
  );
}

async function loadExtensions() {
  const dir = path.join(rootDir, "extensions");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".schema.json")).sort();

  return Promise.all(
    files.map(async (file) => {
      const json = await readJson(path.join(dir, file));
      return {
        title: json.title ?? titleFromSlug(file.replace(/\.schema\.json$/, "")),
        href: `v1/extensions/${file}`,
        description: json.description ?? "Extension schema",
        meta: file.replace(/\.schema\.json$/, ""),
      };
    }),
  );
}

async function loadContracts() {
  const dir = path.join(rootDir, "contracts");
  const files = await walkJson(dir);
  const contracts = await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(dir, file);
      const json = await readJson(absolutePath);
      const chainId = String(json.chainId ?? file.split(path.sep)[0]);
      const address = String(json.address ?? path.basename(file, ".json"));
      const label = [json.name, json.symbol ? `(${json.symbol})` : ""].filter(Boolean).join(" ");

      return {
        title: label || address,
        href: `contracts/${toPosix(file)}`,
        description: json.description ?? "Contract metadata",
        meta: `${chainName(chainId)} / ${address}`,
        chainId,
        address,
      };
    }),
  );

  return contracts.sort((a, b) => a.chainId.localeCompare(b.chainId, undefined, { numeric: true }) || a.title.localeCompare(b.title));
}

async function walkJson(dir, prefix = "") {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJson(dir, relativePath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function renderIndex(resources) {
  const counts = [
    ["Schemas", resources.schemas.length],
    ["Interfaces", resources.interfaces.length],
    ["Extensions", resources.extensions.length],
    ["Contracts", resources.contracts.length],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contract Metadata</title>
  <meta name="description" content="Canonical schemas and contract metadata files published by EVM.NOW.">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f5;
      --surface: #ffffff;
      --surface-alt: #eef3ed;
      --ink: #17201b;
      --muted: #59645e;
      --line: #d9e0d9;
      --accent: #0f7a5f;
      --accent-strong: #0a4f40;
      --gold: #b87a12;
      --code: #13231f;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }

    a {
      color: var(--accent-strong);
      text-decoration-thickness: 0.08em;
      text-underline-offset: 0.18em;
    }

    header {
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(135deg, rgba(15, 122, 95, 0.12), rgba(184, 122, 18, 0.12)),
        var(--surface);
    }

    .wrap {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 32px;
      align-items: end;
      padding: 44px 0 34px;
    }

    h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 4rem);
      line-height: 1;
      letter-spacing: 0;
    }

    .lede {
      max-width: 760px;
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 1.06rem;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 24px;
    }

    .button {
      display: inline-flex;
      align-items: center;
      min-height: 40px;
      padding: 9px 13px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      color: var(--ink);
      font-weight: 650;
      text-decoration: none;
    }

    .button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #ffffff;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(104px, 1fr));
      gap: 10px;
      min-width: 240px;
    }

    .stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.76);
      padding: 12px;
    }

    .stat strong {
      display: block;
      font-size: 1.5rem;
      line-height: 1;
    }

    .stat span {
      color: var(--muted);
      font-size: 0.86rem;
    }

    main {
      padding: 28px 0 56px;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      margin-bottom: 22px;
    }

    .search {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      color: var(--ink);
      padding: 10px 12px;
      font: inherit;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .pattern {
      margin: 0;
      border-radius: 8px;
      background: var(--code);
      color: #e9fff7;
      padding: 10px 12px;
      overflow-x: auto;
      font: 0.88rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap;
    }

    section {
      margin-top: 26px;
    }

    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: baseline;
      margin-bottom: 10px;
    }

    h2 {
      margin: 0;
      font-size: 1.08rem;
      letter-spacing: 0;
    }

    .count {
      color: var(--muted);
      font-size: 0.9rem;
    }

    .list {
      display: grid;
      gap: 8px;
    }

    .resource {
      display: grid;
      grid-template-columns: minmax(180px, 0.9fr) minmax(0, 1.3fr) minmax(200px, 1fr);
      gap: 14px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      padding: 13px 14px;
    }

    .resource:hover {
      border-color: rgba(15, 122, 95, 0.48);
    }

    .resource-title {
      font-weight: 720;
      overflow-wrap: anywhere;
    }

    .resource-desc {
      color: var(--muted);
      margin: 0;
    }

    .resource-meta {
      color: var(--muted);
      font: 0.82rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }

    .empty {
      display: none;
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 18px;
      color: var(--muted);
      background: var(--surface-alt);
    }

    footer {
      border-top: 1px solid var(--line);
      color: var(--muted);
      padding: 20px 0;
      font-size: 0.92rem;
    }

    @media (max-width: 820px) {
      .hero,
      .toolbar {
        grid-template-columns: 1fr;
      }

      .stats {
        min-width: 0;
      }

      .resource {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap hero">
      <div>
        <h1>Contract Metadata</h1>
        <p class="lede">Canonical JSON schemas and human-readable metadata for smart contracts, published as stable static endpoints.</p>
        <div class="actions">
          <a class="button primary" href="v1/schema.json">Contract Schema</a>
          <a class="button" href="v1/interface.schema.json">Interface Schema</a>
          <a class="button" href="https://github.com/evmnow/contract-metadata">GitHub</a>
        </div>
      </div>
      <div class="stats" aria-label="Published resource counts">
        ${counts.map(([label, count]) => `<div class="stat"><strong>${count}</strong><span>${escapeHtml(label)}</span></div>`).join("\n        ")}
      </div>
    </div>
  </header>

  <main class="wrap">
    <div class="toolbar">
      <label>
        <span class="sr-only">Search resources</span>
        <input class="search" type="search" placeholder="Search resources" data-filter>
      </label>
      <pre class="pattern">${baseUrl}/contracts/{chainId}/{address}.json</pre>
    </div>

    ${renderSection("Schemas", resources.schemas)}
    ${renderSection("Interfaces", resources.interfaces)}
    ${renderSection("Extensions", resources.extensions)}
    ${renderSection("Contracts", resources.contracts)}

    <p class="empty" data-empty>No matching resources.</p>
  </main>

  <footer>
    <div class="wrap">Published from <a href="https://github.com/evmnow/contract-metadata">evmnow/contract-metadata</a>.</div>
  </footer>

  <script>
    const input = document.querySelector("[data-filter]");
    const resources = Array.from(document.querySelectorAll("[data-resource]"));
    const empty = document.querySelector("[data-empty]");

    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      let visible = 0;

      for (const item of resources) {
        const match = item.dataset.search.includes(query);
        item.hidden = !match;
        if (match) visible += 1;
      }

      for (const section of document.querySelectorAll("[data-section]")) {
        const hasVisibleItem = Array.from(section.querySelectorAll("[data-resource]")).some((item) => !item.hidden);
        section.hidden = !hasVisibleItem;
      }

      empty.style.display = visible === 0 ? "block" : "none";
    });
  </script>
</body>
</html>
`;
}

function renderSection(title, items) {
  return `<section data-section>
      <div class="section-head">
        <h2>${escapeHtml(title)}</h2>
        <span class="count">${items.length} resource${items.length === 1 ? "" : "s"}</span>
      </div>
      <div class="list">
        ${items.map(renderResource).join("\n        ")}
      </div>
    </section>`;
}

function renderResource(item) {
  const search = [item.title, item.description, item.meta, item.href].join(" ").toLowerCase();

  return `<article class="resource" data-resource data-search="${escapeHtml(search)}">
          <a class="resource-title" href="${escapeAttribute(item.href)}">${escapeHtml(item.title)}</a>
          <p class="resource-desc">${escapeHtml(item.description)}</p>
          <span class="resource-meta">${escapeHtml(item.meta)}</span>
        </article>`;
}

function titleFromSlug(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      const ercMatch = part.match(/^erc(\d+)$/i);
      if (ercMatch) return `ERC-${ercMatch[1]}`;
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function chainName(chainId) {
  if (chainId === "1") return "Ethereum mainnet";
  return `Chain ${chainId}`;
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
