# 火山引擎云上资源自动化（Terraform + OpenAPI CLI）

自动化分两层：**Terraform 管理基础设施**（网络/数据库/OpenD 主机），**OpenAPI CLI 管理 veFaaS 函数**（容器镜像型函数，官方 TF 资源字段不全，用 veFaaS CreateFunction OpenAPI 更可靠）。

## 资源与工具对应

| 资源 | 管理方式 | 文件/命令 |
|---|---|---|
| VPC / 子网 / 安全组 | Terraform | `network.tf` |
| RDS PostgreSQL（库/账号/白名单） | Terraform | `database.tf`（用已有 AIDAP 时 `rds_create=false`） |
| Windows OpenD ECS | Terraform | `opend_ecs.tf`（镜像 ID 需在控制台查 Windows Server 2022 公共镜像填入） |
| CR 镜像仓库与镜像推送 | Shell + docker | `deploy/volcano/scripts/build-and-push-image.sh` |
| veFaaS Web/Worker 函数 | OpenAPI CLI | `deploy/volcano/faas/deploy-functions.sh` + `call_create_function.py` |
| 应用镜像与启动 | 容器 | `deploy/volcano/docker/Dockerfile.vefaas`、`faas/run-web.sh`、`faas/run-worker.sh` |

## 前置

1. 安装 Terraform（>=1.3）：`brew tap hashicorp/tap && brew install hashicorp/tap`
2. 准备 AK/SK（子账号，含 VPC/RDS/ECS/CR/veFaaS 权限）：
   ```bash
   export VOLCENGINE_ACCESS_KEY=<AK>
   export VOLCENGINE_SECRET_KEY=<SK>
   ```
3. 复制变量文件并填写：
   ```bash
   cd deploy/volcano/terraform
   cp terraform.tfvars.example terraform.tfvars   # 填 opend_image_id 等
   export TF_VAR_rds_account_password='<RDS强密码>'
   export TF_VAR_opend_password='<Windows复杂密码>'
   ```
   - `opend_image_id`：在 ECS 控制台「公共镜像」选 Windows Server 2022 中文版，复制镜像 ID。
   - `operator_office_cidr`：收紧为你的固定办公公网 IP/32（RDP 用）。

## 步骤

```bash
# 1. 初始化与预览
bash terraform-apply.sh plan

# 2. 创建/变更（确认无误后）
bash terraform-apply.sh apply

# 3. 查看输出（VPC/子网/安全组/RDS/OpenD 内网 IP）
bash terraform-apply.sh out
```

输出关键值：
- `security_group_faas_id` / `vpc_id` / `subnet_ids`：配置 veFaaS 函数用
- `opend_ecs_private_ip`：worker 的 `FUTU_OPEND_HOST`
- `rds_connection`：应用侧 `DATABASE_URL` 基础（替换为真实密码与连接端点）

## 创建后手动/脚本步骤

1. **OpenD（Windows ECS）**：RDP 登录 → 安装 GUI Futu OpenD → 登录/问卷/协议 → 监听 `0.0.0.0:11111` → 配 RSA 私钥（交易）→ `auto_hold_quote_right=1` → 开机自启（见部署手册第 15.2 阶段 C）。
2. **数据库**：用本地迁移产物导入 AIDAP/RDS：
   ```bash
   DATABASE_URL='postgresql://fin_app:<pw>@<rds-endpoint>:5432/financial' \
     bash -c 'psql "$DATABASE_URL" -f financial.sql'   # 或先 pg_dump 自本地 PG
   .venv-cloud/bin/python deploy/volcano/pg/verify_row_counts.py   # 指向云上连接串对账
   ```
3. **镜像**：`CR_REGISTRY=<inst>-cn-beijing.cr.volces.com CR_USER=<u>@<id> bash deploy/volcano/scripts/build-and-push-image.sh`
4. **veFaaS 函数**：
   ```bash
   export VPC_ID=$(terraform output -raw vpc_id)
   export SUBNET_ID=$(terraform output -json subnet_ids | jq -r '.[0]')
   export SG_FAAS_ID=$(terraform output -raw security_group_faas_id)
   export IMAGE_WEB=<cr>/fin/financial-workbench:<tag>
   export IMAGE_WORKER=$IMAGE_WEB
   export RDS_DATABASE_URL=postgresql://fin_app:<pw>@<rds-endpoint>:5432/financial
   export FUTU_OPEND_HOST=$(terraform output -raw opend_ecs_private_ip)
   export AUTH_JWT_SECRET=... ADMIN_USERNAME=... ADMIN_PASSWORD=...
   export VOLC_ACCESSKEY=$VOLCENGINE_ACCESSKEY VOLC_SECRETKEY=$VOLCENGINE_SECRET_KEY
   bash deploy/volcano/faas/deploy-functions.sh
   python deploy/volcano/faas/call_create_function.py fin-web
   python deploy/volcano/faas/call_create_function.py fin-worker
   ```
   Worker 用 `CpuStrategy=always`（常驻、单实例、独占），Web 用 burstable。
5. **APIG**：控制台为 `fin-web` 配置 API 网关触发器 + HTTPS 域名；`fin-worker` 无需公网入口。

## 安全说明

- `terraform.tfvars`、`*.tfstate*`、`tfplan`、`faas/out/*` 均已在 `.gitignore`，**含密钥严禁入库**。
- AK/SK 与数据库/RDP 密码一律走环境变量或 Secret，不写入 tf 文件。
- `terraform destroy` 为高危操作，脚本默认只打印 plan，需手动确认执行。
