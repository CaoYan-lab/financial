#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${CHANGFU_RELEASE_VERSION:?CHANGFU_RELEASE_VERSION is required}"
: "${CHANGFU_RELEASE_BUILD:?CHANGFU_RELEASE_BUILD is required}"
: "${CHANGFU_PUBLIC_API_ORIGIN:?CHANGFU_PUBLIC_API_ORIGIN is required}"
: "${CHANGFU_APP_ICON_SOURCE:?CHANGFU_APP_ICON_SOURCE is required}"

export CHANGFU_RELEASE_CHANNEL="${CHANGFU_RELEASE_CHANNEL:-internal}"
"${ROOT_DIR}/scripts/build-release-app.sh"

DIST_DIR="${ROOT_DIR}/dist/${CHANGFU_RELEASE_VERSION}-${CHANGFU_RELEASE_BUILD}"
APP_DIR="${DIST_DIR}/长富.app"
DMG_BASENAME="ChangFu-${CHANGFU_RELEASE_VERSION}-${CHANGFU_RELEASE_BUILD}-macOS-arm64-internal.dmg"
DMG_PATH="${DIST_DIR}/${DMG_BASENAME}"
CHECKSUM_PATH="${DMG_PATH}.sha256"
MANIFEST_PATH="${DIST_DIR}/release-manifest.json"
staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/changfu-dmg.XXXXXX")"
trap 'rm -rf "${staging_dir}"' EXIT

"${ROOT_DIR}/scripts/sign-internal-app.sh" "${APP_DIR}"

ditto "${APP_DIR}" "${staging_dir}/长富.app"
ln -s /Applications "${staging_dir}/Applications"
cat >"${staging_dir}/首次安装说明.txt" <<'INSTRUCTIONS'
长富 macOS 内部灰度版安装说明

1. 本版本仅支持 Apple Silicon（M 系列芯片）和 macOS 14 及以上系统。
2. 将“长富.app”拖入“Applications”文件夹。
3. 首次启动请在 Finder 中右键“长富”，选择“打开”，再确认打开。
4. 若仍被阻止，请前往“系统设置 → 隐私与安全性”，选择“仍要打开”。
5. 使用前请独立安装、登录并启动 Futu OpenD；OpenD 不包含在本安装包中。
6. 本包使用 ad-hoc 临时签名且未经过 Apple 公证，仅限内部灰度测试。
7. 升级前退出长富，再将新版本拖入“应用程序”并覆盖旧版本。
INSTRUCTIONS

rm -f "${DMG_PATH}" "${CHECKSUM_PATH}" "${MANIFEST_PATH}"
hdiutil create \
  -volname "长富 ${CHANGFU_RELEASE_VERSION}" \
  -srcfolder "${staging_dir}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}" >/dev/null

(cd "${DIST_DIR}" && shasum -a 256 "${DMG_BASENAME}" >"${DMG_BASENAME}.sha256")

python3 - \
  "${APP_DIR}" \
  "${DMG_PATH}" \
  "${MANIFEST_PATH}" \
  "${CHANGFU_RELEASE_VERSION}" \
  "${CHANGFU_RELEASE_BUILD}" \
  "${CHANGFU_PUBLIC_API_ORIGIN%/}" \
  "$(git -C "${ROOT_DIR}" rev-parse HEAD 2>/dev/null || printf unknown)" <<'PY'
import hashlib
import json
import os
import pathlib
import plistlib
import sys

app = pathlib.Path(sys.argv[1])
dmg = pathlib.Path(sys.argv[2])
manifest = pathlib.Path(sys.argv[3])
version, build, api_origin, commit = sys.argv[4:]

def digest_file(path):
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()

def digest_tree(root):
    hasher = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        hasher.update(relative.encode("utf-8"))
        if path.is_symlink():
            hasher.update(b"L")
            hasher.update(os.readlink(path).encode("utf-8"))
        elif path.is_file():
            hasher.update(b"F")
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    hasher.update(chunk)
    return hasher.hexdigest()

with (app / "Contents" / "Info.plist").open("rb") as source:
    plist = plistlib.load(source)

component_paths = [
    app / "Contents/MacOS/ChangFu",
    app / "Contents/MacOS/ChangFuBrokerHost",
    app / "Contents/MacOS/ChangFuLongbridgeHost",
    app / "Contents/MacOS/longbridge",
    app / "Contents/Frameworks/libprotobuf.32.dylib",
    app / "Contents/Frameworks/libssl.3.dylib",
    app / "Contents/Frameworks/libcrypto.3.dylib",
]
components = [
    {
        "path": path.relative_to(app).as_posix(),
        "sha256": digest_file(path),
    }
    for path in component_paths
]

payload = {
    "schemaVersion": 1,
    "product": "ChangFu",
    "displayName": "长富",
    "version": version,
    "build": int(build),
    "gitCommit": commit,
    "bundleIdentifier": plist["CFBundleIdentifier"],
    "minimumSystemVersion": plist["LSMinimumSystemVersion"],
    "targetArchitecture": "arm64",
    "releaseChannel": "internal",
    "apiOrigin": api_origin,
    "signing": "ad-hoc-internal",
    "notarized": False,
    "appBundleSha256": digest_tree(app),
    "dmgFile": dmg.name,
    "dmgSha256": digest_file(dmg),
    "components": components,
}
manifest.write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY

"${ROOT_DIR}/scripts/verify-internal-dmg.sh" "${DMG_PATH}"
printf '[长富] 内部 DMG 已生成：%s\n' "${DMG_PATH}"
printf '[长富] SHA-256：%s\n' "${CHECKSUM_PATH}"
printf '[长富] 发布清单：%s\n' "${MANIFEST_PATH}"
