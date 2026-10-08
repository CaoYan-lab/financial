#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FINANCIAL_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
SDK_LIB_DIR="${FINANCIAL_ROOT}/.data/changfu-sdk/third/lib"
LONGBRIDGE_CLI="${FINANCIAL_ROOT}/.tools/longbridge/longbridge"
SWIFT_HOST_LIB="/Library/Developer/CommandLineTools/usr/lib/swift/host/compiler"

: "${CHANGFU_RELEASE_VERSION:?CHANGFU_RELEASE_VERSION is required}"
: "${CHANGFU_RELEASE_BUILD:?CHANGFU_RELEASE_BUILD is required}"
: "${CHANGFU_PUBLIC_API_ORIGIN:?CHANGFU_PUBLIC_API_ORIGIN is required}"
: "${CHANGFU_APP_ICON_SOURCE:?CHANGFU_APP_ICON_SOURCE is required}"

release_channel="${CHANGFU_RELEASE_CHANNEL:-internal}"
if [[ "${release_channel}" != "internal" ]]; then
  printf '[长富] 当前只支持 internal 发布渠道\n' >&2
  exit 1
fi
if [[ ! "${CHANGFU_RELEASE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  printf '[长富] 版本号不是有效语义版本：%s\n' "${CHANGFU_RELEASE_VERSION}" >&2
  exit 1
fi
if [[ ! "${CHANGFU_RELEASE_BUILD}" =~ ^[1-9][0-9]*$ ]]; then
  printf '[长富] 构建号必须是正整数：%s\n' "${CHANGFU_RELEASE_BUILD}" >&2
  exit 1
fi

for dependency in \
  "${LONGBRIDGE_CLI}" \
  "${SDK_LIB_DIR}/libprotobuf.32.dylib" \
  "${SDK_LIB_DIR}/libssl.3.dylib" \
  "${SDK_LIB_DIR}/libcrypto.3.dylib"
do
  if [[ ! -f "${dependency}" ]]; then
    printf '[长富] 发布依赖缺失：%s\n' "${dependency}" >&2
    exit 1
  fi
done

for dependency in \
  "${LONGBRIDGE_CLI}" \
  "${SDK_LIB_DIR}/libprotobuf.32.dylib" \
  "${SDK_LIB_DIR}/libssl.3.dylib" \
  "${SDK_LIB_DIR}/libcrypto.3.dylib" \
  "${SDK_LIB_DIR}/libFTAPI.a"
do
  min_versions="$(otool -l "${dependency}" | awk '/minos/{print $2}' | sort -u)"
  if [[ -z "${min_versions}" ]]; then
    printf '[长富] 无法读取依赖最低系统版本：%s\n' "${dependency}" >&2
    exit 1
  fi
  if ! python3 - "${min_versions}" <<'PY'
import sys
versions = [tuple(map(int, item.split("."))) for item in sys.argv[1].split()]
raise SystemExit(0 if max(versions) <= (14, 0) else 1)
PY
  then
    printf '[长富] 依赖要求高于 macOS 14：%s (%s)\n' "${dependency}" "${min_versions//$'\n'/,}" >&2
    printf '[长富] 请先执行 scripts/rebuild-futu-sdk-macos14.sh\n' >&2
    exit 1
  fi
done

if [[ -d "${SWIFT_HOST_LIB}" ]]; then
  export DYLD_LIBRARY_PATH="${SWIFT_HOST_LIB}${DYLD_LIBRARY_PATH:+:${DYLD_LIBRARY_PATH}}"
fi

"${ROOT_DIR}/scripts/check-ui-contract.sh"
"${ROOT_DIR}/scripts/validate-production-config.sh"

printf '[长富] 编译 arm64 Release 产物\n'
for product in ChangFu ChangFuBrokerHost ChangFuLongbridgeHost; do
  swift build \
    --package-path "${ROOT_DIR}" \
    --disable-sandbox \
    --configuration release \
    --arch arm64 \
    --product "${product}"
done

BIN_DIR="$(swift build \
  --package-path "${ROOT_DIR}" \
  --disable-sandbox \
  --configuration release \
  --arch arm64 \
  --show-bin-path)"
DIST_DIR="${ROOT_DIR}/dist/${CHANGFU_RELEASE_VERSION}-${CHANGFU_RELEASE_BUILD}"
APP_DIR="${DIST_DIR}/长富.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
FRAMEWORKS_DIR="${CONTENTS_DIR}/Frameworks"

rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}" "${FRAMEWORKS_DIR}"
install -m 755 "${BIN_DIR}/ChangFu" "${MACOS_DIR}/ChangFu"
install -m 755 "${BIN_DIR}/ChangFuBrokerHost" "${MACOS_DIR}/ChangFuBrokerHost"
install -m 755 "${BIN_DIR}/ChangFuLongbridgeHost" "${MACOS_DIR}/ChangFuLongbridgeHost"
install -m 755 "${LONGBRIDGE_CLI}" "${MACOS_DIR}/longbridge"
install -m 755 "${SDK_LIB_DIR}/libprotobuf.32.dylib" "${FRAMEWORKS_DIR}/libprotobuf.32.dylib"
install -m 755 "${SDK_LIB_DIR}/libssl.3.dylib" "${FRAMEWORKS_DIR}/libssl.3.dylib"
install -m 755 "${SDK_LIB_DIR}/libcrypto.3.dylib" "${FRAMEWORKS_DIR}/libcrypto.3.dylib"
install -m 644 "${ROOT_DIR}/Packaging/Info.plist" "${CONTENTS_DIR}/Info.plist"

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${CHANGFU_RELEASE_VERSION}" "${CONTENTS_DIR}/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${CHANGFU_RELEASE_BUILD}" "${CONTENTS_DIR}/Info.plist"
/usr/libexec/PlistBuddy -c "Set :ChangFuPublicAPIOrigin ${CHANGFU_PUBLIC_API_ORIGIN%/}" "${CONTENTS_DIR}/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon" "${CONTENTS_DIR}/Info.plist"
"${ROOT_DIR}/scripts/build-app-icon.sh" \
  "${CHANGFU_APP_ICON_SOURCE}" \
  "${RESOURCES_DIR}/AppIcon.icns"

rewrite_dependency() {
  local binary="$1"
  local basename="$2"
  while IFS= read -r dependency; do
    [[ -n "${dependency}" ]] || continue
    install_name_tool -change "${dependency}" "@rpath/${basename}" "${binary}"
  done < <(otool -L "${binary}" | awk -v name="${basename}" '$1 ~ ("/" name "$") && $1 != ("@rpath/" name) {print $1}')
}

broker_host="${MACOS_DIR}/ChangFuBrokerHost"
rewrite_dependency "${broker_host}" "libprotobuf.32.dylib"
rewrite_dependency "${broker_host}" "libssl.3.dylib"
rewrite_dependency "${broker_host}" "libcrypto.3.dylib"
rewrite_dependency "${FRAMEWORKS_DIR}/libssl.3.dylib" "libcrypto.3.dylib"
install_name_tool -id "@rpath/libprotobuf.32.dylib" "${FRAMEWORKS_DIR}/libprotobuf.32.dylib"
install_name_tool -id "@rpath/libssl.3.dylib" "${FRAMEWORKS_DIR}/libssl.3.dylib"
install_name_tool -id "@rpath/libcrypto.3.dylib" "${FRAMEWORKS_DIR}/libcrypto.3.dylib"

strip_build_rpaths() {
  local binary="$1"
  while IFS= read -r rpath; do
    case "${rpath}" in
      /Library/Developer/CommandLineTools/*|/Users/*|*.data/*)
        install_name_tool -delete_rpath "${rpath}" "${binary}"
        ;;
    esac
  done < <(otool -l "${binary}" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | sort -u)
}

for binary in \
  "${MACOS_DIR}/ChangFu" \
  "${MACOS_DIR}/ChangFuBrokerHost" \
  "${MACOS_DIR}/ChangFuLongbridgeHost" \
  "${MACOS_DIR}/longbridge" \
  "${FRAMEWORKS_DIR}/libprotobuf.32.dylib" \
  "${FRAMEWORKS_DIR}/libssl.3.dylib" \
  "${FRAMEWORKS_DIR}/libcrypto.3.dylib"
do
  strip_build_rpaths "${binary}"
done

if ! otool -l "${broker_host}" | awk '/cmd LC_RPATH/{getline; getline; print $2}' \
  | grep -Fxq '@executable_path/../Frameworks'; then
  install_name_tool -add_rpath '@executable_path/../Frameworks' "${broker_host}"
fi

for binary in \
  "${MACOS_DIR}/ChangFu" \
  "${MACOS_DIR}/ChangFuBrokerHost" \
  "${MACOS_DIR}/ChangFuLongbridgeHost" \
  "${MACOS_DIR}/longbridge" \
  "${FRAMEWORKS_DIR}/libprotobuf.32.dylib" \
  "${FRAMEWORKS_DIR}/libssl.3.dylib" \
  "${FRAMEWORKS_DIR}/libcrypto.3.dylib"
do
  if [[ "$(lipo -archs "${binary}")" != "arm64" ]]; then
    printf '[长富] 发现非纯 arm64 产物：%s (%s)\n' "${binary}" "$(lipo -archs "${binary}")" >&2
    exit 1
  fi
  if otool -L "${binary}" | tail -n +2 | grep -Eq '/Users/|/CommandLineTools/|/\\.data/'; then
    printf '[长富] 依赖仍包含构建机路径：%s\n' "${binary}" >&2
    otool -L "${binary}" >&2
    exit 1
  fi
  if otool -l "${binary}" | tail -n +2 | grep -Eq '/Users/|/CommandLineTools/|/\\.data/'; then
    printf '[长富] RPath 仍包含构建机路径：%s\n' "${binary}" >&2
    exit 1
  fi
done

printf '[长富] Release App 已生成：%s\n' "${APP_DIR}"
