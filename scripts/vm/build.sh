#!/bin/sh
# Builds the VM backend artifacts (docs/design.md §3.6) from the pinned downloads:
#   build/envgit-vm         Swift helper (Virtualization.framework), ad-hoc signed
#   build/Image             L1 kernel (Ubuntu generic, uncompressed)
#   build/l1-initrd.cpio    L1 supervisor + Firecracker + L2 kernel/rootfs/initrd + vsock/virtiofs modules
#   build/stamp             hash of the three above; a VM booted from another build is restarted
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT="${ENVGIT_VM_DIR:-$HOME/.cache/envgit/vm}"
DL="$ROOT/downloads"
OUT="$ROOT/build"
WORK="$ROOT/work"
KVER=6.8.0-147-generic

"$HERE/fetch.sh"
mkdir -p "$OUT" "$WORK"

echo "swift helper"
swiftc -O -o "$OUT/envgit-vm" "$REPO/vm/helper/envgit-vm.swift"
codesign -f -s - --entitlements "$REPO/vm/helper/envgit-vm.entitlements" "$OUT/envgit-vm"

echo "L1 kernel"
gunzip -c "$DL/ubuntu-vmlinuz-generic" > "$OUT/Image"

echo "guest binaries"
(cd "$REPO/vm/guest" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o "$WORK/l1-init" ./cmd/l1 \
  && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o "$WORK/l2-init" ./cmd/l2)

echo "L2 initrd"
rm -rf "$WORK/l2root" && mkdir -p "$WORK/l2root/dev" "$WORK/l2root/proc" "$WORK/l2root/sys" "$WORK/l2root/ro" "$WORK/l2root/rw" "$WORK/l2root/newroot"
cp "$WORK/l2-init" "$WORK/l2root/init"
(cd "$WORK/l2root" && find . | cpio -o -H newc 2>/dev/null) > "$WORK/l2-initrd.cpio"

echo "vsock + virtiofs modules"
rm -rf "$WORK/deb" && mkdir -p "$WORK/deb" && (cd "$WORK/deb" && ar x "$DL/linux-modules-${KVER}_arm64.deb" \
  && tar -xf data.tar "./lib/modules/$KVER/kernel/net/vmw_vsock/vsock.ko.zst" \
     "./lib/modules/$KVER/kernel/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
     "./lib/modules/$KVER/kernel/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
     "./lib/modules/$KVER/kernel/fs/fuse/virtiofs.ko.zst")

echo "L1 initrd"
rm -rf "$WORK/l1root" && mkdir -p "$WORK/l1root/fc" "$WORK/l1root/modules" "$WORK/l1root/dev" "$WORK/l1root/proc" "$WORK/l1root/sys" "$WORK/l1root/tmp"
cp "$WORK/l1-init" "$WORK/l1root/init"
rm -rf "$WORK/fc" && mkdir -p "$WORK/fc" && tar -xzf "$DL/firecracker-v1.17.0-aarch64.tgz" -C "$WORK/fc"
cp "$WORK/fc/release-v1.17.0-aarch64/firecracker-v1.17.0-aarch64" "$WORK/l1root/fc/firecracker"
cp "$WORK/fc/release-v1.17.0-aarch64/rebase-snap-v1.17.0-aarch64" "$WORK/l1root/fc/rebase-snap"
cp "$DL/vmlinux-6.18.54" "$WORK/l1root/fc/vmlinux"
cp "$DL/ubuntu-24.04.squashfs" "$WORK/l1root/fc/rootfs.squashfs"
cp "$WORK/l2-initrd.cpio" "$WORK/l1root/fc/l2-initrd.cpio"
for m in net/vmw_vsock/vsock net/vmw_vsock/vmw_vsock_virtio_transport_common net/vmw_vsock/vmw_vsock_virtio_transport fs/fuse/virtiofs; do
  zstd -qdf "$WORK/deb/lib/modules/$KVER/kernel/$m.ko.zst" -o "$WORK/l1root/modules/$(basename $m).ko"
done
(cd "$WORK/l1root" && find . | cpio -o -H newc 2>/dev/null) > "$OUT/l1-initrd.cpio"
(cd "$OUT" && cat envgit-vm Image l1-initrd.cpio | shasum -a 256 | cut -c1-16) > "$OUT/stamp"
ls -la "$OUT"
