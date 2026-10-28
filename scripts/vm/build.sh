#!/bin/sh
# Builds the VM backend artifacts (docs/design.md §3.6) from the pinned downloads.
#
# macOS (nested: envgit-vm boots L1, L1 runs Firecracker):
#   build/envgit-vm         Swift helper (Virtualization.framework), ad-hoc signed
#   build/Image             L1 kernel (Ubuntu generic, uncompressed)
#   build/l1-initrd.cpio    L1 supervisor + Firecracker + L2 kernel/initrd + vsock/virtiofs modules
# Linux (arm64 or x86_64; the supervisor runs on the host and Firecracker uses the host's KVM directly):
#   build/envgit-supervisor the same supervisor, in host mode
#   build/fc/               firecracker, rebase-snap, L2 kernel (vmlinux) and initrd
# Both:
#   build/rootfs.squashfs   L2's root: Ubuntu 24.04 server cloud image (git, python3, curl, ...)
#   build/layer.squashfs    Node and ripgrep (agents such as Codex search with rg), overlaid on the root under /usr/local
#   build/image-stamp       hash of the two images; a session only resumes on the image it began on
#   build/stamp             hash of everything above; a VM started from another build is restarted
#   build/base/             prebuilt full snapshot of a warmed-up guest; new sessions restore it
#
#   scripts/vm/build.sh                       build for this machine
#   scripts/vm/build.sh --linux-layout DIR    (macOS) also lay out a Linux build in DIR/build from
#                                             this one, for scripts/vm/linux-test.sh; its base
#                                             snapshot is made inside the test VM
#   scripts/vm/build.sh --guest-only ARCH DIR write the guest side (supervisor, L2 init and initrd)
#                                             for ARCH (aarch64, x86_64) to DIR; a Linux machine
#                                             without Go or cpio builds with ENVGIT_VM_GUEST_DIR=DIR
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT="${ENVGIT_VM_DIR:-$HOME/.cache/envgit/vm}"
DL="$ROOT/downloads"
OUT="$ROOT/build"
WORK="$ROOT/work"
KVER=6.8.0-147-generic
OS=$(uname -s)
[ "$OS" = Darwin ] || [ "$OS" = Linux ] || { echo "unsupported OS: $OS" >&2; exit 1; }
arch() { case "$1" in arm64|aarch64) echo aarch64 ;; x86_64|amd64) echo x86_64 ;; *) echo "no vm backend for $1" >&2; exit 1 ;; esac; }
ARCH=$(arch "$(uname -m)")
LINUX_LAYOUT=""
GUEST_ONLY=""
case "${1:-}" in
  --linux-layout) LINUX_LAYOUT="${2:?--linux-layout needs a directory}" ;;
  --guest-only) ARCH=$(arch "${2:?--guest-only needs an arch}"); GUEST_ONLY="${3:?--guest-only needs a directory}" ;;
esac
[ "$OS" = Linux ] || [ "$ARCH" = aarch64 ] || [ -n "$GUEST_ONLY" ] || { echo "the macOS backend is arm64 only" >&2; exit 1; }
if [ "$ARCH" = aarch64 ]; then GOARCH=arm64 DEB=arm64 NODE=arm64; else GOARCH=amd64 DEB=amd64 NODE=x64; fi
NODE_TAR=node-v24.21.0-linux-$NODE.tar.xz
RG_DEB=ripgrep_14.1.0-1_$DEB.deb
FC=release-v1.17.0-$ARCH
# A checkout builds its envgit first; an installed package (npm) ships dist/ built.
envgit_build() { [ ! -d "$REPO/src" ] || (cd "$REPO" && npm run build >/dev/null); }
sha() { if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi; }
stamp() { (cd "$1" && shift && cat "$@" | sha | cut -c1-16); }
clone() { if [ "$OS" = Darwin ]; then cp -c "$1" "$2"; else cp --reflink=auto "$1" "$2"; fi; }

mkdir -p "$WORK"
# The guest side: the supervisor (L1's init on macOS, a host process on Linux) and L2's init + initrd.
guest() {
  (cd "$REPO/vm/guest" && GOOS=linux GOARCH=$GOARCH CGO_ENABLED=0 go build -ldflags="-s -w" -o "$1/l1-init" ./cmd/l1 \
    && GOOS=linux GOARCH=$GOARCH CGO_ENABLED=0 go build -ldflags="-s -w" -o "$1/l2-init" ./cmd/l2)
  rm -rf "$WORK/l2root" && mkdir -p "$WORK/l2root/dev" "$WORK/l2root/proc" "$WORK/l2root/sys" "$WORK/l2root/ro" "$WORK/l2root/rw" "$WORK/l2root/newroot"
  cp "$1/l2-init" "$WORK/l2root/init"
  (cd "$WORK/l2root" && find . | cpio -o -H newc 2>/dev/null) > "$1/l2-initrd.cpio"
}
if [ -n "$GUEST_ONLY" ]; then
  mkdir -p "$GUEST_ONLY" && guest "$GUEST_ONLY" && ls -l "$GUEST_ONLY"
  exit 0
fi

ENVGIT_VM_ARCH=$ARCH "$HERE/fetch.sh"
mkdir -p "$OUT"

echo "guest binaries"
if [ -n "${ENVGIT_VM_GUEST_DIR:-}" ]; then
  for f in l1-init l2-init l2-initrd.cpio; do cp "$ENVGIT_VM_GUEST_DIR/$f" "$WORK/$f"; done
else
  guest "$WORK"
fi

rm -rf "$WORK/fc" && mkdir -p "$WORK/fc" && tar -xzf "$DL/firecracker-v1.17.0-$ARCH.tgz" -C "$WORK/fc"
# Firecracker's side, in the layout the supervisor's --fc expects (L1 has it at /fc).
fcdir() {
  rm -rf "$1" && mkdir -p "$1"
  cp "$WORK/fc/$FC/firecracker-v1.17.0-$ARCH" "$1/firecracker"
  cp "$WORK/fc/$FC/rebase-snap-v1.17.0-$ARCH" "$1/rebase-snap"
  cp "$DL/vmlinux-6.18.54" "$1/vmlinux"
  cp "$WORK/l2-initrd.cpio" "$1/l2-initrd.cpio"
}
# A Linux build's files in $1: supervisor, fc/, and the stamp over them and the images.
linux_bits() {
  cp "$WORK/l1-init" "$1/envgit-supervisor"
  fcdir "$1/fc"
}
linux_stamp() { stamp "$1" envgit-supervisor fc/firecracker fc/rebase-snap fc/vmlinux fc/l2-initrd.cpio image-stamp > "$1/stamp"; }

if [ "$OS" = Darwin ]; then
  echo "swift helper"
  swiftc -O -o "$OUT/envgit-vm" "$REPO/vm/helper/envgit-vm.swift"
  codesign -f -s - --entitlements "$REPO/vm/helper/envgit-vm.entitlements" "$OUT/envgit-vm"

  echo "L1 kernel"
  gunzip -c "$DL/ubuntu-vmlinuz-generic" > "$OUT/Image"

  echo "vsock + virtiofs modules"
  rm -rf "$WORK/deb" && mkdir -p "$WORK/deb" && (cd "$WORK/deb" && ar x "$DL/linux-modules-${KVER}_arm64.deb" \
    && tar -xf data.tar "./lib/modules/$KVER/kernel/net/vmw_vsock/vsock.ko.zst" \
       "./lib/modules/$KVER/kernel/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
       "./lib/modules/$KVER/kernel/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
       "./lib/modules/$KVER/kernel/fs/fuse/virtiofs.ko.zst")

  echo "L1 initrd"
  rm -rf "$WORK/l1root" && mkdir -p "$WORK/l1root/modules" "$WORK/l1root/dev" "$WORK/l1root/proc" "$WORK/l1root/sys" "$WORK/l1root/tmp"
  cp "$WORK/l1-init" "$WORK/l1root/init"
  fcdir "$WORK/l1root/fc"
  for m in net/vmw_vsock/vsock net/vmw_vsock/vmw_vsock_virtio_transport_common net/vmw_vsock/vmw_vsock_virtio_transport fs/fuse/virtiofs; do
    zstd -qdf "$WORK/deb/lib/modules/$KVER/kernel/$m.ko.zst" -o "$WORK/l1root/modules/$(basename $m).ko"
  done
  (cd "$WORK/l1root" && find . | cpio -o -H newc 2>/dev/null) > "$OUT/l1-initrd.cpio"
else
  echo "supervisor + firecracker"
  linux_bits "$OUT"
fi

echo "L2 images"
# Attached as disks rather than packed into the initrd, so they are read on demand, not loaded into RAM.
clone "$DL/ubuntu-24.04-server-cloudimg-$DEB-20260926.squashfs" "$OUT/rootfs.squashfs.part" && mv "$OUT/rootfs.squashfs.part" "$OUT/rootfs.squashfs"
LAYER_KEY=$( (cat "$OUT/rootfs.squashfs" "$DL/$NODE_TAR" "$DL/$RG_DEB"; echo layer-v2) | sha | cut -c1-16)
# rg from the pinned noble deb (the guest is noble too): dpkg-deb where there is one (GNU tar needs
# the zstd binary for its data.tar.zst), else bsdtar (macOS), which reads zstd itself.
rm -rf "$WORK/rg" && mkdir -p "$WORK/rg"
if command -v dpkg-deb >/dev/null; then dpkg-deb -x "$DL/$RG_DEB" "$WORK/rg"; else (cd "$WORK/rg" && ar x "$DL/$RG_DEB" && tar -xf data.tar.* ./usr/bin/rg); fi
if [ "$(cat "$WORK/layer.key" 2>/dev/null)" = "$LAYER_KEY" ] && [ -s "$OUT/layer.squashfs" ]; then
  echo "ok       layer.squashfs"
elif [ "$OS" = Linux ]; then
  command -v mksquashfs >/dev/null || { echo "mksquashfs not found: install squashfs-tools" >&2; exit 1; }
  echo "building layer.squashfs"
  S="$WORK/layer-src" && rm -rf "$S" && mkdir -p "$S/usr/local"
  tar -xJf "$DL/$NODE_TAR" -C "$S/usr/local" --strip-components 1
  rm -f "$S/usr/local/CHANGELOG.md" "$S/usr/local/README.md"
  install -m 755 "$WORK/rg/usr/bin/rg" "$S/usr/local/bin/rg"
  mksquashfs "$S" "$OUT/layer.squashfs" -comp gzip -all-root -noappend -quiet
  rm -rf "$S"
  echo "$LAYER_KEY" > "$WORK/layer.key"
else
  # macOS has no mksquashfs, but the rootfs does: boot it bare (an empty layer) in a throwaway workdir
  # and let L2 pack Node, with every file owned by root.
  echo "building layer.squashfs in the VM"
  : > "$OUT/layer.squashfs" && dd if=/dev/zero of="$OUT/layer.squashfs" bs=4096 count=1 2>/dev/null
  stamp "$OUT" envgit-vm Image l1-initrd.cpio > "$OUT/stamp"
  BOOT="$WORK/layer-build" && rm -rf "$BOOT" && mkdir -p "$BOOT"
  cp "$DL/$NODE_TAR" "$BOOT/node.tar.xz"
  cp "$WORK/rg/usr/bin/rg" "$BOOT/rg"
  envgit() { (cd "$BOOT" && node "$REPO/dist/cli/index.js" "$@"); }
  envgit_build  # the bootstrap VM is started by this envgit
  envgit init >/dev/null && echo 'backend: vm' > "$BOOT/.envgit/policy.yaml"
  envgit vm up --new
  if envgit run sh -c 'set -e; mkdir -p s/usr/local; tar -xJf node.tar.xz -C s/usr/local --strip-components 1;
      rm -f s/usr/local/CHANGELOG.md s/usr/local/README.md node.tar.xz;
      install -m 755 rg s/usr/local/bin/rg; rm rg;
      mksquashfs s layer.squashfs -comp gzip -all-root -noappend -quiet; rm -rf s'; then ok=1; else ok=0; fi
  envgit vm down >/dev/null || true
  [ "$ok" = 1 ] && [ -s "$BOOT/layer.squashfs" ] || { echo "layer build failed" >&2; exit 1; }
  mv "$BOOT/layer.squashfs" "$OUT/layer.squashfs"
  echo "$LAYER_KEY" > "$WORK/layer.key"
  rm -rf "$BOOT"
fi
stamp "$OUT" rootfs.squashfs layer.squashfs > "$OUT/image-stamp"
if [ "$OS" = Darwin ]; then stamp "$OUT" envgit-vm Image l1-initrd.cpio image-stamp > "$OUT/stamp"; else linux_stamp "$OUT"; fi

# A cold-booted L2 pays ≈ 250 µs for every page it touches first, a restored one far less: boot one
# guest here, let it run node/python/git once, and keep its full snapshot for new sessions to restore.
if [ "$(cat "$OUT/base/stamp" 2>/dev/null)" = "$(cat "$OUT/stamp")" ]; then
  echo "ok       base snapshot"
else
  echo "building the prebuilt base snapshot"
  rm -rf "$OUT/base"
  BOOT="$WORK/base-build" && rm -rf "$BOOT" && mkdir -p "$BOOT"
  envgit_build
  (cd "$BOOT" && node "$REPO/dist/cli/index.js" init >/dev/null && echo 'backend: vm' > .envgit/policy.yaml \
    && node "$REPO/dist/cli/index.js" vm prebuild "$OUT/base.part") || { echo "base snapshot failed" >&2; exit 1; }
  mv "$OUT/base.part" "$OUT/base"
  rm -rf "$BOOT"
fi

if [ -n "$LINUX_LAYOUT" ]; then
  echo "Linux layout in $LINUX_LAYOUT/build"
  L="$LINUX_LAYOUT/build" && mkdir -p "$L"
  linux_bits "$L"
  for f in rootfs.squashfs layer.squashfs image-stamp; do rm -f "$L/$f"; clone "$OUT/$f" "$L/$f"; done
  linux_stamp "$L"
fi
ls -la "$OUT" "$OUT/base"
