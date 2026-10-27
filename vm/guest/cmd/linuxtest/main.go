// linuxtest: PID 1 of a throwaway Linux VM that scripts/vm/linux-test.sh boots on a Mac to exercise
// the vm backend's Linux host mode (docs/design.md §3.6) — the Mac's L1 kernel has KVM, so envgit can
// run Firecracker in it directly, as it would on a Linux server.
//
// Root is the same Ubuntu image + Node layer L2 uses (vda, vdb), overlaid on tmpfs. The repo is
// shared in at /repo (virtiofs tag "repo") and the test cache at /cache (tag "envgit"). Runs
// `sh /cache/<envgit.run>` from /repo, prints "linuxtest: exit N", and powers off.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func logf(f string, a ...any) { fmt.Printf("[linuxtest] "+f+"\n", a...) }

func must(err error, what string) {
	if err != nil {
		logf("%s: %v", what, err)
		poweroff()
	}
}

func poweroff() {
	unix.Sync()
	_ = unix.Reboot(unix.LINUX_REBOOT_CMD_POWER_OFF)
	select {}
}

func cmdline() map[string]string {
	b, _ := os.ReadFile("/proc/cmdline")
	m := map[string]string{}
	for _, f := range strings.Fields(string(b)) {
		if k, v, ok := strings.Cut(f, "="); ok {
			m[k] = v
		}
	}
	return m
}

func loadModule(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := unix.FinitModule(int(f.Fd()), "", 0); err != nil && err != unix.EEXIST {
		return err
	}
	return nil
}

func mount(src, dst, fstype string, flags uintptr, data string) {
	_ = os.MkdirAll(dst, 0o755)
	must(syscall.Mount(src, dst, fstype, flags, data), "mount "+dst)
}

func main() {
	mount("proc", "/proc", "proc", 0, "")
	mount("sysfs", "/sys", "sysfs", 0, "")
	mount("devtmpfs", "/dev", "devtmpfs", 0, "")
	args := cmdline()
	if s, err := strconv.ParseInt(args["envgit.now"], 10, 64); err == nil {
		tv := unix.Timeval{Sec: s}
		_ = unix.Settimeofday(&tv)
	}
	for _, m := range []string{"overlay", "virtiofs"} {
		must(loadModule("/modules/"+m+".ko"), "load "+m)
	}
	mount("/dev/vda", "/ro", "squashfs", syscall.MS_RDONLY, "")
	mount("/dev/vdb", "/layer", "squashfs", syscall.MS_RDONLY, "")
	mount("tmpfs", "/rw", "tmpfs", 0, "size=50%")
	_ = os.MkdirAll("/rw/upper", 0o755)
	_ = os.MkdirAll("/rw/work", 0o755)
	const root = "/newroot"
	mount("overlay", root, "overlay", 0, "lowerdir=/layer:/ro,upperdir=/rw/upper,workdir=/rw/work")
	mount("repo", root+"/repo", "virtiofs", 0, "")
	mount("envgit", root+"/cache", "virtiofs", 0, "")
	mount("proc", root+"/proc", "proc", 0, "")
	mount("sysfs", root+"/sys", "sysfs", 0, "")
	mount("/dev", root+"/dev", "", syscall.MS_BIND, "")
	mount("devpts", root+"/dev/pts", "devpts", 0, "")
	mount("tmpfs", root+"/dev/shm", "tmpfs", 0, "")
	mount("tmpfs", root+"/tmp", "tmpfs", 0, "size=60%")
	mount("tmpfs", root+"/run", "tmpfs", 0, "")
	// switch_root, not a bare chroot: a chrooted process may not create user namespaces, which
	// bubblewrap (srt on Linux) needs. Moving the new root onto / makes it the namespace's root.
	must(os.Chdir(root), "chdir newroot")
	must(syscall.Mount(".", "/", "", syscall.MS_MOVE, ""), "move newroot")
	must(syscall.Chroot("."), "chroot")
	must(os.Chdir("/repo"), "chdir")

	env := []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "TERM=dumb", "LANG=C.UTF-8"}
	_ = exec.Command("/usr/sbin/ip", "link", "set", "lo", "up").Run()
	cmd := exec.Command("/bin/sh", "/cache/"+args["envgit.run"])
	cmd.Env = env
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stdout
	if err := cmd.Start(); err != nil {
		logf("%v", err)
		logf("exit 1")
		poweroff()
	}
	// As PID 1, reap every orphan (envgit's detached supervisor, once it exits), not only the script:
	// an unreaped one stays a zombie that `vm down` waits on.
	code := 1
	for {
		var ws unix.WaitStatus
		pid, err := unix.Wait4(-1, &ws, 0, nil)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			break
		}
		if pid == cmd.Process.Pid {
			code = ws.ExitStatus()
			break
		}
	}
	logf("exit %d", code)
	poweroff()
}
