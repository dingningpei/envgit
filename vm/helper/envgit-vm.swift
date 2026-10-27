// envgit-vm: boots the L1 microVM (docs/design.md §3.6) and bridges a host unix socket to the
// L1 supervisor on vsock port 1024 — one vsock connection per accepted socket connection.
//
//   envgit-vm --kernel Image --initrd l1-initrd.cpio --rootfs rootfs.squashfs --layer layer.squashfs
//             --socket path --share dir --proxy-socket path [--cpus 4] [--mem 4096] [--l2mem 1024]
//             [--share-repo dir] [--cmdline "k=v ..."]
//
// The two images are attached read-only as L1's /dev/vda and /dev/vdb, which L1 passes to L2's
// Firecracker as its drives: L2's root is the rootfs with the layer (Node) on top.
//
// `dir` (the workdir's .envgit/vm/snaps) is shared into L1 over virtiofs with tag "envgit"; L1 writes
// every snapshot there. Guest connections to vsock port 3128 (L2's egress, via L1) are joined to the
// unix socket `--proxy-socket`, which envgit serves only while a step runs; when nothing is listening
// the connection is refused and L1 answers the client with an envgit 503. The L1 console goes to
// stdout. The process exits when the guest stops. `--share-repo` (tag "repo") and `--cmdline` are for
// scripts/vm/linux-test.sh, which boots a Linux test VM rather than L1.
import Foundation
import Virtualization

func log(_ s: String) { FileHandle.standardError.write("[envgit-vm] \(s)\n".data(using: .utf8)!) }

var opts: [String: String] = [:]
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() { if a.hasPrefix("--"), let v = it.next() { opts[a] = v } }
let kernel = opts["--kernel"] ?? ""
let initrd = opts["--initrd"] ?? ""
let socketPath = opts["--socket"] ?? ""
let sharePath = opts["--share"] ?? ""
let proxySocketPath = opts["--proxy-socket"] ?? ""
let rootfsPath = opts["--rootfs"] ?? ""
let layerPath = opts["--layer"] ?? ""
if kernel.isEmpty || initrd.isEmpty || socketPath.isEmpty || sharePath.isEmpty || proxySocketPath.isEmpty || rootfsPath.isEmpty || layerPath.isEmpty {
  log("usage: envgit-vm --kernel K --initrd I --rootfs R --layer L --socket S --share DIR --proxy-socket P [--cpus N] [--mem MiB] [--l2mem MiB]")
  exit(2)
}

let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
boot.initialRamdiskURL = URL(fileURLWithPath: initrd)
boot.commandLine = "console=hvc0 quiet envgit.l2mem=\(opts["--l2mem"] ?? "1024") \(opts["--cmdline"] ?? "")"

let config = VZVirtualMachineConfiguration()
config.bootLoader = boot
config.cpuCount = Int(opts["--cpus"] ?? "4")!
config.memorySize = UInt64(opts["--mem"] ?? "4096")! * 1024 * 1024
let platform = VZGenericPlatformConfiguration()
guard VZGenericPlatformConfiguration.isNestedVirtualizationSupported else {
  log("nested virtualization is not supported on this Mac (needs M3 or later and macOS 15 or later)")
  exit(1)
}
platform.isNestedVirtualizationEnabled = true
config.platform = platform
let console = VZVirtioConsoleDeviceSerialPortConfiguration()
console.attachment = VZFileHandleSerialPortAttachment(
  fileHandleForReading: FileHandle(forReadingAtPath: "/dev/null")!, fileHandleForWriting: FileHandle.standardOutput)
config.serialPorts = [console]
config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
let share = VZVirtioFileSystemDeviceConfiguration(tag: "envgit")
share.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: sharePath), readOnly: false))
config.directorySharingDevices = [share]
if let repo = opts["--share-repo"] {
  let r = VZVirtioFileSystemDeviceConfiguration(tag: "repo")
  r.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: repo), readOnly: false))
  config.directorySharingDevices.append(r)
}
do {
  config.storageDevices = try [rootfsPath, layerPath].map { path in
    VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: path), readOnly: true))
  }
} catch { log("disk images: \(error)"); exit(1) }
do { try config.validate() } catch { log("config: \(error)"); exit(1) }

final class Delegate: NSObject, VZVirtualMachineDelegate {
  func guestDidStop(_ vm: VZVirtualMachine) { log("guest stopped"); cleanup(); exit(0) }
  func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) { log("stopped with error: \(error)"); cleanup(); exit(1) }
}

func cleanup() { unlink(socketPath) }

let vm = VZVirtualMachine(configuration: config)
let delegate = Delegate()
vm.delegate = delegate

// Copies bytes one way until EOF, then half-closes the other side.
func pump(from: Int32, to: Int32) {
  var buf = [UInt8](repeating: 0, count: 1 << 16)
  while true {
    let n = read(from, &buf, buf.count)
    if n <= 0 { break }
    var off = 0
    while off < n {
      let w = buf.withUnsafeBytes { write(to, $0.baseAddress! + off, n - off) }
      if w <= 0 { return }
      off += w
    }
  }
  shutdown(to, SHUT_WR)
}

func bridge(client: Int32) {
  guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { close(client); return }
  device.connect(toPort: 1024) { result in
    switch result {
    case .failure(let e):
      log("vsock connect failed: \(e)")
      close(client)
    case .success(let conn):
      let guestFD = conn.fileDescriptor
      let group = DispatchGroup()
      for (a, b) in [(client, guestFD), (guestFD, client)] {
        group.enter()
        Thread.detachNewThread { pump(from: a, to: b); group.leave() }
      }
      group.notify(queue: .global()) {
        conn.close()
        close(client)
      }
    }
  }
}

func unixAddr(_ path: String) -> sockaddr_un? {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
  withUnsafeMutableBytes(of: &addr.sun_path) { p in
    for (i, b) in bytes.enumerated() { p[i] = b }
  }
  return addr
}

func connectUnix(_ path: String) -> Int32? {
  guard var addr = unixAddr(path) else { return nil }
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  let len = socklen_t(MemoryLayout<sockaddr_un>.size)
  let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) } }
  if ok != 0 { close(fd); return nil }
  return fd
}

// Guest-initiated egress connections on vsock port 3128.
final class Egress: NSObject, VZVirtioSocketListenerDelegate {
  func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection conn: VZVirtioSocketConnection, from device: VZVirtioSocketDevice) -> Bool {
    guard let host = connectUnix(proxySocketPath) else { return false }
    let guestFD = conn.fileDescriptor
    let group = DispatchGroup()
    for (a, b) in [(host, guestFD), (guestFD, host)] {
      group.enter()
      Thread.detachNewThread { pump(from: a, to: b); group.leave() }
    }
    group.notify(queue: .global()) {
      conn.close()  // also keeps `conn` alive until both directions are done
      close(host)
    }
    return true
  }
}
let egress = Egress()
let egressListener = VZVirtioSocketListener()
egressListener.delegate = egress

func serveSocket() {
  unlink(socketPath)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(socketPath.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { log("socket path too long"); exit(1) }
  withUnsafeMutableBytes(of: &addr.sun_path) { p in
    for (i, b) in bytes.enumerated() { p[i] = b }
  }
  let len = socklen_t(MemoryLayout<sockaddr_un>.size)
  let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
  guard ok == 0, listen(fd, 16) == 0 else { log("cannot listen on \(socketPath): \(String(cString: strerror(errno)))"); exit(1) }
  chmod(socketPath, 0o600)
  Thread.detachNewThread {
    while true {
      let c = accept(fd, nil, nil)
      if c < 0 { continue }
      DispatchQueue.main.async { bridge(client: c) }
    }
  }
}

signal(SIGTERM) { _ in vm.stop { _ in cleanup(); exit(0) } }
signal(SIGINT) { _ in vm.stop { _ in cleanup(); exit(0) } }

vm.start { r in
  if case .failure(let e) = r { log("start failed: \(e)"); exit(1) }
  log("L1 started")
  (vm.socketDevices.first as? VZVirtioSocketDevice)?.setSocketListener(egressListener, forPort: 3128)
  serveSocket()
}
RunLoop.main.run()
