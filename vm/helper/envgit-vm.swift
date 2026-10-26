// envgit-vm: boots the L1 microVM (docs/design.md §3.6) and bridges a host unix socket to the
// L1 supervisor on vsock port 1024 — one vsock connection per accepted socket connection.
//
//   envgit-vm --kernel Image --initrd l1-initrd.cpio --socket path --share dir [--cpus 4] [--mem 4096] [--l2mem 1024]
//
// `dir` (the workdir's .envgit/vm/snaps) is shared into L1 over virtiofs with tag "envgit"; L1 writes
// every snapshot there. The L1 console goes to stdout. The process exits when the guest stops.
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
if kernel.isEmpty || initrd.isEmpty || socketPath.isEmpty || sharePath.isEmpty {
  log("usage: envgit-vm --kernel K --initrd I --socket S --share DIR [--cpus N] [--mem MiB] [--l2mem MiB]")
  exit(2)
}

let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
boot.initialRamdiskURL = URL(fileURLWithPath: initrd)
boot.commandLine = "console=hvc0 quiet envgit.l2mem=\(opts["--l2mem"] ?? "1024")"

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
  serveSocket()
}
RunLoop.main.run()
