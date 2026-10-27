#!/bin/sh
# Builds the VM backend artifacts (docs/design.md §3.6) from the pinned downloads:
#   build/envgit-vm         Swift helper (Virtualization.framework), ad-hoc signed
#   build/Image             L1 kernel (Ubuntu generic, uncompressed)
#   build/l1-initrd.cpio    L1 supervisor + Firecracker + L2 kernel/initrd + vsock/virtiofs modules
#   build/rootfs.squashfs   L2's root: Ubuntu 24.04 server cloud image (git, python3, curl, ...)
#   build/layer.squashfs    Node, overlaid on the root under /usr/local
#   build/image-stamp       hash of the two images; a session only resumes on the image it began on
#   build/stamp             hash of everything above; a VM booted from another build is restarted
#   build/base/             prebuilt full snapshot of a warmed-up guest; new sessions restore it
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
cp "$WORK/l2-initrd.cpio" "$WORK/l1root/fc/l2-initrd.cpio"
for m in net/vmw_vsock/vsock net/vmw_vsock/vmw_vsock_virtio_transport_common net/vmw_vsock/vmw_vsock_virtio_transport fs/fuse/virtiofs; do
  zstd -qdf "$WORK/deb/lib/modules/$KVER/kernel/$m.ko.zst" -o "$WORK/l1root/modules/$(basename $m).ko"
done
(cd "$WORK/l1root" && find . | cpio -o -H newc 2>/dev/null) > "$OUT/l1-initrd.cpio"

echo "L2 images"
# Attached as disks rather than packed into the initrd, so they are read on demand, not loaded into RAM.
cp -c "$DL/ubuntu-24.04-server-cloudimg-arm64-20260926.squashfs" "$OUT/rootfs.squashfs.part" && mv "$OUT/rootfs.squashfs.part" "$OUT/rootfs.squashfs"
NODE_TAR=node-v24.21.0-linux-arm64.tar.xz
LAYER_KEY=$( (cat "$OUT/rootfs.squashfs" "$DL/$NODE_TAR"; echo layer-v1) | shasum -a 256 | cut -c1-16)
if [ "$(cat "$WORK/layer.key" 2>/dev/null)" = "$LAYER_KEY" ] && [ -s "$OUT/layer.squashfs" ]; then
  echo "ok       layer.squashfs"
else
  # macOS has no mksquashfs, but the rootfs does: boot it bare (an empty layer) in a throwaway workdir
  # and let L2 pack Node, with every file owned by root.
  echo "building layer.squashfs in the VM"
  : > "$OUT/layer.squashfs" && dd if=/dev/zero of="$OUT/layer.squashfs" bs=4096 count=1 2>/dev/null
  (cd "$OUT" && cat envgit-vm Image l1-initrd.cpio | shasum -a 256 | cut -c1-16) > "$OUT/stamp"
  BOOT="$WORK/layer-build" && rm -rf "$BOOT" && mkdir -p "$BOOT"
  cp "$DL/$NODE_TAR" "$BOOT/node.tar.xz"
  envgit() { (cd "$BOOT" && node "$REPO/dist/cli/index.js" "$@"); }
  (cd "$REPO" && npm run build >/dev/null)  # the bootstrap VM is started by this checkout's envgit
  envgit init >/dev/null && echo 'backend: vm' > "$BOOT/.envgit/policy.yaml"
  envgit vm up --new
  if envgit run sh -c 'set -e; mkdir -p s/usr/local; tar -xJf node.tar.xz -C s/usr/local --strip-components 1;
      rm -f s/usr/local/CHANGELOG.md s/usr/local/README.md node.tar.xz;
      mksquashfs s layer.squashfs -comp gzip -all-root -noappend -quiet; rm -rf s'; then ok=1; else ok=0; fi
  envgit vm down >/dev/null || true
  [ "$ok" = 1 ] && [ -s "$BOOT/layer.squashfs" ] || { echo "layer build failed" >&2; exit 1; }
  mv "$BOOT/layer.squashfs" "$OUT/layer.squashfs"
  echo "$LAYER_KEY" > "$WORK/layer.key"
  rm -rf "$BOOT"
fi
(cd "$OUT" && cat rootfs.squashfs layer.squashfs | shasum -a 256 | cut -c1-16) > "$OUT/image-stamp"
(cd "$OUT" && cat envgit-vm Image l1-initrd.cpio image-stamp | shasum -a 256 | cut -c1-16) > "$OUT/stamp"

# A cold-booted L2 pays ≈ 250 µs for every page it touches first, a restored one far less: boot one
# guest here, let it run node/python/git once, and keep its full snapshot for new sessions to restore.
if [ "$(cat "$OUT/base/stamp" 2>/dev/null)" = "$(cat "$OUT/stamp")" ]; then
  echo "ok       base snapshot"
else
  echo "building the prebuilt base snapshot"
  rm -rf "$OUT/base"
  BOOT="$WORK/base-build" && rm -rf "$BOOT" && mkdir -p "$BOOT"
  (cd "$REPO" && npm run build >/dev/null)
  (cd "$BOOT" && node "$REPO/dist/cli/index.js" init >/dev/null && echo 'backend: vm' > .envgit/policy.yaml \
    && node "$REPO/dist/cli/index.js" vm prebuild "$OUT/base.part") || { echo "base snapshot failed" >&2; exit 1; }
  mv "$OUT/base.part" "$OUT/base"
  rm -rf "$BOOT"
fi
ls -la "$OUT" "$OUT/base"
