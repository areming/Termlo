function deploymentPrompt(){return '在选中的 Linux 主机检查 Docker Compose、磁盘、内存和 8080 端口；检查通过后，用 Termlo 内置脚本安装并验证独立的用户服务。该流程不调用模型，不更改已有部署。';}
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
function userApiVersion(){return require('../services/user-api/package.json').version;}
function preflightCommand(){
 const target='"$HOME/termlo-user-api-'+userApiVersion()+'"';
 return [
  'set -u',
  'echo "=== Termlo User API · 只读环境检查 ==="',
  'if [ "$(uname -s 2>/dev/null)" != Linux ]; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "需要 Linux 主机"; exit 0; fi',
  'for tool in docker curl unzip ss awk df free grep seq; do if ! command -v "$tool" >/dev/null 2>&1; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "缺少命令：$tool"; exit 0; fi; done',
  'if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "当前 SSH 用户无法使用 Docker Compose，请安装 Docker 并授予该用户 Docker 权限"; exit 0; fi',
  'if [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "当前用户目录不可写"; exit 0; fi',
  'TARGET='+target,
  'if [ -e "$TARGET" ]; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "目标目录已存在，未覆盖：$TARGET"; exit 0; fi',
  'if docker ps --filter label=com.docker.compose.project=termlo-user-api --format "{{.ID}}" | grep -q .; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "检测到同名 Compose 服务，未修改"; exit 0; fi',
  'if ss -ltnH 2>/dev/null | awk \'$4 ~ /:8080$/ {found=1} END {exit found ? 0 : 1}\'; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "8080 端口正在监听，未修改"; exit 0; fi',
  'AVAILABLE_KB=$(df -Pk "$HOME" | awk "NR==2 {print \\$4}")',
  'if [ -z "$AVAILABLE_KB" ] || [ "$AVAILABLE_KB" -lt 1048576 ]; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "用户目录可用磁盘空间不足 1 GB"; exit 0; fi',
  'MEMORY_MB=$(free -m | awk "/^Mem:/ {print \\$2}")',
  'if [ -z "$MEMORY_MB" ] || [ "$MEMORY_MB" -lt 768 ]; then echo "TERMLO_PREFLIGHT=BLOCKED"; echo "内存少于 768 MB"; exit 0; fi',
  'docker --version; docker compose version; df -h "$HOME" | tail -n 1; free -m | head -n 2',
  'echo "TERMLO_PREFLIGHT=READY"'
 ].join('\n');
}
function deploymentCommand(archive){
 const target='"$HOME/termlo-user-api-'+userApiVersion()+'"',zip=quote(archive),compose='docker compose -p termlo-user-api -f "$TARGET/user-api/compose.yaml"';
 return [
  'set -eu',
  'ARCHIVE='+zip,
  'TARGET='+target,
  'test -f "$ARCHIVE"',
  'mkdir "$TARGET"',
  'unzip -q "$ARCHIVE" -d "$TARGET"',
  'test -f "$TARGET/user-api/compose.yaml"',
  'cd "$TARGET/user-api"',
  compose+' up -d --build',
  'READY=0; for i in $(seq 1 60); do if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then READY=1; break; fi; sleep 2; done',
  'if [ "$READY" -ne 1 ]; then echo "服务启动后未通过 /healthz 检查" >&2; '+compose+' ps >&2; exit 1; fi',
  'curl -fsS http://127.0.0.1:8080/openapi.json >/dev/null',
  'curl -fsS http://127.0.0.1:8080/docs/ >/dev/null',
  'echo "TERMLO_DEPLOYMENT=READY"',
  'echo "SERVICE_URL=http://127.0.0.1:8080"',
  'echo "SWAGGER_URL=http://127.0.0.1:8080/docs"',
  'echo "INSTALL_DIR=$TARGET/user-api"',
  'echo "DATA_VOLUME=termlo-user-api_users"'
 ].join('\n');
}
module.exports={deploymentPrompt,preflightCommand,deploymentCommand,userApiVersion};
