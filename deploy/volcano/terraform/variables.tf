# ====================================================================
# 火山引擎云上部署 Terraform 变量
# 复制 terraform.tfvars.example 为 terraform.tfvars 后填写；
# 敏感值（AK/SK/密码）也可通过环境变量 VOLCENGINE_ACCESS_KEY/SECRET_KEY 传入。
# ====================================================================

variable "region" {
  description = "地域"
  type        = string
  default     = "cn-beijing"
}

variable "zone_a" {
  description = "可用区 A"
  type        = string
  default     = "cn-beijing-a"
}

variable "zone_b" {
  description = "可用区 B（RDS 备可用区用）"
  type        = string
  default     = "cn-beijing-b"
}

# ---- 凭据（建议用环境变量，不写 tfvars）----
variable "access_key" {
  description = "火山引擎 AccessKey ID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "secret_key" {
  description = "火山引擎 Secret AccessKey"
  type        = string
  sensitive   = true
  default     = ""
}

# ---- 通用命名 ----
variable "name_prefix" {
  description = "资源命名前缀"
  type        = string
  default     = "fin"
}

# ---- 网络 ----
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
variable "subnet_a_cidr" {
  type    = string
  default = "10.20.1.0/24"
}
variable "subnet_b_cidr" {
  type    = string
  default = "10.20.2.0/24"
}
variable "operator_office_cidr" {
  description = "操作员办公网公网 CIDR（RDP 白名单；收紧为你的固定公网 IP/32）"
  type        = string
  default     = "0.0.0.0/0"
}

# ---- RDS PostgreSQL ----
variable "rds_create" {
  description = "是否创建 RDS PostgreSQL。默认 false：复用已开通的 AIDAP PostgreSQL，应用侧直接用连接串，terraform 不创建任何数据库资源"
  type        = bool
  default     = false
}
variable "rds_instance_type" {
  description = "RDS 规格"
  type        = string
  default     = "rds.postgres.1c2g"
}
variable "rds_storage_gb" {
  description = "存储(GB)"
  type        = number
  default     = 40
}
variable "rds_pg_version" {
  description = "PostgreSQL 版本"
  type        = string
  default     = "PostgreSQL_16"
}
variable "rds_db_name" {
  type    = string
  default = "financial"
}
variable "rds_account_name" {
  type    = string
  default = "fin_app"
}
variable "rds_account_password" {
  description = "RDS 账号密码（敏感；建议环境变量 TF_VAR_rds_account_password）"
  type        = string
  sensitive   = true
  default     = ""
}

# ---- Windows ECS（Futu OpenD）----
variable "opend_ecs_create" {
  description = "是否创建 Windows OpenD ECS（false 则跳过）"
  type        = bool
  default     = true
}
variable "opend_image_id" {
  description = "Windows Server 镜像 ID（按地域控制台查询后填入）"
  type        = string
  default     = ""
}
variable "opend_instance_type" {
  type    = string
  default = "ecs.g3il.large" # 2C8G 通用型，兼容北京区 Windows Server 2022 公共镜像
}
variable "opend_password" {
  description = "Windows RDP/Administrator 密码（敏感；环境变量 TF_VAR_opend_password）"
  type        = string
  sensitive   = true
  default     = ""
}
variable "opend_system_volume_size" {
  type    = number
  default = 60
}
