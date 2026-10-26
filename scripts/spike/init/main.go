// Spike: /init for the outer VZ microVM. Mode comes from the kernel command line (envgit.mode=):
//
//	probe  report whether /dev/kvm works (nested virtualization)
//	tick   print a counter every second (to see VZ save/restore keep process state)
//	dirty  like tick, after filling 256 MiB of memory
//	fc     boot Firecracker inside, measure full/diff snapshots, restore and rebase
//
// Every measurement is printed as a "RESULT key=value" line on the console.
// See docs/spike-nested-firecracker.md.
package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

func result(k string, v any) { fmt.Printf("RESULT %s=%v\n", k, v) }
func logf(f string, a ...any) { fmt.Printf("[init] "+f+"\n", a...) }

func main() {
	mounts := [][3]string{{"proc", "/proc", "proc"}, {"sysfs", "/sys", "sysfs"}, {"devtmpfs", "/dev", "devtmpfs"}, {"tmpfs", "/tmp", "tmpfs"}}
	for _, m := range mounts {
		_ = os.MkdirAll(m[1], 0o755)
		if err := syscall.Mount(m[0], m[1], m[2], 0, ""); err != nil {
			logf("mount %s: %v", m[1], err)
		}
	}
	cmdline, _ := os.ReadFile("/proc/cmdline")
	mode := "probe"
	if m := regexp.MustCompile(`envgit\.mode=(\w+)`).FindSubmatch(cmdline); m != nil {
		mode = string(m[1])
	}
	var uts syscall.Utsname
	_ = syscall.Uname(&uts)
	logf("mode=%s kernel=%s", mode, charsToString(uts.Release[:]))

	switch mode {
	case "tick", "dirty":
		var hold []byte
		if mode == "dirty" {
			// Touch 256 MiB of random data so a VM save has real memory to write.
			hold = make([]byte, 256<<20)
			for i := range hold {
				hold[i] = byte(i*2654435761>>13) ^ byte(i>>7)
			}
			logf("dirtied %d MiB", len(hold)>>20)
		}
		for i := 1; ; i++ {
			fmt.Printf("tick %d %s %d\n", i, time.Now().Format("15:04:05.000"), len(hold))
			time.Sleep(time.Second)
		}
	case "fc":
		if probe() {
			firecracker()
		}
	default:
		probe()
	}
	syscall.Sync()
	_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
}

func probe() bool {
	f, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err != nil {
		result("kvm", "absent: "+err.Error())
		return false
	}
	defer f.Close()
	const KVM_GET_API_VERSION = 0xAE00
	v, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), KVM_GET_API_VERSION, 0)
	if errno != 0 {
		result("kvm", "ioctl failed: "+errno.Error())
		return false
	}
	result("kvm", fmt.Sprintf("ok api=%d", v))
	return true
}

// ---- Firecracker -------------------------------------------------------------------------

type fc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	sock  string
	lines chan string
	http  *http.Client
	tick  atomic.Int64 // latest "tick N" seen on the guest console
}

func startFC(sock string) (*fc, error) {
	_ = os.Remove(sock)
	cmd := exec.Command("/fc/firecracker", "--api-sock", sock, "--level", "Warning")
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	f := &fc{cmd: cmd, stdin: stdin, sock: sock, lines: make(chan string, 4096)}
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			fmt.Println("  [L2] " + line)
			if n := tickOf(line); n > 0 {
				f.tick.Store(int64(n))
			}
			select {
			case f.lines <- line:
			default:
			}
		}
	}()
	f.http = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return net.Dial("unix", sock)
	}}}
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(sock); err == nil {
			return f, nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return nil, fmt.Errorf("api socket never appeared")
}

func (f *fc) api(method, path, body string) (time.Duration, error) {
	req, _ := http.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	t0 := time.Now()
	res, err := f.http.Do(req)
	d := time.Since(t0)
	if err != nil {
		return d, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return d, fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, bytes.TrimSpace(b))
	}
	return d, nil
}

func (f *fc) must(method, path, body string) time.Duration {
	d, err := f.api(method, path, body)
	if err != nil {
		result("error", err.Error())
		panic(err)
	}
	return d
}

// ping measures the round trip of a shell command through the guest console.
func (f *fc) ping(tag string, timeout time.Duration) time.Duration {
	t0 := time.Now()
	f.send("echo " + tag)
	// The shell may prefix its output with a "# " prompt.
	if f.waitFor("^(# )?"+tag+"$", timeout) == "" {
		result("ping_timeout", tag)
		return -1
	}
	return time.Since(t0)
}

// waitFor returns the first L2 console line matching re, or "" on timeout.
func (f *fc) waitFor(re string, timeout time.Duration) string {
	r := regexp.MustCompile(re)
	deadline := time.After(timeout)
	for {
		select {
		case l := <-f.lines:
			if r.MatchString(l) {
				return l
			}
		case <-deadline:
			return ""
		}
	}
}

func (f *fc) send(cmd string) { _, _ = io.WriteString(f.stdin, cmd+"\n") }

func (f *fc) kill() { _ = f.cmd.Process.Kill(); _ = f.cmd.Wait() }

func fileSizes(path string) (int64, int64) {
	var st syscall.Stat_t
	if syscall.Stat(path, &st) != nil {
		return -1, -1
	}
	return st.Size, st.Blocks * 512
}

func ms(d time.Duration) string { return strconv.FormatFloat(float64(d.Microseconds())/1000, 'f', 1, 64) + "ms" }

func tickOf(line string) int {
	m := regexp.MustCompile(`tick (\d+)`).FindStringSubmatch(line)
	if m == nil {
		return -1
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

func firecracker() {
	defer func() {
		if r := recover(); r != nil {
			logf("firecracker test aborted: %v", r)
		}
	}()
	f, err := startFC("/tmp/fc.sock")
	if err != nil {
		result("error", err.Error())
		return
	}
	f.must("PUT", "/machine-config", `{"vcpu_count":2,"mem_size_mib":512,"track_dirty_pages":true}`)
	f.must("PUT", "/boot-source", `{"kernel_image_path":"/fc/vmlinux","boot_args":"console=ttyS0 reboot=k panic=1 ro init=/bin/sh"}`)
	f.must("PUT", "/drives/rootfs", `{"drive_id":"rootfs","path_on_host":"/fc/rootfs.squashfs","is_root_device":true,"is_read_only":true}`)
	t0 := time.Now()
	f.must("PUT", "/actions", `{"action_type":"InstanceStart"}`)
	result("fc_instance_start_api", ms(time.Since(t0)))

	// Prove the guest runs: a shell with a background counter. Retry until the shell answers.
	var shellUp string
	for i := 0; i < 60 && shellUp == ""; i++ {
		f.send("echo shell-up")
		shellUp = f.waitFor(`^shell-up`, time.Second)
	}
	if shellUp == "" {
		result("fc_boot", "no shell within 60s")
		f.kill()
		return
	}
	result("fc_boot_to_shell", ms(time.Since(t0)))
	result("fc_console_roundtrip", ms(f.ping("ping-boot", 5*time.Second)))
	f.send("mount -t tmpfs -o size=300m tmpfs /tmp; i=0; while true; do i=$((i+1)); echo tick $i; sleep 1; done &")
	f.waitFor(`tick 3`, 30*time.Second)
	// Same busy loop as cpu_host_dash_loop in the write-up, inside the L2 guest.
	f.send(`s=$(date +%s%N); i=0; while [ $i -lt 1000000 ]; do i=$((i+1)); done; e=$(date +%s%N); echo cpu-l2 $(( (e-s)/1000000 ))ms`)
	result("cpu_l2_dash_loop_1M", strings.TrimPrefix(f.waitFor(`^cpu-l2 `, 120*time.Second), "cpu-l2 "))

	// Full snapshot.
	f.must("PATCH", "/vm", `{"state":"Paused"}`)
	tPaused := int(f.tick.Load())
	d := f.must("PUT", "/snapshot/create", `{"snapshot_type":"Full","snapshot_path":"/tmp/full.state","mem_file_path":"/tmp/full.mem"}`)
	size, alloc := fileSizes("/tmp/full.mem")
	result("snap_full_create", ms(d))
	result("snap_full_mem", fmt.Sprintf("%d bytes (%d allocated)", size, alloc))
	f.must("PATCH", "/vm", `{"state":"Resumed"}`)
	_ = tPaused

	// Quiet diff: little should have changed.
	time.Sleep(2 * time.Second)
	f.must("PATCH", "/vm", `{"state":"Paused"}`)
	d = f.must("PUT", "/snapshot/create", `{"snapshot_type":"Diff","snapshot_path":"/tmp/diff1.state","mem_file_path":"/tmp/diff1.mem"}`)
	size, alloc = fileSizes("/tmp/diff1.mem")
	result("snap_diff_quiet_create", ms(d))
	result("snap_diff_quiet_mem", fmt.Sprintf("%d bytes (%d allocated)", size, alloc))
	f.must("PATCH", "/vm", `{"state":"Resumed"}`)

	// Dirty 128 MiB, then diff again.
	f.send("dd if=/dev/urandom of=/tmp/x bs=1M count=128 2>&1 | tail -1; echo dd-done")
	if f.waitFor(`^dd-done`, 120*time.Second) == "" {
		result("dirty_workload", "timed out")
	}
	f.must("PATCH", "/vm", `{"state":"Paused"}`)
	d = f.must("PUT", "/snapshot/create", `{"snapshot_type":"Diff","snapshot_path":"/tmp/diff2.state","mem_file_path":"/tmp/diff2.mem"}`)
	size, alloc = fileSizes("/tmp/diff2.mem")
	result("snap_diff_128m_create", ms(d))
	result("snap_diff_128m_mem", fmt.Sprintf("%d bytes (%d allocated)", size, alloc))
	f.must("PATCH", "/vm", `{"state":"Resumed"}`)
	time.Sleep(1500 * time.Millisecond)
	lastTick := int(f.tick.Load())
	f.kill()
	logf("killed first firecracker at tick %d", lastTick)

	// Restore the full snapshot in a fresh Firecracker process.
	g, err := startFC("/tmp/fc2.sock")
	if err != nil {
		result("error", err.Error())
		return
	}
	t0 = time.Now()
	d = g.must("PUT", "/snapshot/load", `{"snapshot_path":"/tmp/full.state","mem_backend":{"backend_type":"File","backend_path":"/tmp/full.mem"},"resume_vm":true}`)
	result("snap_load_full_api", ms(d))
	rtt := g.ping("ping-full", 10*time.Second)
	result("snap_load_full_console_rtt_after_load", ms(rtt))
	result("snap_load_full_total_to_reply", ms(time.Since(t0)))
	line := g.waitFor(`tick \d+`, 5*time.Second)
	result("snap_load_full_tick_after_restore", fmt.Sprintf("%d (counter was %d at snapshot, %d before kill)", tickOf(line), tPaused, lastTick))
	g.kill()

	// Rebase: fold the 128 MiB diff onto a copy of the full memory file, then load it.
	if err := copyFile("/tmp/full.mem", "/tmp/merged.mem"); err != nil {
		result("error", err.Error())
		return
	}
	for _, diff := range []string{"/tmp/diff1.mem", "/tmp/diff2.mem"} {
		t0 = time.Now()
		out, err := exec.Command("/fc/rebase-snap", "--base-file", "/tmp/merged.mem", "--diff-file", diff).CombinedOutput()
		if err != nil {
			result("error", fmt.Sprintf("rebase-snap %s: %v %s", diff, err, out))
			return
		}
		result("rebase_"+strings.TrimSuffix(strings.TrimPrefix(diff, "/tmp/"), ".mem"), ms(time.Since(t0)))
	}
	h, err := startFC("/tmp/fc3.sock")
	if err != nil {
		result("error", err.Error())
		return
	}
	t0 = time.Now()
	h.must("PUT", "/snapshot/load", `{"snapshot_path":"/tmp/diff2.state","mem_backend":{"backend_type":"File","backend_path":"/tmp/merged.mem"},"resume_vm":true}`)
	h.ping("ping-rebased", 10*time.Second)
	result("snap_load_rebased_total_to_reply", ms(time.Since(t0)))
	line = h.waitFor(`tick \d+`, 5*time.Second)
	h.send("wc -c < /tmp/x; echo wc-done")
	result("snap_load_rebased_tmpfs_file_bytes", h.waitFor(`^[0-9]+$`, 5*time.Second))
	result("snap_load_rebased_tick", fmt.Sprintf("%d (counter was %d before kill)", tickOf(line), lastTick))
	h.kill()

	// CPU: the same busy loop in this (L1) guest; the L2 number comes from the guest shell.
	result("cpu_l1_loop_100M", ms(busy(100_000_000)))
}

func busy(n int) time.Duration {
	t0 := time.Now()
	x := 0
	for i := 0; i < n; i++ {
		x += i ^ (x >> 3)
	}
	if x == 42 {
		fmt.Println()
	}
	return time.Since(t0)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

func charsToString(ca []int8) string {
	b := make([]byte, 0, len(ca))
	for _, c := range ca {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}
