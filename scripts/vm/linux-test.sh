#!/bin/sh
# Runs a command in a throwaway Linux VM on this Mac, to exercise the vm backend's Linux host mode
# (docs/design.md §3.6): the VM is booted from the L1 kernel, which has KVM, with the Ubuntu image and
# Node layer as root and this repo at /repo. Needs scripts/vm/build.sh first.
#
#   scripts/vm/linux-test.sh [command ...]     (default: the vm e2e tests)
#
# Inside, ENVGIT_VM_DIR=/cache/vm holds the Linux build (`scripts/vm/build.sh --linux-layout
# ~/.cache/envgit/vm-linux/vm` writes it), and the repo's node_modules gets linux-arm64 rollup/esbuild
# on a tmpfs overlay, so nothing in the checkout changes. srt's Linux dependencies (bubblewrap, socat,
# ripgrep) come from pinned Ubuntu debs, fetched once into ~/.cache/envgit/vm-linux/debs.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT="${ENVGIT_VM_DIR:-$HOME/.cache/envgit/vm}"
OUT="$ROOT/build"
WORK="$ROOT/work"
CACHE="$HOME/.cache/envgit/vm-linux"
KVER=6.8.0-147-generic
mkdir -p "$CACHE"

echo "linuxtest initrd" >&2
(cd "$REPO/vm/guest" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o "$WORK/linuxtest-init" ./cmd/linuxtest)
rm -rf "$WORK/ltroot" && mkdir -p "$WORK/ltroot/modules" "$WORK/ltroot/proc" "$WORK/ltroot/sys" "$WORK/ltroot/dev"
cp "$WORK/linuxtest-init" "$WORK/ltroot/init"
(cd "$WORK/deb" && tar -xf data.tar "./lib/modules/$KVER/kernel/fs/overlayfs/overlay.ko.zst")
for m in fs/overlayfs/overlay fs/fuse/virtiofs; do
  zstd -qdf "$WORK/deb/lib/modules/$KVER/kernel/$m.ko.zst" -o "$WORK/ltroot/modules/$(basename $m).ko"
done
(cd "$WORK/ltroot" && find . | cpio -o -H newc 2>/dev/null) > "$WORK/linuxtest.cpio"

# vitest's native pieces (esbuild — vite nests its own — and rollup) are installed for darwin here;
# fetch the linux-arm64 package of each, same version, to drop in beside it inside the VM.
mkdir -p "$CACHE/node-extra" && : > "$CACHE/node-extra/map"
for d in $(cd "$REPO" && find node_modules -type d \( -path '*/@esbuild/darwin-arm64' -o -path '*/@rollup/rollup-darwin-arm64' \)); do
  v=$(node -p "require('$REPO/$d/package.json').version")
  case "$d" in *@esbuild*) n=@esbuild/linux-arm64 ;; *) n=@rollup/rollup-linux-arm64-gnu ;; esac
  t="$(echo "$n" | tr -d @ | tr / -)-$v.tgz"
  [ -s "$CACHE/node-extra/$t" ] || (cd "$CACHE/node-extra" && npm pack --silent "$n@$v" >/dev/null)
  echo "$(dirname "$(dirname "$d")")/$n|$t" >> "$CACHE/node-extra/map"
done

# On Linux, srt's egress proxy needs bubblewrap, socat and ripgrep (as the srt backend does there);
# the Ubuntu image has none of them, so unpack pinned noble arm64 debs into the VM's root.
mkdir -p "$CACHE/debs"
UBU=http://ports.ubuntu.com/ubuntu-ports
while read -r p s; do
  f="$CACHE/debs/$(basename "$p")"
  if [ ! -s "$f" ] || [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" != "$s" ]; then
    echo "fetch    $(basename "$p")" >&2
    curl -fsSL -o "$f.part" "$UBU/$p"
    [ "$(shasum -a 256 "$f.part" | cut -d' ' -f1)" = "$s" ] || { echo "checksum mismatch: $p" >&2; rm -f "$f.part"; exit 1; }
    mv "$f.part" "$f"
  fi
done <<'EOF'
pool/main/b/bubblewrap/bubblewrap_0.9.0-1ubuntu0.3_arm64.deb dce3a2e5f0302eab717a64fe9c9411fe2d40469e2a7946e0f2ce1420a61025c3
pool/main/s/socat/socat_1.8.0.0-4ubuntu0.1_arm64.deb 4230c851d4534710f63753a8322b5baae8aedc1aed21a3a0f2350fa61d44169b
pool/main/t/tcp-wrappers/libwrap0_7.6.q-33_arm64.deb cb7aec6dd9e6e26df584d2e33f3c00b2d9c17430251f41bdf2a2878098b70db6
pool/universe/r/rust-ripgrep/ripgrep_14.1.0-1_arm64.deb 71fe8a5667bc87d2bca175a3426c6ec518e0679cc821d23ae7056de7096f04de
EOF

[ $# -gt 0 ] || set -- sh -c 'ENVGIT_VM_E2E=1 npx vitest run --no-file-parallelism test/vm.e2e.test.ts test/vm-mcp.e2e.test.ts'
{
  echo 'set -e'
  echo 'export ENVGIT_VM_DIR=/cache/vm'
  echo 'mkdir -p /cache/vm/run && mount -t tmpfs tmpfs /cache/vm/run  # unix sockets stay off the share'
  echo 'for d in /cache/debs/*.deb; do dpkg-deb -x $d /; done'
  echo 'mkdir -p /tmp/nm/up /tmp/nm/work'
  echo 'mount -t overlay overlay -o lowerdir=/repo/node_modules,upperdir=/tmp/nm/up,workdir=/tmp/nm/work /repo/node_modules'
  echo 'while IFS="|" read -r dst t; do x=/tmp/nm/x; rm -rf $x; mkdir -p $x /repo/$dst; tar -xzf /cache/node-extra/$t -C $x; cp -a $x/package/. /repo/$dst/; done < /cache/node-extra/map'
  echo 'set +e'
  printf '%s' 'exec'; for a in "$@"; do printf " '%s'" "$(printf '%s' "$a" | sed "s/'/'\\\\''/g")"; done; echo
} > "$CACHE/run.sh"

LOG="$CACHE/console.log"
"$OUT/envgit-vm" --kernel "$OUT/Image" --initrd "$WORK/linuxtest.cpio" \
  --rootfs "$OUT/rootfs.squashfs" --layer "$OUT/layer.squashfs" \
  --socket "$CACHE/unused.sock" --proxy-socket "$CACHE/unused.proxy.sock" \
  --share "$CACHE" --share-repo "$REPO" --cpus 4 --mem 6144 \
  --cmdline "envgit.run=run.sh envgit.now=$(date +%s)" | tee "$LOG"
code=$(sed -n 's/.*\[linuxtest\] exit \([0-9]*\).*/\1/p' "$LOG" | tail -1)
exit "${code:-1}"
