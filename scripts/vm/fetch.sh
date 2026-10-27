#!/bin/sh
# Downloads the pinned inputs for the VM backend (docs/design.md §3.6) into
# ${ENVGIT_VM_DIR:-~/.cache/envgit/vm}/downloads and verifies their SHA-256.
set -eu

ROOT="${ENVGIT_VM_DIR:-$HOME/.cache/envgit/vm}"
DL="$ROOT/downloads"
mkdir -p "$DL"

FC_CI="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261023-dd7c24b0d165-0/aarch64"
NOBLE="https://cloud-images.ubuntu.com/releases/noble/release-20260926"

# name|url|sha256
FILES="
ubuntu-vmlinuz-generic|https://cloud-images.ubuntu.com/releases/noble/release/unpacked/ubuntu-24.04-server-cloudimg-arm64-vmlinuz-generic|353bab8eeaad9caf931dd85fd7a7bf8800d2669d759c0369ffaba7abc03a7aff
linux-modules-6.8.0-147-generic_arm64.deb|http://ports.ubuntu.com/ubuntu-ports/pool/main/l/linux/linux-modules-6.8.0-147-generic_6.8.0-147.147_arm64.deb|239a4875906964ce805eede85ac2a7ee8785c38eba307a5861f99ca52d7d7b6d
firecracker-v1.17.0-aarch64.tgz|https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-aarch64.tgz|e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256
vmlinux-6.18.54|$FC_CI/vmlinux-6.18.54|e1db1d63d5e141bd65813600c9045c84d12ad5c9e8bfac09429425144a684263
ubuntu-24.04-server-cloudimg-arm64-20260926.squashfs|$NOBLE/ubuntu-24.04-server-cloudimg-arm64.squashfs|41bd7ede9d97d14ab925836f653a2657d089505ed229cecafb0c4c78a7ebbc0a
node-v24.21.0-linux-arm64.tar.xz|https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz|6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
"

# The L1 kernel and its modules are only needed on macOS, where L1 is a VM; on Linux the host is L1.
L1_ONLY="ubuntu-vmlinuz-generic linux-modules-6.8.0-147-generic_arm64.deb"
check() { if command -v shasum >/dev/null; then shasum -a 256 -c - >/dev/null 2>&1; else sha256sum -c - >/dev/null 2>&1; fi; }

echo "$FILES" | while IFS='|' read -r name url sum; do
  [ -n "$name" ] || continue
  if [ "$(uname -s)" = Linux ]; then case " $L1_ONLY " in *" $name "*) continue ;; esac; fi
  url=$(eval echo "$url")
  dst="$DL/$name"
  if [ -f "$dst" ] && echo "$sum  $dst" | check; then
    echo "ok       $name"
    continue
  fi
  echo "fetching $name"
  curl -fsSL -o "$dst.part" "$url"
  echo "$sum  $dst.part" | check || { echo "checksum mismatch: $name" >&2; rm -f "$dst.part"; exit 1; }
  mv "$dst.part" "$dst"
done
