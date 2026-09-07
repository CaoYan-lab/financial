# ===== VPC 与子网 =====
resource "volcengine_vpc" "fin" {
  vpc_name   = "${var.name_prefix}-vpc"
  cidr_block = var.vpc_cidr

  # 火山平台自动注入 sys:tag:createdBy 托管标签，不交由 terraform 管理
  lifecycle {
    ignore_changes = [tags]
  }
}

resource "volcengine_subnet" "fin_a" {
  subnet_name = "${var.name_prefix}-subnet-a"
  cidr_block  = var.subnet_a_cidr
  zone_id     = var.zone_a
  vpc_id      = volcengine_vpc.fin.id

  lifecycle {
    ignore_changes = [tags]
  }
}

resource "volcengine_subnet" "fin_b" {
  subnet_name = "${var.name_prefix}-subnet-b"
  cidr_block  = var.subnet_b_cidr
  zone_id     = var.zone_b
  vpc_id      = volcengine_vpc.fin.id

  lifecycle {
    ignore_changes = [tags]
  }
}

# ===== 安全组：OpenD Windows ECS =====
resource "volcengine_security_group" "opend" {
  security_group_name = "${var.name_prefix}-sg-opend"
  vpc_id              = volcengine_vpc.fin.id

  lifecycle {
    ignore_changes = [tags]
  }
}

# 出向：OpenD 连 Futu 云端（443）
resource "volcengine_security_group_rule" "opend_egress_https" {
  security_group_id = volcengine_security_group.opend.id
  direction         = "egress"
  protocol          = "tcp"
  port_start        = 443
  port_end          = 443
  cidr_ip           = "0.0.0.0/0"
}

# 入向：RDP（仅操作员办公网，默认收紧请改 operator_office_cidr）
resource "volcengine_security_group_rule" "opend_rdp" {
  security_group_id = volcengine_security_group.opend.id
  direction         = "ingress"
  protocol          = "tcp"
  port_start        = 3389
  port_end          = 3389
  cidr_ip           = var.operator_office_cidr
}

# 入向：OpenD OpenAPI 11111（仅 VPC 网段，供 worker 访问）
resource "volcengine_security_group_rule" "opend_api" {
  security_group_id = volcengine_security_group.opend.id
  direction         = "ingress"
  protocol          = "tcp"
  port_start        = 11111
  port_end          = 11111
  cidr_ip           = var.vpc_cidr
}

# ===== 安全组：veFaaS（平台托管入向，出向按需）=====
resource "volcengine_security_group" "faas" {
  security_group_name = "${var.name_prefix}-sg-faas"
  vpc_id              = volcengine_vpc.fin.id

  lifecycle {
    ignore_changes = [tags]
  }
}

resource "volcengine_security_group_rule" "faas_egress_all" {
  security_group_id = volcengine_security_group.faas.id
  direction         = "egress"
  protocol          = "tcp"
  port_start        = 1
  port_end          = 65535
  cidr_ip           = "0.0.0.0/0"
}

resource "volcengine_security_group_rule" "faas_egress_udp" {
  security_group_id = volcengine_security_group.faas.id
  direction         = "egress"
  protocol          = "udp"
  port_start        = 1
  port_end          = 65535
  cidr_ip           = "0.0.0.0/0"
}
