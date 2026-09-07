#!/usr/bin/env bash
# 一键创建火山云基础资源（VPC/子网/安全组/RDS PG/Windows OpenD ECS）。
# veFaaS 函数与 CR 镜像不走 Terraform（用 deploy/volcano/faas + scripts）。
#
# 前置：
#   安装 Terraform（>=1.3）：brew install hashicorp/tap/terraform
#   cp terraform.tfvars.example terraform.tfvars 并填写（尤其 opend_image_id）
#   export VOLCENGINE_ACCESS_KEY=***
#   export VOLCENGINE_SECRET_KEY=***
#   export TF_VAR_rds_account_password='强密码'
#   export TF_VAR_opend_password='Windows 复杂密码'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[ -n "${VOLCENGINE_ACCESS_KEY:-}" ] && [ -n "${VOLCENGINE_SECRET_KEY:-}" ] \
  || { echo "请先 export VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY"; exit 1; }
[ -f terraform.tfvars ] || { echo "请先复制 terraform.tfvars.example 为 terraform.tfvars 并填写"; exit 1; }

terraform init

case "${1:-plan}" in
  plan)  terraform plan -out tfplan ;;
  apply) terraform apply tfplan 2>/dev/null || terraform apply -auto-approve; terraform output ;;
  out)   terraform output ;;
  destroy) echo "将销毁资源（高危）。确认请手动执行：terraform destroy"; terraform plan -destroy ;;
  *) echo "用法：$0 [plan|apply|out|destroy]" ;;
esac
