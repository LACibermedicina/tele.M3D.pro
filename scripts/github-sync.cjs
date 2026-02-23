const { Octokit } = require("@octokit/rest");
const fs = require("fs");
const path = require("path");

const OWNER = "LACibermedicina";
const REPO = "tele.M3D.pro";
const BRANCH = "main";
const ROOT = "/home/runner/workspace";

const IGNORE = new Set([
  "node_modules", ".git", "dist", ".DS_Store", ".cache",
  ".config", ".local", "generated-icon.png", ".replit",
  "replit.nix", ".upm", ".breakpoints", ".db-config"
]);

const IGNORE_EXTENSIONS = new Set([".tar.gz"]);

async function getAccessToken() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;
  if (!xReplitToken) throw new Error("X_REPLIT_TOKEN not found");
  const res = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=github",
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } }
  ).then((r) => r.json()).then((d) => d.items?.[0]);
  return res?.settings?.access_token || res?.settings?.oauth?.credentials?.access_token;
}

function getAllFiles(dir, base = "") {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (IGNORE.has(name)) continue;
    if (IGNORE_EXTENSIONS.has(path.extname(name))) continue;
    const fullPath = path.join(dir, name);
    const relPath = base ? base + "/" + name : name;
    if (entry.isDirectory()) {
      results.push(...getAllFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

function isBinary(filePath) {
  try {
    const buf = Buffer.alloc(512);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== Enviando arquivos para GitHub ===\n");

  const token = await getAccessToken();
  if (!token) { console.error("Erro: GitHub não conectado"); process.exit(1); }

  const octokit = new Octokit({ auth: token });

  const files = getAllFiles(ROOT);
  console.log(`Encontrados ${files.length} arquivos para enviar\n`);

  console.log("Criando blobs...");
  const treeItems = [];
  let count = 0;

  const BATCH_SIZE = 10;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const binary = isBinary(file.fullPath);
          const content = fs.readFileSync(file.fullPath, binary ? null : "utf-8");
          const encoding = binary ? "base64" : "utf-8";
          const blobContent = binary ? content.toString("base64") : content;

          const { data } = await octokit.git.createBlob({
            owner: OWNER,
            repo: REPO,
            content: blobContent,
            encoding,
          });
          return {
            path: file.relPath,
            mode: "100644",
            type: "blob",
            sha: data.sha,
          };
        } catch (e) {
          console.error(`  Erro em ${file.relPath}: ${e.message}`);
          return null;
        }
      })
    );
    treeItems.push(...results.filter(Boolean));
    count += batch.length;
    process.stdout.write(`  ${count}/${files.length} arquivos processados\r`);
  }

  console.log(`\n\nCriando tree com ${treeItems.length} arquivos...`);
  const { data: tree } = await octokit.git.createTree({
    owner: OWNER,
    repo: REPO,
    tree: treeItems,
  });

  let parentSha;
  try {
    const { data: ref } = await octokit.git.getRef({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${BRANCH}`,
    });
    parentSha = ref.object.sha;
  } catch {}

  console.log("Criando commit...");
  const commitParams = {
    owner: OWNER,
    repo: REPO,
    message: `Atualização completa do sistema Tele<M3D> - ${new Date().toISOString().split("T")[0]}`,
    tree: tree.sha,
  };
  if (parentSha) commitParams.parents = [parentSha];

  const { data: commit } = await octokit.git.createCommit(commitParams);

  console.log("Atualizando branch main...");
  try {
    await octokit.git.updateRef({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${BRANCH}`,
      sha: commit.sha,
      force: true,
    });
  } catch {
    await octokit.git.createRef({
      owner: OWNER,
      repo: REPO,
      ref: `refs/heads/${BRANCH}`,
      sha: commit.sha,
    });
  }

  console.log("\n=== Arquivos enviados com sucesso! ===");
  console.log(`Repositório: https://github.com/${OWNER}/${REPO}`);
  console.log(`Commit: ${commit.sha.substring(0, 7)}`);
}

main().catch((e) => {
  console.error("Erro:", e.message);
  process.exit(1);
});
