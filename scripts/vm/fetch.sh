#!/bin/sh
# Downloads the pinned inputs for the VM backend (docs/design.md §3.6) into
# ${ENVGIT_VM_DIR:-~/.cache/envgit/vm}/downloads and verifies their SHA-256.
set -eu

ROOT="${ENVGIT_VM_DIR:-$HOME/.cache/envgit/vm}"
DL="$ROOT/downloads"
mkdir -p "$DL"

# arm64 (macOS, Linux) and x86_64 (Linux); ENVGIT_VM_ARCH overrides the machine's.
ARCH="${ENVGIT_VM_ARCH:-$(uname -m)}"
case "$ARCH" in arm64|aarch64) ARCH=aarch64 ;; x86_64|amd64) ARCH=x86_64 ;; *) echo "no vm backend for $ARCH" >&2; exit 1 ;; esac
FC_CI="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261023-dd7c24b0d165-0/$ARCH"
NOBLE="https://cloud-images.ubuntu.com/releases/noble/release-20260926"

# name|url|sha256. Each checksum is the one its publisher gives (Firecracker's .sha256.txt, Ubuntu's
# SHA256SUMS and signed apt index, Node's SHASUMS256.txt), except the Firecracker CI kernels: that
# bucket publishes none, so theirs were taken from a download over HTTPS (x86_64: the same hash from
# two machines) and only pin the file, they do not vouch for it.
if [ "$ARCH" = aarch64 ]; then FILES="
ubuntu-vmlinuz-generic|https://cloud-images.ubuntu.com/releases/noble/release/unpacked/ubuntu-24.04-server-cloudimg-arm64-vmlinuz-generic|353bab8eeaad9caf931dd85fd7a7bf8800d2669d759c0369ffaba7abc03a7aff
linux-modules-6.8.0-147-generic_arm64.deb|http://ports.ubuntu.com/ubuntu-ports/pool/main/l/linux/linux-modules-6.8.0-147-generic_6.8.0-147.147_arm64.deb|239a4875906964ce805eede85ac2a7ee8785c38eba307a5861f99ca52d7d7b6d
firecracker-v1.17.0-aarch64.tgz|https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-aarch64.tgz|e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256
vmlinux-6.18.54|$FC_CI/vmlinux-6.18.54|e1db1d63d5e141bd65813600c9045c84d12ad5c9e8bfac09429425144a684263
ubuntu-24.04-server-cloudimg-arm64-20260926.squashfs|$NOBLE/ubuntu-24.04-server-cloudimg-arm64.squashfs|41bd7ede9d97d14ab925836f653a2657d089505ed229cecafb0c4c78a7ebbc0a
node-v24.21.0-linux-arm64.tar.xz|https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz|6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
ripgrep_14.1.0-1_arm64.deb|http://ports.ubuntu.com/ubuntu-ports/pool/universe/r/rust-ripgrep/ripgrep_14.1.0-1_arm64.deb|71fe8a5667bc87d2bca175a3426c6ec518e0679cc821d23ae7056de7096f04de
"; else FILES="
firecracker-v1.17.0-x86_64.tgz|https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-x86_64.tgz|06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
vmlinux-6.18.54|$FC_CI/vmlinux-6.18.54|da5e0041fb31fcc7337026da9e2b64fb7694b4eed760cc9b5e8fe54e52fa8188
ubuntu-24.04-server-cloudimg-amd64-20260926.squashfs|$NOBLE/ubuntu-24.04-server-cloudimg-amd64.squashfs|09b828ec72127a070dcf158616554102a65bb0ebf49219a8d8f8bc7a83d29a25
node-v24.21.0-linux-x64.tar.xz|https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz|fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ripgrep_14.1.0-1_amd64.deb|http://archive.ubuntu.com/ubuntu/pool/universe/r/rust-ripgrep/ripgrep_14.1.0-1_amd64.deb|c5ae63c7bee915b1cfc9f0bd07c55b4ce7f2bcd1133cba4da56719aac26101a4
"; fi

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
