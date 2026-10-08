#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FINANCIAL_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
SDK_ROOT="${FINANCIAL_ROOT}/.data/changfu-sdk"
PROTOBUF_SOURCE="${SDK_ROOT}/build-src/protobuf-3.21.5"
OPENSSL_SOURCE="${SDK_ROOT}/build-src/openssl-3.0.17"
FTAPI_SOURCE="${SDK_ROOT}/FTAPI4CPP_10.10.7008"
CMAKE="${SDK_ROOT}/tooling/bin/cmake"
TARGET_PREFIX="${SDK_ROOT}/third"
STAGE_PREFIX="${SDK_ROOT}/third-macos14-stage"
PROTOBUF_BUILD="${SDK_ROOT}/build-src/protobuf-build-macos14"
OPENSSL_BUILD="${SDK_ROOT}/build-src/openssl-build-macos14"
FTAPI_BUILD="${SDK_ROOT}/ftapi-build-macos14"
DEPLOYMENT_TARGET="14.0"
jobs="$(sysctl -n hw.logicalcpu 2>/dev/null || printf 4)"

for path in "${CMAKE}" "${PROTOBUF_SOURCE}/CMakeLists.txt" \
  "${OPENSSL_SOURCE}/Configure" "${FTAPI_SOURCE}/CMakeLists.txt"; do
  if [[ ! -e "${path}" ]]; then
    printf '[长富] SDK 重建输入缺失：%s\n' "${path}" >&2
    exit 1
  fi
done

rm -rf "${STAGE_PREFIX}" "${PROTOBUF_BUILD}" "${OPENSSL_BUILD}" "${FTAPI_BUILD}"
mkdir -p "${STAGE_PREFIX}" "${OPENSSL_BUILD}"

printf '[长富] 重建 protobuf（macOS %s / arm64）\n' "${DEPLOYMENT_TARGET}"
"${CMAKE}" \
  -S "${PROTOBUF_SOURCE}" \
  -B "${PROTOBUF_BUILD}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" \
  -DCMAKE_INSTALL_PREFIX="${STAGE_PREFIX}" \
  -Dprotobuf_BUILD_TESTS=OFF \
  -Dprotobuf_BUILD_EXAMPLES=OFF \
  -Dprotobuf_BUILD_CONFORMANCE=OFF \
  -Dprotobuf_BUILD_SHARED_LIBS=ON \
  -Dprotobuf_BUILD_LIBPROTOC=OFF \
  -Dprotobuf_BUILD_PROTOC_BINARIES=OFF
"${CMAKE}" --build "${PROTOBUF_BUILD}" --parallel "${jobs}"
"${CMAKE}" --install "${PROTOBUF_BUILD}"

printf '[长富] 重建 OpenSSL（macOS %s / arm64）\n' "${DEPLOYMENT_TARGET}"
(
  cd "${OPENSSL_SOURCE}"
  make distclean >/dev/null 2>&1 || true
)
(
  cd "${OPENSSL_BUILD}"
  MACOSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" \
    "${OPENSSL_SOURCE}/Configure" \
      darwin64-arm64-cc \
      shared \
      no-tests \
      "--prefix=${STAGE_PREFIX}" \
      "--openssldir=${STAGE_PREFIX}/ssl" \
      "-mmacosx-version-min=${DEPLOYMENT_TARGET}"
  make -j"${jobs}"
  make install_sw
)

printf '[长富] 重建 Futu FTAPI（macOS %s / arm64）\n' "${DEPLOYMENT_TARGET}"
"${CMAKE}" \
  -S "${FTAPI_SOURCE}" \
  -B "${FTAPI_BUILD}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" \
  -DCMAKE_INSTALL_PREFIX="${STAGE_PREFIX}" \
  -DAPI_GEN_PROTO=OFF \
  -DAPI_BUILD_EXAMPLE=OFF \
  -DAPI_THIRD_LIB_DIR="${STAGE_PREFIX}"
"${CMAKE}" --build "${FTAPI_BUILD}" --parallel "${jobs}"
"${CMAKE}" --install "${FTAPI_BUILD}"

for file in \
  "${STAGE_PREFIX}/lib/libprotobuf.3.21.5.0.dylib" \
  "${STAGE_PREFIX}/lib/libssl.3.dylib" \
  "${STAGE_PREFIX}/lib/libcrypto.3.dylib" \
  "${STAGE_PREFIX}/lib/libFTAPI.a"
do
  if [[ ! -f "${file}" ]]; then
    printf '[长富] SDK 重建产物缺失：%s\n' "${file}" >&2
    exit 1
  fi
done

mkdir -p "${TARGET_PREFIX}/include" "${TARGET_PREFIX}/lib"
ditto "${STAGE_PREFIX}/include" "${TARGET_PREFIX}/include"
install -m 755 "${STAGE_PREFIX}/lib/libprotobuf.3.21.5.0.dylib" \
  "${TARGET_PREFIX}/lib/libprotobuf.3.21.5.0.dylib"
ln -sfn libprotobuf.3.21.5.0.dylib "${TARGET_PREFIX}/lib/libprotobuf.32.dylib"
ln -sfn libprotobuf.32.dylib "${TARGET_PREFIX}/lib/libprotobuf.dylib"
install -m 755 "${STAGE_PREFIX}/lib/libssl.3.dylib" "${TARGET_PREFIX}/lib/libssl.3.dylib"
install -m 755 "${STAGE_PREFIX}/lib/libcrypto.3.dylib" "${TARGET_PREFIX}/lib/libcrypto.3.dylib"
ln -sfn libssl.3.dylib "${TARGET_PREFIX}/lib/libssl.dylib"
ln -sfn libcrypto.3.dylib "${TARGET_PREFIX}/lib/libcrypto.dylib"
install -m 644 "${STAGE_PREFIX}/lib/libFTAPI.a" "${TARGET_PREFIX}/lib/libFTAPI.a"

for file in \
  "${TARGET_PREFIX}/lib/libprotobuf.32.dylib" \
  "${TARGET_PREFIX}/lib/libssl.3.dylib" \
  "${TARGET_PREFIX}/lib/libcrypto.3.dylib" \
  "${TARGET_PREFIX}/lib/libFTAPI.a"
do
  versions="$(otool -l "${file}" | awk '/minos/{print $2}' | sort -u)"
  if [[ -z "${versions}" ]] || ! python3 - "${versions}" <<'PY'
import sys
versions = [tuple(map(int, item.split("."))) for item in sys.argv[1].split()]
raise SystemExit(0 if max(versions) <= (14, 0) else 1)
PY
  then
    printf '[长富] SDK 最低系统版本检查失败：%s (%s)\n' "${file}" "${versions:-unknown}" >&2
    exit 1
  fi
done

printf '[长富] Futu SDK 已重建为 macOS %s / arm64：%s\n' \
  "${DEPLOYMENT_TARGET}" "${TARGET_PREFIX}"
