// Spike: boot a Linux microVM with Apple's Virtualization framework.
// See docs/spike-nested-firecracker.md.
//
//   vzrun --kernel Image --initrd initrd.cpio [--cmdline "..."] [--cpus 4] [--mem 4096] [--nested]
//         [--disk raw.img] [--net] [--vsock]
//         [--save state.vzvmsave --save-after SECONDS] [--restore state.vzvmsave --run-for SECONDS]
import Foundation
import Virtualization

func log(_ s: String) { FileHandle.standardError.write("[vzrun] \(s)\n".data(using: .utf8)!) }
func now() -> Double { Date().timeIntervalSince1970 }

var opts: [String: String] = [:]
var flags = Set<String>()
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
  if ["--nested", "--net", "--vsock"].contains(a) { flags.insert(a) } else if a.hasPrefix("--"), let v = it.next() { opts[a] = v }
}

func config() throws -> VZVirtualMachineConfiguration {
  guard let kernel = opts["--kernel"], let initrd = opts["--initrd"] else {
    log("usage: vzrun --kernel K --initrd I [...]"); exit(2)
  }
  let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
  boot.initialRamdiskURL = URL(fileURLWithPath: initrd)
  boot.commandLine = opts["--cmdline"] ?? "console=hvc0"

  let c = VZVirtualMachineConfiguration()
  c.bootLoader = boot
  c.cpuCount = Int(opts["--cpus"] ?? "4")!
  c.memorySize = UInt64(opts["--mem"] ?? "4096")! * 1024 * 1024

  let platform = VZGenericPlatformConfiguration()
  if flags.contains("--nested") {
    log("nested virtualization supported: \(VZGenericPlatformConfiguration.isNestedVirtualizationSupported)")
    platform.isNestedVirtualizationEnabled = true
  }
  // Save/restore needs a stable machine identifier across the save and the restore.
  if let idPath = opts["--machine-id"] {
    if let data = FileManager.default.contents(atPath: idPath), let id = VZGenericMachineIdentifier(dataRepresentation: data) {
      platform.machineIdentifier = id
    } else {
      FileManager.default.createFile(atPath: idPath, contents: platform.machineIdentifier.dataRepresentation)
    }
  }
  c.platform = platform

  let console = VZVirtioConsoleDeviceSerialPortConfiguration()
  console.attachment = VZFileHandleSerialPortAttachment(
    fileHandleForReading: FileHandle.standardInput, fileHandleForWriting: FileHandle.standardOutput)
  c.serialPorts = [console]
  c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  if let disk = opts["--disk"] {
    let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: disk), readOnly: false)
    c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
  }
  if flags.contains("--net") {
    let net = VZVirtioNetworkDeviceConfiguration()
    net.attachment = VZNATNetworkDeviceAttachment()
    // Like the machine identifier, the MAC must match between save and restore.
    if let idPath = opts["--machine-id"] {
      let macPath = idPath + ".mac"
      if let text = try? String(contentsOfFile: macPath, encoding: .utf8), let mac = VZMACAddress(string: text) {
        net.macAddress = mac
      } else {
        try net.macAddress.string.write(toFile: macPath, atomically: true, encoding: .utf8)
      }
    }
    c.networkDevices = [net]
  }
  if flags.contains("--vsock") { c.socketDevices = [VZVirtioSocketDeviceConfiguration()] }
  try c.validate()
  do {
    try c.validateSaveRestoreSupport()
    log("validateSaveRestoreSupport: ok")
  } catch {
    log("validateSaveRestoreSupport: \(error)")
  }
  return c
}

final class Delegate: NSObject, VZVirtualMachineDelegate {
  func guestDidStop(_ vm: VZVirtualMachine) { log("guest stopped"); exit(0) }
  func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) { log("stopped with error: \(error)"); exit(1) }
}

let delegate = Delegate()
let vm: VZVirtualMachine
do { vm = VZVirtualMachine(configuration: try config()) } catch { log("config: \(error)"); exit(1) }
vm.delegate = delegate

func stopAndExit(_ code: Int32) {
  vm.stop { _ in exit(code) }
}

if let restore = opts["--restore"] {
  let t0 = now()
  vm.restoreMachineStateFrom(url: URL(fileURLWithPath: restore)) { error in
    if let error { log("restore failed: \(error)"); exit(1) }
    let t1 = now()
    log(String(format: "restore took %.3fs", t1 - t0))
    vm.resume { r in
      if case .failure(let e) = r { log("resume failed: \(e)"); exit(1) }
      log(String(format: "resumed %.3fs after restore", now() - t1))
      let runFor = Double(opts["--run-for"] ?? "5")!
      DispatchQueue.main.asyncAfter(deadline: .now() + runFor) { stopAndExit(0) }
    }
  }
} else {
  let t0 = now()
  vm.start { r in
    if case .failure(let e) = r { log("start failed: \(e)"); exit(1) }
    log(String(format: "started in %.3fs", now() - t0))
    if let save = opts["--save"] {
      let after = Double(opts["--save-after"] ?? "5")!
      DispatchQueue.main.asyncAfter(deadline: .now() + after) {
        let tp = now()
        vm.pause { r in
          if case .failure(let e) = r { log("pause failed: \(e)"); exit(1) }
          log(String(format: "paused in %.3fs", now() - tp))
          let ts = now()
          vm.saveMachineStateTo(url: URL(fileURLWithPath: save)) { error in
            if let error { log("save failed: \(error)"); stopAndExit(1); return }
            let size = (try? FileManager.default.attributesOfItem(atPath: save)[.size] as? NSNumber)?.int64Value ?? -1
            log(String(format: "save took %.3fs, %d bytes", now() - ts, size))
            stopAndExit(0)
          }
        }
      }
    }
  }
}

RunLoop.main.run()
