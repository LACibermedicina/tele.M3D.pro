#!/bin/bash
# Script para enviar todos os arquivos para o GitHub
# Uso: bash scripts/push-to-github.sh

set -e

echo "=== Enviando arquivos para GitHub ==="
echo ""

# Get GitHub token from Replit connector
TOKEN=$(node -e "
async function main() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;
  if (!xReplitToken) { console.error('Token not found'); process.exit(1); }
  const res = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=github',
    { headers: { 'Accept': 'application/json', 'X_REPLIT_TOKEN': xReplitToken } }
  ).then(r => r.json()).then(d => d.items?.[0]);
  const token = res?.settings?.access_token || res?.settings?.oauth?.credentials?.access_token;
  if (!token) { console.error('GitHub not connected'); process.exit(1); }
  process.stdout.write(token);
}
main();
" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Erro: Não foi possível obter o token do GitHub"
  exit 1
fi

REPO_URL="https://x-access-token:${TOKEN}@github.com/LACibermedicina/tele.M3D.pro.git"

git add -A
git commit -m "Atualização completa do sistema Tele<M3D> - $(date '+%Y-%m-%d %H:%M')" || echo "Nenhuma alteração para commitar"
git push "$REPO_URL" main --force

echo ""
echo "=== Arquivos enviados com sucesso para GitHub ==="
echo "Repositório: https://github.com/LACibermedicina/tele.M3D.pro"
