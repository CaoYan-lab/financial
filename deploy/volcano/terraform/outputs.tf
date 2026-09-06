output "vpc_id" {
  description = "VPC ID（veFaaS/RDS/ECS 共用）"
  value       = volcengine_vpc.fin.id
}

output "subnet_ids" {
  description = "子网 ID 列表（a、b）"
  value       = [volcengine_subnet.fin_a.id, volcengine_subnet.fin_b.id]
}

output "subnet_a_id" {
  description = "子网 A ID（RDS/ECS/veFaaS 主用）"
  value       = volcengine_subnet.fin_a.id
}

output "security_group_opend_id" {
  description = "OpenD 安全组 ID"
  value       = volcengine_security_group.opend.id
}

output "security_group_faas_id" {
  description = "veFaaS 安全组 ID"
  value       = volcengine_security_group.faas.id
}

output "rds_instance_id" {
  description = "RDS PostgreSQL 实例 ID（rds_create=false 时为空）"
  value       = var.rds_create ? volcengine_rds_postgresql_instance.fin[0].id : ""
}

output "rds_connection" {
  description = "应用侧 DATABASE_URL 模板（请以实际密码与端点替换）"
  value       = "postgresql://${var.rds_account_name}:<password>@<rds-endpoint>:5432/${var.rds_db_name}"
}

output "opend_ecs_id" {
  description = "Windows OpenD ECS ID（opend_ecs_create=false 时为空）"
  value       = var.opend_ecs_create ? volcengine_ecs_instance.opend[0].id : ""
}

output "opend_ecs_private_ip" {
  description = "worker 的 FUTU_OPEND_HOST：OpenD ECS 主内网 IP（同 VPC 内网访问 11111）"
  value       = var.opend_ecs_create ? volcengine_ecs_instance.opend[0].primary_ip_address : ""
}

output "opend_ecs_public_ip" {
  description = "RDP 运维入口：OpenD ECS 绑定的弹性公网 IP（3389）"
  value       = var.opend_ecs_create ? volcengine_eip_address.opend[0].eip_address : ""
}
