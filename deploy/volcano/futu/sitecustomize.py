"""云部署专用：Python 解释器启动时自动执行（sitecustomize 机制）。

唯一职责：在云常驻 worker 进程内，为 futu-api 的「交易连接」启用 RSA 加密。
富途 OpenD 规定：交易连接来自非本机（跨网）时必须加密，否则 get_acc_list /
accinfo_query 等会返回 ret=-1「为保证交易的安全，跨网通信，交易连接需要加密」。

加密为 futu 的 RSA 公私钥协商：OpenD 与客户端使用「同一把 RSA 私钥」。
私钥经环境变量 FUTU_TRADE_RSA_PEM（PEM 文本）注入，绝不固化进镜像。
未设置该环境变量时本文件什么都不做，本地开发 / 未注入密钥环境行为完全不变。
"""

import os


def _enable_futu_trade_encryption():
    pem = os.environ.get("FUTU_TRADE_RSA_PEM")
    if not pem:
        return
    try:
        key_path = "/tmp/futu_conn_key.pem"
        # 仅当前用户可读，避免私钥被容器内其他用户读取
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(pem if pem.endswith("\n") else pem + "\n")
        from futu.common.sys_config import SysConfig

        SysConfig.enable_proto_encrypt(True)
        SysConfig.set_init_rsa_file(key_path)
    except Exception:
        # 加密初始化失败时静默降级（不阻断解释器启动；交易查询将在业务层报不可用）
        pass


_enable_futu_trade_encryption()
