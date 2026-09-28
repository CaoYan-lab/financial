#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FINANCIAL_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
APP_DIR="${BUILD_DIR}/长富.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
FRAMEWORKS_DIR="${CONTENTS_DIR}/Frameworks"
SDK_LIB_DIR="${FINANCIAL_ROOT}/.data/changfu-sdk/third/lib"
LONGBRIDGE_CLI="${FINANCIAL_ROOT}/.tools/longbridge/longbridge"
SWIFT_HOST_LIB="/Library/Developer/CommandLineTools/usr/lib/swift/host/compiler"

if [[ -d "${SWIFT_HOST_LIB}" ]]; then
  export DYLD_LIBRARY_PATH="${SWIFT_HOST_LIB}${DYLD_LIBRARY_PATH:+:${DYLD_LIBRARY_PATH}}"
fi

if [[ "${CHANGFU_SKIP_BACKEND:-0}" != "1" ]]; then
  "${FINANCIAL_ROOT}/changfu-backend/scripts/run-local.sh"
fi

"${ROOT_DIR}/scripts/check-ui-contract.sh"

printf '[长富] 编译 macOS 客户端与 BrokerHost\n'
swift build \
  --package-path "${ROOT_DIR}" \
  --disable-sandbox \
  --configuration debug \
  --product ChangFu
swift build \
  --package-path "${ROOT_DIR}" \
  --disable-sandbox \
  --configuration debug \
  --product ChangFuBrokerHost
swift build \
  --package-path "${ROOT_DIR}" \
  --disable-sandbox \
  --configuration debug \
  --product ChangFuLongbridgeHost

BIN_DIR="$(swift build \
  --package-path "${ROOT_DIR}" \
  --disable-sandbox \
  --configuration debug \
  --show-bin-path)"

printf '[长富] 生成本地应用包：%s\n' "${APP_DIR}"
rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}" "${FRAMEWORKS_DIR}"
cp "${BIN_DIR}/ChangFu" "${MACOS_DIR}/ChangFu"
cp "${BIN_DIR}/ChangFuBrokerHost" "${MACOS_DIR}/ChangFuBrokerHost"
cp "${BIN_DIR}/ChangFuLongbridgeHost" "${MACOS_DIR}/ChangFuLongbridgeHost"
if [[ ! -x "${LONGBRIDGE_CLI}" ]]; then
  printf '[长富] Longbridge CLI 不可执行：%s\n' "${LONGBRIDGE_CLI}" >&2
  exit 1
fi
cp "${LONGBRIDGE_CLI}" "${MACOS_DIR}/longbridge"
cp -L "${SDK_LIB_DIR}/libprotobuf.32.dylib" "${FRAMEWORKS_DIR}/libprotobuf.32.dylib"
cp -L "${SDK_LIB_DIR}/libssl.3.dylib" "${FRAMEWORKS_DIR}/libssl.3.dylib"
cp -L "${SDK_LIB_DIR}/libcrypto.3.dylib" "${FRAMEWORKS_DIR}/libcrypto.3.dylib"
cp "${ROOT_DIR}/Packaging/Info.plist" "${CONTENTS_DIR}/Info.plist"
if [[ "${CHANGFU_RELEASE_BUILD:-0}" == "1" ]]; then
  "${ROOT_DIR}/scripts/validate-production-config.sh"
  /usr/libexec/PlistBuddy \
    -c "Set :ChangFuPublicAPIOrigin ${CHANGFU_PUBLIC_API_ORIGIN}" \
    "${CONTENTS_DIR}/Info.plist"
fi

OPENSSL_PREFIX="${FINANCIAL_ROOT}/.data/changfu-sdk/build-src/openssl-3.0.17/../../third/lib"
install_name_tool \
  -change "${OPENSSL_PREFIX}/libssl.3.dylib" "@rpath/libssl.3.dylib" \
  -change "${OPENSSL_PREFIX}/libcrypto.3.dylib" "@rpath/libcrypto.3.dylib" \
  -add_rpath "@executable_path/../Frameworks" \
  "${MACOS_DIR}/ChangFuBrokerHost"
install_name_tool \
  -id "@rpath/libssl.3.dylib" \
  -change "${OPENSSL_PREFIX}/libcrypto.3.dylib" "@rpath/libcrypto.3.dylib" \
  "${FRAMEWORKS_DIR}/libssl.3.dylib"
install_name_tool \
  -id "@rpath/libcrypto.3.dylib" \
  "${FRAMEWORKS_DIR}/libcrypto.3.dylib"

printf '[长富] 执行本地临时签名\n'
codesign --force --deep --sign - "${APP_DIR}"

printf '[长富] 启动客户端\n'
open "${APP_DIR}"
printf '[长富] 已启动：%s\n' "${APP_DIR}"
