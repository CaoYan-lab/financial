# ===== RDS PostgreSQL（火山引擎 PostgreSQL 版）=====
# 字段对齐 volcengine provider（node_spec/storage_space/primary_zone_id/charge_info）。
# 若使用已开通的 AIDAP/外部 PG，设 rds_create=false 并在应用侧直接用连接串。

data "volcengine_rds_postgresql_zones" "fin" {
  count = var.rds_create ? 1 : 0
}

resource "volcengine_rds_postgresql_instance" "fin" {
  count               = var.rds_create ? 1 : 0
  instance_name       = "${var.name_prefix}-pg"
  db_engine_version   = var.rds_pg_version
  node_spec           = var.rds_instance_type
  storage_space       = var.rds_storage_gb
  primary_zone_id     = var.zone_a
  secondary_zone_id   = var.zone_b
  subnet_id           = volcengine_subnet.fin_a.id
  project_name        = "default"

  charge_info {
    charge_type = "PostPaid"
  }
}

# 高权限账号（密码从 TF_VAR_rds_account_password 注入）
resource "volcengine_rds_postgresql_account" "fin_app" {
  count            = var.rds_create ? 1 : 0
  instance_id      = volcengine_rds_postgresql_instance.fin[0].id
  account_name     = var.rds_account_name
  account_password = var.rds_account_password
  account_type     = "Super"
}

# 业务库
resource "volcengine_rds_postgresql_database" "fin" {
  count       = var.rds_create ? 1 : 0
  instance_id = volcengine_rds_postgresql_instance.fin[0].id
  db_name     = var.rds_db_name
  c_type      = "C"
  owner       = var.rds_account_name
  depends_on  = [volcengine_rds_postgresql_account.fin_app]
}

# 白名单：VPC 内网可访问（veFaaS/ECS 经 VPC 连库）
resource "volcengine_rds_postgresql_allowlist" "fin" {
  count           = var.rds_create ? 1 : 0
  allow_list_name = "${var.name_prefix}-vpc-allowlist"
  allow_list_desc = "VPC internal access"
  allow_list_type = "IPv4"
  allow_list      = [var.vpc_cidr]
  instance_ids    = [volcengine_rds_postgresql_instance.fin[0].id]
  depends_on      = [volcengine_rds_postgresql_instance.fin]
}
