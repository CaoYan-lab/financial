#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s <1024x1024.png> <AppIcon.icns>\n' "$0" >&2
  exit 64
fi

SOURCE_PNG="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUTPUT_ICNS="$2"

if [[ ! -f "${SOURCE_PNG}" ]]; then
  printf '[长富] 图标源文件不存在：%s\n' "${SOURCE_PNG}" >&2
  exit 1
fi

dimensions="$(sips -g pixelWidth -g pixelHeight "${SOURCE_PNG}" 2>/dev/null)"
width="$(awk '/pixelWidth:/{print $2}' <<<"${dimensions}")"
height="$(awk '/pixelHeight:/{print $2}' <<<"${dimensions}")"
if [[ "${width}" != "1024" || "${height}" != "1024" ]]; then
  printf '[长富] 图标必须是 1024x1024 PNG，实际为 %sx%s\n' "${width:-?}" "${height:-?}" >&2
  exit 1
fi

if [[ "$(file -b "${SOURCE_PNG}")" != *"PNG image data"* ]]; then
  printf '[长富] 图标源文件不是 PNG：%s\n' "${SOURCE_PNG}" >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/changfu-icon.XXXXXX")"
trap 'rm -rf "${work_dir}"' EXIT
iconset="${work_dir}/AppIcon.iconset"
mkdir -p "${iconset}" "$(dirname "${OUTPUT_ICNS}")"

while read -r filename size; do
  sips -z "${size}" "${size}" "${SOURCE_PNG}" \
    --out "${iconset}/${filename}" >/dev/null
done <<'SIZES'
icon_16x16.png 16
icon_16x16@2x.png 32
icon_32x32.png 32
icon_32x32@2x.png 64
icon_128x128.png 128
icon_128x128@2x.png 256
icon_256x256.png 256
icon_256x256@2x.png 512
icon_512x512.png 512
icon_512x512@2x.png 1024
SIZES

iconutil -c icns "${iconset}" -o "${OUTPUT_ICNS}"
if [[ ! -s "${OUTPUT_ICNS}" ]]; then
  printf '[长富] AppIcon.icns 生成失败\n' >&2
  exit 1
fi

printf '[长富] App 图标已生成：%s\n' "${OUTPUT_ICNS}"
