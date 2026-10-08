#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <长富.app>\n' "$0" >&2
  exit 64
fi

APP_DIR="$1"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
FRAMEWORKS_DIR="${CONTENTS_DIR}/Frameworks"

if [[ ! -d "${APP_DIR}" ]]; then
  printf '[长富] App Bundle 不存在：%s\n' "${APP_DIR}" >&2
  exit 1
fi

sign_one() {
  local path="$1"
  codesign --force --sign - --timestamp=none "${path}"
}

printf '[长富] 逐层执行 ad-hoc 签名\n'
for dylib in \
  "${FRAMEWORKS_DIR}/libprotobuf.32.dylib" \
  "${FRAMEWORKS_DIR}/libcrypto.3.dylib" \
  "${FRAMEWORKS_DIR}/libssl.3.dylib"
do
  sign_one "${dylib}"
done

sign_one "${MACOS_DIR}/longbridge"
sign_one "${MACOS_DIR}/ChangFuBrokerHost"
sign_one "${MACOS_DIR}/ChangFuLongbridgeHost"
sign_one "${MACOS_DIR}/ChangFu"
sign_one "${APP_DIR}"

codesign --verify --deep --strict --verbose=2 "${APP_DIR}"
printf '[长富] ad-hoc 签名验证通过：%s\n' "${APP_DIR}"
