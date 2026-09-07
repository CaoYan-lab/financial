terraform {
  required_version = ">= 1.3.0"

  required_providers {
    volcengine = {
      source  = "volcengine/volcengine"
      version = ">= 0.0.139"
    }
  }
}

# 凭据从环境变量读取，禁止写入代码：
#   export VOLCENGINE_ACCESS_KEY=***
#   export VOLCENGINE_SECRET_KEY=***
provider "volcengine" {
  region     = var.region
  access_key = var.access_key
  secret_key = var.secret_key
}
