// L1 supervisor: PID 1 of the outer Virtualization-framework microVM (docs/design.md §3.6).
//
// Loads the vsock modules, boots one Firecracker L2 guest with dirty-page tracking, takes a full
// base snapshot, then serves envgit's requests on vsock port 1024: exec/export/import go to the L2
// agent; snapshot takes a diff; restore merges base + diffs along the parent chain and loads it in a
// fresh Firecracker process. Snapshots live in this VM's tmpfs while it runs.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"envgit/vm/guest/proto"
	"envgit/vm/guest/vsock"

	"golang.org/x/sys/unix"
)

const (
	hostPort  = 1024
	agentPort = 1024
	vsockUDS  = "/tmp/v.sock"
	snapDir   = "/tmp/snaps"
)

func logf(f string, a ...any) { fmt.Printf("[l1] "+f+"\n", a...) }

type snapshot struct {
	id, parent, kind string
}

type supervisor struct {
	mu      sync.Mutex // one state-changing operation at a time
	fc      *firecracker
	snaps   map[string]snapshot
	base    string
	current string // snapshot the running guest descends from
	l2mem   int
}

func main() {
	for _, m := range [][3]string{{"proc", "/proc", "proc"}, {"sysfs", "/sys", "sysfs"}, {"devtmpfs", "/dev", "devtmpfs"}} {
		_ = os.MkdirAll(m[1], 0o755)
		_ = syscall.Mount(m[0], m[1], m[2], 0, "")
	}
	_ = syscall.Mount("tmpfs", "/tmp", "tmpfs", 0, "size=90%")
	_ = os.MkdirAll(snapDir, 0o755)
	for _, m := range []string{"vsock", "vmw_vsock_virtio_transport_common", "vmw_vsock_virtio_transport"} {
		if err := loadModule("/modules/" + m + ".ko"); err != nil {
			logf("load %s: %v", m, err)
		}
	}
	s := &supervisor{snaps: map[string]snapshot{}, l2mem: cmdlineInt("envgit.l2mem", 1024)}
	if err := s.boot(); err != nil {
		logf("boot failed: %v", err)
		poweroff()
	}
	ln, err := vsock.Listen(hostPort)
	if err != nil {
		logf("listen: %v", err)
		poweroff()
	}
	logf("ready base=%s", s.base)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go s.serve(c)
	}
}

func cmdlineInt(key string, def int) int {
	b, _ := os.ReadFile("/proc/cmdline")
	if m := regexp.MustCompile(regexp.QuoteMeta(key) + `=(\d+)`).FindSubmatch(b); m != nil {
		n, _ := strconv.Atoi(string(m[1]))
		return n
	}
	return def
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

func poweroff() {
	syscall.Sync()
	_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	select {}
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- Firecracker process + API ----

type firecracker struct {
	cmd  *exec.Cmd
	http *http.Client
}

func startFirecracker(sock string) (*firecracker, error) {
	_ = os.Remove(sock)
	_ = os.Remove(vsockUDS)
	cmd := exec.Command("/fc/firecracker", "--api-sock", sock, "--level", "Warning")
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			fmt.Println("[l2] " + sc.Text())
		}
	}()
	f := &firecracker{cmd: cmd, http: &http.Client{Transport: &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) {
		return net.Dial("unix", sock)
	}}}}
	for i := 0; i < 200; i++ {
		if _, err := os.Stat(sock); err == nil {
			return f, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.kill()
	return nil, fmt.Errorf("firecracker api socket never appeared")
}

func (f *firecracker) api(method, path, body string) error {
	req, _ := http.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := f.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

func (f *firecracker) kill() {
	_ = f.cmd.Process.Kill()
	_ = f.cmd.Wait()
}

// ---- L2 agent over Firecracker's vsock (host-initiated: CONNECT <port>) ----

func dialAgent() (net.Conn, error) {
	c, err := net.Dial("unix", vsockUDS)
	if err != nil {
		return nil, err
	}
	if _, err := fmt.Fprintf(c, "CONNECT %d\n", agentPort); err != nil {
		c.Close()
		return nil, err
	}
	// Read the "OK <port>\n" line byte by byte so no frame bytes are buffered away.
	var line []byte
	b := make([]byte, 1)
	for {
		if _, err := c.Read(b); err != nil {
			c.Close()
			return nil, err
		}
		if b[0] == '\n' {
			break
		}
		line = append(line, b[0])
	}
	if !strings.HasPrefix(string(line), "OK") {
		c.Close()
		return nil, fmt.Errorf("vsock connect: %s", line)
	}
	return c, nil
}

func waitAgent(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c, err := dialAgent(); err == nil {
			_ = c.SetDeadline(time.Now().Add(2 * time.Second))
			if proto.Write(c, proto.Msg{Op: "ping"}) == nil {
				if m, err := proto.Read(c); err == nil && m.Op == "pong" {
					c.Close()
					return nil
				}
			}
			c.Close()
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("L2 agent not reachable after %s", timeout)
}

// ---- lifecycle ----

func (s *supervisor) boot() error {
	t0 := time.Now()
	fc, err := startFirecracker("/tmp/fc.sock")
	if err != nil {
		return err
	}
	for _, c := range [][3]string{
		{"PUT", "/machine-config", fmt.Sprintf(`{"vcpu_count":2,"mem_size_mib":%d,"track_dirty_pages":true}`, s.l2mem)},
		{"PUT", "/boot-source", `{"kernel_image_path":"/fc/vmlinux","initrd_path":"/fc/l2-initrd.cpio","boot_args":"console=ttyS0 reboot=k panic=1 rdinit=/init"}`},
		{"PUT", "/drives/rootfs", `{"drive_id":"rootfs","path_on_host":"/fc/rootfs.squashfs","is_root_device":false,"is_read_only":true}`},
		{"PUT", "/vsock", `{"guest_cid":3,"uds_path":"` + vsockUDS + `"}`},
		{"PUT", "/actions", `{"action_type":"InstanceStart"}`},
	} {
		if err := fc.api(c[0], c[1], c[2]); err != nil {
			fc.kill()
			return err
		}
	}
	if err := waitAgent(60 * time.Second); err != nil {
		fc.kill()
		return err
	}
	s.fc = fc
	logf("L2 up in %s", time.Since(t0).Round(time.Millisecond))
	id, err := s.takeSnapshot("Full", "")
	if err != nil {
		return err
	}
	s.base, s.current = id, id
	return nil
}

func (s *supervisor) takeSnapshot(kind, parent string) (string, error) {
	id := newID()
	dir := snapDir + "/" + id
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := s.fc.api("PATCH", "/vm", `{"state":"Paused"}`); err != nil {
		return "", err
	}
	err := s.fc.api("PUT", "/snapshot/create", fmt.Sprintf(`{"snapshot_type":"%s","snapshot_path":"%s/state","mem_file_path":"%s/mem"}`, kind, dir, dir))
	if rerr := s.fc.api("PATCH", "/vm", `{"state":"Resumed"}`); err == nil {
		err = rerr
	}
	if err != nil {
		return "", err
	}
	s.snaps[id] = snapshot{id: id, parent: parent, kind: kind}
	return id, nil
}

func allocated(path string) int64 {
	var st syscall.Stat_t
	if syscall.Stat(path, &st) != nil {
		return -1
	}
	return st.Blocks * 512
}

// restore loads snapshot id: base memory with every diff on the way from base to id folded in.
func (s *supervisor) restore(id string) error {
	var chain []snapshot
	for cur := id; cur != ""; cur = s.snaps[cur].parent {
		sn, ok := s.snaps[cur]
		if !ok {
			return fmt.Errorf("unknown snapshot %s", cur)
		}
		chain = append([]snapshot{sn}, chain...)
	}
	if chain[0].kind != "Full" {
		return fmt.Errorf("snapshot chain of %s does not start at a full snapshot", id)
	}
	mem := snapDir + "/" + chain[0].id + "/mem"
	if len(chain) > 1 {
		merged := "/tmp/merged.mem"
		_ = os.Remove(merged)
		if out, err := exec.Command("cp", "--sparse=always", mem, merged).CombinedOutput(); err != nil {
			// No coreutils in L1: copy in Go.
			if err := copyFile(mem, merged); err != nil {
				return fmt.Errorf("copy base memory: %v %s", err, out)
			}
		}
		for _, sn := range chain[1:] {
			if out, err := exec.Command("/fc/rebase-snap", "--base-file", merged, "--diff-file", snapDir+"/"+sn.id+"/mem").CombinedOutput(); err != nil {
				return fmt.Errorf("rebase-snap: %v %s", err, out)
			}
		}
		mem = merged
	}
	if s.fc != nil {
		s.fc.kill()
	}
	fc, err := startFirecracker(fmt.Sprintf("/tmp/fc-%s.sock", id))
	if err != nil {
		return err
	}
	body := fmt.Sprintf(`{"snapshot_path":"%s/%s/state","mem_backend":{"backend_type":"File","backend_path":"%s"},"track_dirty_pages":true,"resume_vm":true}`, snapDir, id, mem)
	if err := fc.api("PUT", "/snapshot/load", body); err != nil {
		fc.kill()
		return err
	}
	s.fc = fc
	s.current = id
	return waitAgent(10 * time.Second)
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
	buf := make([]byte, 1<<20)
	zero := make([]byte, len(buf))
	var off int64
	for {
		n, err := in.Read(buf)
		if n > 0 {
			// Keep holes: skip writing all-zero blocks.
			if string(buf[:n]) != string(zero[:n]) {
				if _, werr := out.WriteAt(buf[:n], off); werr != nil {
					out.Close()
					return werr
				}
			}
			off += int64(n)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			out.Close()
			return err
		}
	}
	if err := out.Truncate(off); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ---- host requests ----

func (s *supervisor) serve(c io.ReadWriteCloser) {
	defer c.Close()
	m, err := proto.Read(c)
	if err != nil {
		return
	}
	switch m.Op {
	case "status":
		s.mu.Lock()
		_ = proto.Write(c, proto.Msg{Op: "status", Base: s.base, Current: s.current})
		s.mu.Unlock()
	case "exec", "export", "import":
		s.relay(c, m)
	case "snapshot":
		s.mu.Lock()
		t0 := time.Now()
		id, err := s.takeSnapshot("Diff", s.current)
		if err == nil {
			s.current = id
		}
		s.mu.Unlock()
		if err != nil {
			proto.Fail(c, err)
			return
		}
		_ = proto.Write(c, proto.Msg{ID: id, Parent: s.snaps[id].parent, Ms: ms(time.Since(t0)), Bytes: allocated(snapDir + "/" + id + "/mem")})
	case "restore":
		s.mu.Lock()
		t0 := time.Now()
		err := s.restore(m.ID)
		s.mu.Unlock()
		if err != nil {
			proto.Fail(c, err)
			return
		}
		_ = proto.Write(c, proto.Msg{ID: m.ID, Ms: ms(time.Since(t0))})
	case "shutdown":
		_ = proto.Write(c, proto.Msg{Op: "bye"})
		c.Close()
		if s.fc != nil {
			s.fc.kill()
		}
		poweroff()
	default:
		proto.Fail(c, fmt.Errorf("unknown op %q", m.Op))
	}
}

// relay forwards one request (and its body) to the L2 agent and the reply (and its body) back.
func (s *supervisor) relay(c io.ReadWriteCloser, m proto.Msg) {
	a, err := dialAgent()
	if err != nil {
		proto.Fail(c, err)
		return
	}
	defer a.Close()
	if err := proto.Write(a, m); err != nil {
		proto.Fail(c, err)
		return
	}
	if m.Size > 0 {
		if _, err := io.CopyN(a, c, m.Size); err != nil {
			proto.Fail(c, err)
			return
		}
	}
	reply, err := proto.Read(a)
	if err != nil {
		proto.Fail(c, err)
		return
	}
	if err := proto.Write(c, reply); err != nil {
		return
	}
	if reply.Size > 0 {
		_, _ = io.CopyN(c, a, reply.Size)
	}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
