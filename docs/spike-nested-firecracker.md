# Spike: memory + process snapshots on this Mac

Question: can envgit get VM-level snapshots (memory, processes, disk) locally on Apple silicon, and
which way — Firecracker inside a nested-virtualization Linux microVM, or the Virtualization
framework's own save/restore?

**Answer: both work.** Nested KVM inside our own Virtualization-framework microVM runs Firecracker,
and Firecracker's full/diff snapshots restore a running guest in ~50 ms. The framework's own
`saveMachineStateTo` also works with only the public entitlement — but not together with nested
virtualization.

## Setup

| | |
|---|---|
| Host | Apple M3 Pro, 18 GB, macOS 27.0 (26A428), Swift 6.4 Command Line Tools (no Xcode) |
| Outer microVM (L1) | `scripts/spike/vzrun.swift` — ~150 lines, Virtualization framework, ad-hoc signed with only `com.apple.security.virtualization` |
| L1 kernel | Ubuntu 24.04 arm64 `linux-generic` 6.8.0-147 (cloud-images `unpacked/…-vmlinuz-generic`, gunzipped) |
| L1 userspace | none: a static Go `/init` (`scripts/spike/init/main.go`) in a cpio initramfs |
| Inner microVM (L2) | Firecracker v1.17.0 aarch64, CI kernel `vmlinux-6.18.54`, CI `ubuntu-24.04.squashfs` (read-only root), 2 vCPU / 512 MiB, `track_dirty_pages: true` |
| CI artifacts | `s3://spec.ccfc.min/firecracker-ci/20261023-dd7c24b0d165-0/aarch64/` (the getting-started script resolves "latest", which moves) |

Build and run (paths shortened):

```bash
swiftc -O -o vzrun scripts/spike/vzrun.swift
codesign -f -s - --entitlements scripts/spike/vzrun.entitlements vzrun
(cd scripts/spike/init && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o init .)
# initramfs: /init [+ /fc/firecracker, /fc/rebase-snap, /fc/vmlinux, /fc/rootfs.squashfs]
(cd root && find . | cpio -o -H newc -L > initrd.cpio)
./vzrun --kernel Image --initrd initrd.cpio --cmdline "console=hvc0 envgit.mode=fc" --cpus 4 --mem 4096 --nested
```

`envgit.mode=probe|fc|tick|dirty` selects what `/init` does; it prints `RESULT key=value` lines.

## Gates

| Gate | Result |
|---|---|
| 1. `/dev/kvm` usable in L1 with nested virtualization | ✅ `KVM_GET_API_VERSION` = 12. L1 starts in 0.15 s; boot → probe → power-off ≈ 1 s |
| 2. Firecracker boots an L2 guest | ✅ the L2 guest boots, so KVM's interrupt-controller emulation works under nested virtualization; `InstanceStart` 280 ms, shell answering after ~4.3–4.9 s (polled at 1 s) |
| 3. Firecracker snapshots work and are fast | ✅ numbers below; a background counter and a 128 MiB tmpfs file survive restore |

## Firecracker in nested KVM (two runs)

| Measurement | Run 1 | Run 2 |
|---|---|---|
| Full snapshot create (512 MiB guest) | 259 ms | 234 ms |
| Full memory file | 512 MiB | 512 MiB |
| Diff snapshot, quiet guest | 8.9 ms, 1.2 MiB | 4.8 ms, 1.4 MiB |
| Diff snapshot after writing 128 MiB | 102 ms, 134 MiB | 150 ms, 134 MiB |
| Load full snapshot (API) | 3.3 ms | 2.6 ms |
| Load full → guest shell answers | 58 ms | 50 ms |
| `rebase-snap` quiet diff / 128 MiB diff onto the full file | 1.7 / 57 ms | 2.3 / 73 ms |
| Load rebased snapshot → shell answers | 44 ms | 54 ms |
| Console round trip in a running guest | 12 ms | 12.5 ms |

State checks: restoring the full snapshot resumed the guest's counter at 4 (it was 3 when the
snapshot was taken, 27 when the first Firecracker was killed); the rebased diff resumed at 26–27 with
the 128 MiB tmpfs file intact (`wc -c` = 134217728). Diff memory files are sparse: apparent size
512 MiB, allocated size as listed.

**These numbers are RAM-backed.** Snapshot and memory files went to a tmpfs in L1, and the L2 kernel
and rootfs were read from the initramfs, so creates, loads and boot never touched a disk. The VZ
numbers below wrote to the host SSD. Disk-backed Firecracker snapshots (a virtio-blk or virtio-fs
target in L1) are part of building the real backend; expect full snapshots to be slower, diffs much
less so.

## Virtualization framework save/restore (`saveMachineStateTo` / `restoreMachineStateFrom`)

Encore reported that saving needs the private `com.apple.private.virtualization` entitlement.
On this machine it does not.

| Configuration (1 GiB VM, 2 vCPU) | Save | State file | Restore | Guest after restore |
|---|---|---|---|---|
| Console only, idle | 0.32 s | 29.9 MB | 0.23–0.27 s | ✅ counter and guest clock continue; restoring the same file twice (sequentially) works |
| + virtio-blk disk, NAT network, vsock | 0.31 s | 29.9 MB | 0.23 s | ✅ (after pinning the MAC address, see below) |
| + 256 MiB of touched memory | 0.37 s | 172 MB | 0.36 s | ✅ |
| nested virtualization enabled (with or without devices) | 0.27–0.29 s | 29.9 MB | 0.22–0.29 s | ❌ restore reports success, then no console output for 6 s (frozen guest vs. console not reattached was not distinguished) |

Requirements found: the machine identifier **and** the NAT MAC address must be identical between save
and restore (a random MAC gives `VZErrorDomain Code=12 "invalid argument"` on restore). The state file
holds touched memory only and appears compressed — the 256 MiB test pattern is periodic, so 172 MB
is a lower bound for real workloads; there is no diff/incremental mode.

## CPU overhead

Same Go busy loop (100 M iterations): host 75 ms, L1 78–81 ms → **~4–8 %** for one level. The L2
number was not measured reliably: the only shell loop available in L2 is dash, and macOS's
`/bin/dash` (1.55 s) is a different enough build that L2 (0.72–0.74 s) came out *faster*. The L2
loop also ran with `track_dirty_pages` on, whose cost was not isolated.

## What this means for envgit

Two workable VM backends, with different trade-offs:

| | A. VZ microVM + VZ save/restore | B. VZ microVM (nested) + Firecracker |
|---|---|---|
| Layers | one | two (Firecracker inside L1) |
| Snapshot | full state each time, ~0.3–0.4 s, size ≈ touched memory (compressed) | full ~250 ms; **diff 5–150 ms**, size ≈ pages dirtied since the last one |
| Restore | ~0.25–0.4 s | ~50 ms |
| Fork | restore the same file N times (sequential restores tested; concurrent not) | same, plus diff chains + `rebase-snap` |
| Same code on Linux servers | no (macOS only) | yes — Firecracker is the M2.5 backend |
| Caveats | no incremental snapshots; can't use nested virt in the same VM | L1 itself can't be saved; two kernels to manage; L2 CPU overhead unmeasured |

B's snapshot and restore times are RAM-backed (tmpfs in L1); A's wrote to the host SSD.

B fits envgit's per-step model (a diff per step costs milliseconds and megabytes) and shares its
backend with Linux; A is the simpler fallback and a good fit for "snapshot only at chosen steps".

## Open questions (not answered by this spike)

- How files get between the host workdir and an L2 guest two layers down (virtio-fs into L1 and then
  a block device or vsock into L2; virtio-fs may also break VZ save/restore for option A).
- L2 networking: tap device and NAT inside L1, and how srt-style egress policy applies there.
- L2 root filesystems: writable ext4 images with copy-on-write per fork.
- Why Encore's save failed — macOS version, device mix, or signing — and whether Apple keeps this
  working; nested + restore freezing may also change between releases.
- Firecracker snapshots are not portable across CPU models, so a snapshot taken on this Mac will not
  restore on a Linux server.

## Sources

- Firecracker getting started (download commands): https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
- Firecracker snapshot support: https://github.com/firecracker-microvm/firecracker/blob/master/docs/snapshotting/snapshot-support.md
- Encore, "We rebuilt the Linux microVM stack on Apple Silicon": https://encore.dev/blog/firecracker-apple-silicon
