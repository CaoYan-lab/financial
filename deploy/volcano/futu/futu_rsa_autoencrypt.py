"""云常驻 worker 启动钩子（经同目录 futu_rsa_autoencrypt.pth 的 `import` 行触发）。

为什么用 .pth 而非 sitecustomize：系统解释器自带 /usr/lib/python3.x/sitecustomize.py
会遮蔽 venv site-packages 下的同名文件，导致 sitecustomize 引导不执行。.pth 中的
`import futu_rsa_autoencrypt` 行在解释器启动初始化 site-packages 时必被执行。

职责：当环境变量 FUTU_TRADE_RSA_PEM 注入时，为 futu-api 交易连接启用 RSA 加密
（富途 OpenD 要求跨网交易连接必须加密）。未注入则什么都不做，本地/未配置环境行为不变。
"""

import os


def _bootstrap():
    pem = os.environ.get("FUTU_TRADE_RSA_PEM")
    if not pem:
        return
    key_path = "/tmp/futu_conn_key.pem"
    try:
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(pem if pem.endswith("\n") else pem + "\n")
    except Exception:
        return
    try:
        from futu.common.sys_config import SysConfig

        SysConfig.enable_proto_encrypt(True)
        SysConfig.set_init_rsa_file(key_path)
    except Exception:
        # 早期导入若失败，静默降级（不阻断解释器；交易查询将在业务层报不可用）
        pass


_bootstrap()
