# ===== Windows ECS：Futu OpenD 网关 =====
# 用 data source 自动查询 Windows Server 2022 公共镜像（status=available），
# 避免硬编码 image_id；若指定 var.opend_image_id 则优先使用（用于锁定版本）。

data "volcengine_images" "windows" {
  count      = var.opend_ecs_create && var.opend_image_id == "" ? 1 : 0
  os_type    = "Windows"
  visibility = "public"
  status     = ["available"]
  image_name = "Windows Server 2022"
}

locals {
  # 优先显式 image_id；否则取 data source 返回的第一个可用公共镜像。
  # length() 保护：data source 无结果时报清晰错误，而非 Invalid index。
  opend_image_id_effective = (
    var.opend_image_id != "" ? var.opend_image_id : (
      var.opend_ecs_create ? data.volcengine_images.windows[0].images[0].image_id : ""
    )
  )
}

resource "volcengine_ecs_instance" "opend" {
  count                = var.opend_ecs_create ? 1 : 0
  instance_name        = "${var.name_prefix}-opend"
  image_id             = local.opend_image_id_effective
  instance_type        = var.opend_instance_type
  instance_charge_type = "PostPaid"
  password             = var.opend_password
  system_volume_type   = "ESSD_PL0"
  system_volume_size   = var.opend_system_volume_size
  subnet_id            = volcengine_subnet.fin_a.id
  security_group_ids   = [volcengine_security_group.opend.id]
  zone_id              = var.zone_a

  tags {
    key   = "role"
    value = "futu-opend"
  }
}

# 弹性公网 IP：RDP 运维入口（3389 仅在 opend 安全组放行）。按量计费。
resource "volcengine_eip_address" "opend" {
  count        = var.opend_ecs_create ? 1 : 0
  name         = "${var.name_prefix}-opend-eip"
  billing_type = "PostPaidByBandwidth"
  bandwidth    = 5
  isp          = "BGP"

  lifecycle {
    ignore_changes = [tags]
  }
}

resource "volcengine_eip_associate" "opend" {
  count         = var.opend_ecs_create ? 1 : 0
  allocation_id = volcengine_eip_address.opend[0].id
  instance_id   = volcengine_ecs_instance.opend[0].id
  instance_type = "EcsInstance"
}
