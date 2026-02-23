#!/bin/bash
#
# ============================================================
#  Tele<M3D> - Instalador Automático do Sistema de Telemedicina
# ============================================================
#
#  Este script instala e configura todo o sistema Tele<M3D>
#  em um servidor novo (Ubuntu/Debian).
#
#  Uso:
#    chmod +x install.sh
#    sudo ./install.sh
#
#  Após a instalação, o sistema estará disponível na porta 5000.
#
# ============================================================

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[AVISO]${NC} $1"; }
log_error() { echo -e "${RED}[ERRO]${NC} $1"; }

# Verificar se está rodando como root
if [ "$EUID" -ne 0 ]; then
  log_error "Execute este script como root (sudo ./install.sh)"
  exit 1
fi

echo ""
echo "============================================================"
echo "  Tele<M3D> - Sistema de Telemedicina"
echo "  Instalador Automático v1.0"
echo "============================================================"
echo ""

# ============================================================
# 1. VARIÁVEIS DE CONFIGURAÇÃO
# ============================================================

APP_DIR="/opt/telemedicina"
APP_USER="telemedicina"
DB_NAME="telemedicina_db"
DB_USER="telemedicina_user"
DB_PASS=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 24)
SESSION_SECRET=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 48)
GITHUB_REPO="https://github.com/LACibermedicina/tele.M3D.pro.git"
NODE_VERSION="20"

# Arquivo de configuração gerado
ENV_FILE="$APP_DIR/.env"

# ============================================================
# 2. COLETAR CONFIGURAÇÕES DO USUÁRIO
# ============================================================

echo ""
log_info "Configuração das chaves de API (pressione Enter para pular):"
echo ""

read -p "  Google/Gemini API Key: " GEMINI_KEY
read -p "  Agora App ID (vídeo chamadas): " AGORA_ID
read -p "  Agora App Certificate: " AGORA_CERT
read -p "  PayPal Client ID: " PAYPAL_ID
read -p "  PayPal Client Secret: " PAYPAL_SECRET
read -p "  Domínio do servidor (ex: telemedicina.com.br): " SERVER_DOMAIN
read -p "  Porta da aplicação [5000]: " APP_PORT
APP_PORT=${APP_PORT:-5000}

echo ""
log_info "Iniciando instalação..."
echo ""

# ============================================================
# 3. ATUALIZAR SISTEMA E INSTALAR DEPENDÊNCIAS
# ============================================================

log_info "Atualizando sistema operacional..."
apt-get update -qq
apt-get upgrade -y -qq
log_ok "Sistema atualizado"

log_info "Instalando dependências do sistema..."
apt-get install -y -qq \
  curl \
  wget \
  git \
  build-essential \
  nginx \
  certbot \
  python3-certbot-nginx \
  ufw \
  fail2ban \
  htop \
  unzip \
  > /dev/null 2>&1
log_ok "Dependências instaladas"

# ============================================================
# 4. INSTALAR NODE.JS
# ============================================================

log_info "Instalando Node.js v${NODE_VERSION}..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt $NODE_VERSION ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
fi
log_ok "Node.js $(node -v) instalado"

# ============================================================
# 5. INSTALAR POSTGRESQL
# ============================================================

log_info "Instalando PostgreSQL..."
if ! command -v psql &> /dev/null; then
  apt-get install -y -qq postgresql postgresql-contrib > /dev/null 2>&1
fi
systemctl enable postgresql
systemctl start postgresql
log_ok "PostgreSQL instalado e iniciado"

log_info "Configurando banco de dados..."
sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" 2>/dev/null || \
  sudo -u postgres psql -c "ALTER USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" 2>/dev/null
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || \
  log_warn "Banco de dados já existe"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" 2>/dev/null
log_ok "Banco de dados '${DB_NAME}' configurado"

# ============================================================
# 6. CRIAR USUÁRIO DO SISTEMA
# ============================================================

log_info "Criando usuário do sistema..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
fi
log_ok "Usuário '${APP_USER}' criado"

# ============================================================
# 7. CLONAR REPOSITÓRIO
# ============================================================

log_info "Clonando repositório do GitHub..."
if [ -d "$APP_DIR" ]; then
  log_warn "Diretório $APP_DIR já existe. Atualizando..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" git pull origin main 2>/dev/null || true
else
  git clone "$GITHUB_REPO" "$APP_DIR"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
fi
cd "$APP_DIR"
log_ok "Repositório clonado em ${APP_DIR}"

# ============================================================
# 8. CRIAR ARQUIVO DE CONFIGURAÇÃO (.env)
# ============================================================

log_info "Gerando arquivo de configuração..."
cat > "$ENV_FILE" << EOF
# ============================================================
# Tele<M3D> - Configuração do Sistema
# Gerado automaticamente em $(date '+%Y-%m-%d %H:%M:%S')
# ============================================================

# Servidor
NODE_ENV=production
PORT=${APP_PORT}

# Banco de Dados
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
PGHOST=localhost
PGPORT=5432
PGUSER=${DB_USER}
PGPASSWORD=${DB_PASS}
PGDATABASE=${DB_NAME}

# Sessão
SESSION_SECRET=${SESSION_SECRET}

# Google Gemini AI
GEMINI_API_KEY=${GEMINI_KEY}
GOOGLE_API_KEY=${GEMINI_KEY}

# Agora.io (Vídeo Chamadas)
AGORA_APP_ID=${AGORA_ID}
AGORA_APP_CERTIFICATE=${AGORA_CERT}

# PayPal
PAYPAL_CLIENT_ID=${PAYPAL_ID}
PAYPAL_CLIENT_SECRET=${PAYPAL_SECRET}

# Domínio
SERVER_DOMAIN=${SERVER_DOMAIN}
EOF

chown "$APP_USER":"$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
log_ok "Arquivo .env criado"

# ============================================================
# 9. INSTALAR DEPENDÊNCIAS DO PROJETO
# ============================================================

log_info "Instalando dependências do projeto (pode demorar alguns minutos)..."
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --production=false 2>&1 | tail -3
log_ok "Dependências instaladas"

# ============================================================
# 10. COMPILAR O PROJETO
# ============================================================

log_info "Compilando o projeto..."
sudo -u "$APP_USER" bash -c "cd $APP_DIR && set -a && source .env && set +a && npm run build" 2>&1 | tail -5
log_ok "Projeto compilado"

# ============================================================
# 11. APLICAR SCHEMA DO BANCO DE DADOS
# ============================================================

log_info "Aplicando schema do banco de dados..."
sudo -u "$APP_USER" bash -c "cd $APP_DIR && set -a && source .env && set +a && npx drizzle-kit push --force" 2>&1 | tail -5
log_ok "Schema do banco aplicado"

# ============================================================
# 12. CONFIGURAR SERVIÇO SYSTEMD
# ============================================================

log_info "Configurando serviço do sistema..."
cat > /etc/systemd/system/telemedicina.service << EOF
[Unit]
Description=Tele<M3D> - Sistema de Telemedicina
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telemedicina

# Limites de segurança
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${APP_DIR}
ProtectHome=true

# Limites de recursos
LimitNOFILE=65536
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable telemedicina
log_ok "Serviço systemd configurado"

# ============================================================
# 13. CONFIGURAR NGINX (PROXY REVERSO)
# ============================================================

log_info "Configurando Nginx..."
NGINX_DOMAIN="${SERVER_DOMAIN:-localhost}"

cat > /etc/nginx/sites-available/telemedicina << EOF
server {
    listen 80;
    server_name ${NGINX_DOMAIN};

    # Limites de segurança
    client_max_body_size 50M;

    # Headers de segurança
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Proxy para a aplicação
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/telemedicina /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null
nginx -t > /dev/null 2>&1
systemctl restart nginx
log_ok "Nginx configurado"

# ============================================================
# 14. CONFIGURAR FIREWALL
# ============================================================

log_info "Configurando firewall..."
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow ssh > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
log_ok "Firewall configurado (SSH, HTTP, HTTPS)"

# ============================================================
# 15. CONFIGURAR FAIL2BAN
# ============================================================

log_info "Configurando Fail2Ban..."
cat > /etc/fail2ban/jail.local << EOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log

[nginx-http-auth]
enabled = true
port = http,https
filter = nginx-http-auth
logpath = /var/log/nginx/error.log
EOF

systemctl restart fail2ban
log_ok "Fail2Ban configurado"

# ============================================================
# 16. CONFIGURAR SSL (se domínio fornecido)
# ============================================================

if [ -n "$SERVER_DOMAIN" ] && [ "$SERVER_DOMAIN" != "localhost" ]; then
  log_info "Configurando certificado SSL para ${SERVER_DOMAIN}..."
  certbot --nginx -d "$SERVER_DOMAIN" --non-interactive --agree-tos --email "admin@${SERVER_DOMAIN}" 2>/dev/null || \
    log_warn "Não foi possível configurar SSL automaticamente. Execute: sudo certbot --nginx -d ${SERVER_DOMAIN}"
else
  log_warn "Nenhum domínio configurado. SSL não será ativado automaticamente."
fi

# ============================================================
# 17. CRIAR SCRIPTS DE MANUTENÇÃO
# ============================================================

log_info "Criando scripts de manutenção..."

# Script de atualização
cat > "$APP_DIR/scripts/update.sh" << 'UPDATEEOF'
#!/bin/bash
set -e
echo "=== Atualizando Tele<M3D> ==="
cd /opt/telemedicina
sudo -u telemedicina git pull origin main
sudo -u telemedicina npm install --production=false
sudo -u telemedicina bash -c "set -a && source .env && set +a && npm run build"
sudo -u telemedicina bash -c "set -a && source .env && set +a && npx drizzle-kit push --force"
systemctl restart telemedicina
echo "=== Atualização concluída ==="
systemctl status telemedicina --no-pager
UPDATEEOF

# Script de backup
cat > "$APP_DIR/scripts/backup.sh" << 'BACKUPEOF'
#!/bin/bash
set -e
BACKUP_DIR="/opt/telemedicina/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "=== Backup do Tele<M3D> ==="

# Backup do banco de dados
source /opt/telemedicina/.env
pg_dump "$DATABASE_URL" > "$BACKUP_DIR/db_${TIMESTAMP}.sql"
echo "Banco de dados salvo em: $BACKUP_DIR/db_${TIMESTAMP}.sql"

# Backup dos uploads
if [ -d "/opt/telemedicina/uploads" ]; then
  tar -czf "$BACKUP_DIR/uploads_${TIMESTAMP}.tar.gz" -C /opt/telemedicina uploads
  echo "Uploads salvos em: $BACKUP_DIR/uploads_${TIMESTAMP}.tar.gz"
fi

# Limpar backups antigos (manter últimos 30 dias)
find "$BACKUP_DIR" -name "*.sql" -mtime +30 -delete
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete

echo "=== Backup concluído ==="
BACKUPEOF

# Script de status
cat > "$APP_DIR/scripts/status.sh" << 'STATUSEOF'
#!/bin/bash
echo "============================================================"
echo "  Tele<M3D> - Status do Sistema"
echo "============================================================"
echo ""
echo "--- Serviço da Aplicação ---"
systemctl status telemedicina --no-pager -l | head -15
echo ""
echo "--- PostgreSQL ---"
systemctl status postgresql --no-pager -l | head -5
echo ""
echo "--- Nginx ---"
systemctl status nginx --no-pager -l | head -5
echo ""
echo "--- Uso de Disco ---"
df -h / | tail -1
echo ""
echo "--- Uso de Memória ---"
free -h | head -2
echo ""
echo "--- Logs Recentes ---"
journalctl -u telemedicina --no-pager -n 10
echo ""
echo "============================================================"
STATUSEOF

chmod +x "$APP_DIR/scripts/update.sh"
chmod +x "$APP_DIR/scripts/backup.sh"
chmod +x "$APP_DIR/scripts/status.sh"
log_ok "Scripts de manutenção criados"

# ============================================================
# 18. CONFIGURAR BACKUP AUTOMÁTICO (CRON)
# ============================================================

log_info "Configurando backup automático..."
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/telemedicina/scripts/backup.sh > /dev/null 2>&1") | crontab -
log_ok "Backup automático configurado (diário às 3h)"

# ============================================================
# 19. INICIAR A APLICAÇÃO
# ============================================================

log_info "Iniciando a aplicação..."
systemctl start telemedicina
sleep 3

if systemctl is-active --quiet telemedicina; then
  log_ok "Aplicação iniciada com sucesso!"
else
  log_error "Falha ao iniciar a aplicação. Verifique os logs:"
  log_error "  sudo journalctl -u telemedicina -n 50"
fi

# ============================================================
# 20. RESUMO DA INSTALAÇÃO
# ============================================================

echo ""
echo "============================================================"
echo -e "  ${GREEN}Instalação concluída com sucesso!${NC}"
echo "============================================================"
echo ""
echo "  Informações do Sistema:"
echo "  ─────────────────────────────────────────────────"
echo "  Aplicação:       http://${NGINX_DOMAIN}:${APP_PORT}"
if [ -n "$SERVER_DOMAIN" ] && [ "$SERVER_DOMAIN" != "localhost" ]; then
echo "  URL Pública:     https://${SERVER_DOMAIN}"
fi
echo "  Diretório:       ${APP_DIR}"
echo "  Usuário:         ${APP_USER}"
echo ""
echo "  Banco de Dados:"
echo "  ─────────────────────────────────────────────────"
echo "  Host:            localhost"
echo "  Porta:           5432"
echo "  Banco:           ${DB_NAME}"
echo "  Usuário:         ${DB_USER}"
echo "  Senha:           ${DB_PASS}"
echo ""
echo "  Comandos Úteis:"
echo "  ─────────────────────────────────────────────────"
echo "  Status:          sudo bash ${APP_DIR}/scripts/status.sh"
echo "  Atualizar:       sudo bash ${APP_DIR}/scripts/update.sh"
echo "  Backup:          sudo bash ${APP_DIR}/scripts/backup.sh"
echo "  Logs:            sudo journalctl -u telemedicina -f"
echo "  Reiniciar:       sudo systemctl restart telemedicina"
echo "  Parar:           sudo systemctl stop telemedicina"
echo ""
echo "  Arquivo .env:    ${ENV_FILE}"
echo "  (Edite para adicionar/alterar chaves de API)"
echo ""
echo "  IMPORTANTE: Guarde a senha do banco de dados!"
echo "  Senha: ${DB_PASS}"
echo ""
echo "============================================================"
