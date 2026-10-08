#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <internal.dmg>\n' "$0" >&2
  exit 64
fi

DMG_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
DIST_DIR="$(dirname "${DMG_PATH}")"
CHECKSUM_PATH="${DMG_PATH}.sha256"
MANIFEST_PATH="${DIST_DIR}/release-manifest.json"
mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/changfu-mount.XXXXXX")"
copy_dir="$(mktemp -d "${TMPDIR:-/tmp}/changfu-smoke.XXXXXX")"
mounted=0
app_pid=""

cleanup() {
  if [[ -n "${app_pid}" ]] && kill -0 "${app_pid}" 2>/dev/null; then
    kill -TERM "${app_pid}" 2>/dev/null || true
    wait "${app_pid}" 2>/dev/null || true
  fi
  if [[ "${mounted}" == "1" ]]; then
    hdiutil detach "${mount_dir}" -force >/dev/null 2>&1 || true
  fi
  rm -rf "${mount_dir}" "${copy_dir}"
}
trap cleanup EXIT

for file in "${DMG_PATH}" "${CHECKSUM_PATH}" "${MANIFEST_PATH}"; do
  if [[ ! -f "${file}" ]]; then
    printf '[长富] 验证输入缺失：%s\n' "${file}" >&2
    exit 1
  fi
done

printf '[长富] 校验 DMG 与 SHA-256\n'
hdiutil verify "${DMG_PATH}" >/dev/null
(cd "${DIST_DIR}" && shasum -a 256 -c "$(basename "${CHECKSUM_PATH}")")
hdiutil attach -readonly -nobrowse -mountpoint "${mount_dir}" "${DMG_PATH}" >/dev/null
mounted=1

APP_DIR="${mount_dir}/长富.app"
if [[ ! -d "${APP_DIR}" || ! -L "${mount_dir}/Applications" || ! -f "${mount_dir}/首次安装说明.txt" ]]; then
  printf '[长富] DMG 内容结构不完整\n' >&2
  exit 1
fi
if [[ "$(readlink "${mount_dir}/Applications")" != "/Applications" ]]; then
  printf '[长富] Applications 链接目标错误\n' >&2
  exit 1
fi

IFS=$'\t' read -r expected_version expected_build expected_origin expected_app_hash < <(
  python3 - "${MANIFEST_PATH}" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
print(
    manifest["version"],
    manifest["build"],
    manifest["apiOrigin"],
    manifest["appBundleSha256"],
    sep="\t",
)
PY
)

plist="${APP_DIR}/Contents/Info.plist"
read_plist() {
  /usr/libexec/PlistBuddy -c "Print :$1" "${plist}"
}
[[ "$(read_plist CFBundleIdentifier)" == "com.changfu.desktop" ]]
[[ "$(read_plist CFBundleShortVersionString)" == "${expected_version}" ]]
[[ "$(read_plist CFBundleVersion)" == "${expected_build}" ]]
[[ "$(read_plist LSMinimumSystemVersion)" == "14.0" ]]
[[ "$(read_plist CFBundleIconFile)" == "AppIcon" ]]
[[ "$(read_plist ChangFuPublicAPIOrigin)" == "${expected_origin}" ]]
[[ -s "${APP_DIR}/Contents/Resources/AppIcon.icns" ]]

if find "${APP_DIR}" -iname '*.env' -o -iname '*password*' -o -iname '*secret*' \
  -o -iname '*.pem' -o -iname '*.key' | grep -q .; then
  printf '[长富] App 中发现禁止发布的敏感文件名\n' >&2
  exit 1
fi
if plutil -p "${plist}" | grep -Eqi 'password|secret|api[_ -]?key|access[_ -]?token|private[_ -]?key'; then
  printf '[长富] Info.plist 中发现疑似凭据字段\n' >&2
  exit 1
fi

printf '[长富] 校验架构、依赖闭包与签名\n'
while IFS= read -r -d '' binary; do
  if [[ "$(lipo -archs "${binary}")" != "arm64" ]]; then
    printf '[长富] 非纯 arm64 Mach-O：%s\n' "${binary}" >&2
    exit 1
  fi
  min_versions="$(otool -l "${binary}" | awk '/minos/{print $2}' | sort -u)"
  if [[ -z "${min_versions}" ]] || ! python3 - "${min_versions}" <<'PY'
import sys
versions = [tuple(map(int, item.split("."))) for item in sys.argv[1].split()]
raise SystemExit(0 if max(versions) <= (14, 0) else 1)
PY
  then
    printf '[长富] Mach-O 要求高于 macOS 14：%s (%s)\n' \
      "${binary}" "${min_versions:-unknown}" >&2
    exit 1
  fi
  if otool -L "${binary}" | tail -n +2 | grep -Eq '/Users/|/CommandLineTools/|/\.data/'; then
    printf '[长富] 依赖包含构建机路径：%s\n' "${binary}" >&2
    exit 1
  fi
  if otool -l "${binary}" | tail -n +2 | grep -Eq '/Users/|/CommandLineTools/|/\.data/'; then
    printf '[长富] RPath 包含构建机路径：%s\n' "${binary}" >&2
    exit 1
  fi
  while IFS= read -r dependency; do
    case "${dependency}" in
      /System/*|/usr/lib/*|@loader_path/*|@executable_path/*) ;;
      @rpath/*)
        dependency_name="${dependency##*/}"
        if [[ ! -f "${APP_DIR}/Contents/Frameworks/${dependency_name}" ]]; then
          printf '[长富] @rpath 依赖未包含在 App：%s -> %s\n' "${binary}" "${dependency}" >&2
          exit 1
        fi
        ;;
      *)
        printf '[长富] 发现未封装的非系统依赖：%s -> %s\n' "${binary}" "${dependency}" >&2
        exit 1
        ;;
    esac
  done < <(otool -L "${binary}" | tail -n +2 | awk '{print $1}')
  codesign --verify --strict --verbose=2 "${binary}"
done < <(find "${APP_DIR}" -type f -print0 | while IFS= read -r -d '' candidate; do
  if file -b "${candidate}" | grep -q 'Mach-O'; then
    printf '%s\0' "${candidate}"
  fi
done)
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

actual_app_hash="$(
  python3 - "${APP_DIR}" <<'PY'
import hashlib
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
hasher = hashlib.sha256()
for path in sorted(root.rglob("*")):
    hasher.update(path.relative_to(root).as_posix().encode("utf-8"))
    if path.is_symlink():
        hasher.update(b"L")
        hasher.update(os.readlink(path).encode("utf-8"))
    elif path.is_file():
        hasher.update(b"F")
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                hasher.update(chunk)
print(hasher.hexdigest())
PY
)"
[[ "${actual_app_hash}" == "${expected_app_hash}" ]]

if spctl --assess --type execute "${APP_DIR}" >/dev/null 2>&1; then
  printf '[长富] Gatekeeper：通过（当前环境未拒绝此 ad-hoc 包）\n'
else
  printf '[长富] Gatekeeper：INTERNAL_UNSIGNED_EXPECTED\n'
fi

if [[ "${CHANGFU_VERIFY_SKIP_LAUNCH:-0}" != "1" ]]; then
  ditto "${APP_DIR}" "${copy_dir}/长富.app"
  "${copy_dir}/长富.app/Contents/MacOS/ChangFu" \
    >"${copy_dir}/launch.stdout.log" \
    2>"${copy_dir}/launch.stderr.log" &
  app_pid="$!"
  sleep 4
  if ! kill -0 "${app_pid}" 2>/dev/null; then
    wait "${app_pid}" || status="$?"
    printf '[长富] 仓库外启动冒烟失败（退出码 %s）\n' "${status:-0}" >&2
    sed -n '1,80p' "${copy_dir}/launch.stderr.log" >&2
    exit 1
  fi
  kill -TERM "${app_pid}"
  wait "${app_pid}" 2>/dev/null || true
  app_pid=""
fi

printf '[长富] DMG 自动验证通过：%s\n' "${DMG_PATH}"
