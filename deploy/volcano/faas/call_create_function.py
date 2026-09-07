#!/usr/bin/env python3
"""
调用 veFaaS OpenAPI 创建/更新函数（Web/Worker）。
先由 deploy-functions.sh 生成 out/<name>.create.json 请求体，再执行本脚本。

  bash deploy/volcano/faas/deploy-functions.sh
  python deploy/volcano/faas/call_create_function.py fin-web
  python deploy/volcano/faas/call_create_function.py fin-worker

依赖：pip install volcengine（或 volcengine-python-sdk）
环境变量：VOLC_ACCESSKEY、VOLC_SECRETKEY、REGION（默认 cn-beijing）
"""
import json
import os
import sys
from pathlib import Path

try:
    import volcenginesdkcore
    import volcenginesdkvefaas
    from volcenginesdkcore.rest import ApiException
except ImportError:  # pragma: no cover
    print("缺少依赖：pip install volcengine")
    sys.exit(2)


def _client(region: str):
    config = volcenginesdkcore.Configuration()
    config.ak = os.environ["VOLC_ACCESSKEY"]
    config.sk = os.environ["VOLC_SECRETKEY"]
    config.region = region
    volcenginesdkcore.Configuration.set_default(config)
    return volcenginesdkvefaas.VEFAASApi(volcenginesdkcore.ApiClient(config))


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "fin-web"
    region = os.environ.get("REGION", "cn-beijing")
    body_path = Path(__file__).parent / "out" / f"{name}.create.json"
    body = json.loads(body_path.read_text(encoding="utf-8"))

    api = _client(region)

    # 先查是否已存在：存在则更新，不存在则创建
    existing = None
    try:
        listing = api.list_functions(volcenginesdkvefaas.ListFunctionsRequest())
        for item in getattr(listing, "items", []) or []:
            if getattr(item, "name", "") == body["Name"]:
                existing = item
                break
    except ApiException:
        existing = None

    if existing:
        print(f"[INFO] 函数 {name} 已存在，执行更新（镜像/环境变量）")
        try:
            req = volcenginesdkvefaas.UpdateFunctionResourceRequest(
                function_id=existing.id,
                source_type="image",
                source=body["Source"],
                envs=[volcenginesdkvefaas.EnvForUpdateFunctionInput(key=e["Key"], value=e["Value"]) for e in body["Envs"]],
            )
            api.update_function_resource(req)
            print("[OK] 已更新函数资源")
        except ApiException as exc:
            print(f"[ERROR] 更新失败：{exc.status} {exc.body}")
            sys.exit(1)
    else:
        print(f"[INFO] 创建函数 {name}")
        try:
            req = volcenginesdkvefaas.CreateFunctionRequest(
                name=body["Name"],
                runtime=body["Runtime"],
                source_type=body["SourceType"],
                source=body["Source"],
                command=body["Command"],
                port=body["Port"],
                memory_mb=body["MemoryMB"],
                cpu_milli=body["CpuMilli"],
                cpu_strategy=body.get("CpuStrategy"),
                request_timeout=body["RequestTimeout"],
                exclusive_mode=body["ExclusiveMode"],
                envs=[volcenginesdkvefaas.EnvForCreateFunctionInput(key=e["Key"], value=e["Value"]) for e in body["Envs"]],
            )
            resp = api.create_function(req)
            print(f"[OK] 已创建：{getattr(resp, 'id', '')}")
        except ApiException as exc:
            print(f"[ERROR] 创建失败：{exc.status} {exc.body}")
            sys.exit(1)


if __name__ == "__main__":
    main()
