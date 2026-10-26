// L1 supervisor: PID 1 of the outer Virtualization-framework microVM (docs/design.md §3.6).
//
// Loads the vsock and virtiofs modules, mounts the host's snapshot directory, then serves envgit's
// requests on vsock port 1024: boot starts a fresh L2 guest and takes a full base snapshot;
// exec/export/import go to the L2 agent; snapshot takes a diff; restore merges base + diffs along the
// parent chain and loads it in a fresh Firecracker process. Every snapshot is written to the host
// share before it is acknowledged, so the host keeps them across L1 restarts; this VM's tmpfs holds
// only the base memory of the current chain (as a cache) and whatever is in flight.
//
// Egress: L2's proxy connections to the host arrive on Firecracker's vsock UDS for port 3128 and are
// passed on, one vsock connection each, to the host (envgit-vm), which hands them to envgit.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
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
	"envgit/vm/guest/splice"
	"envgit/vm/guest/vsock"

	"golang.org/x/sys/unix"
)

const (
	hostPort  = 1024
	agentPort = 1024
	vsockUDS  = "/tmp/v.sock"
	snapDir   = "/tmp/snaps" // in flight, and the cached base memory
	hostDir   = "/host"      // virtiofs share of <workdir>/.envgit/vm/snaps
	proxyPort = 3128         // L2 → host egress tunnel, same number on every hop
)

func logf(f string, a ...any) { fmt.Printf("[l1] "+f+"\n", a...) }

type snapshot struct {
	ID     string `json:"id"`
	Parent string `json:"parent,omitempty"`
	Kind   string `json:"kind"`
}

type supervisor struct {
	mu      sync.Mutex // one state-changing operation at a time
	fc      *firecracker
	base    string // full snapshot at the root of the running guest's chain
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
	for _, m := range []string{"vsock", "vmw_vsock_virtio_transport_common", "vmw_vsock_virtio_transport", "virtiofs"} {
		if err := loadModule("/modules/" + m + ".ko"); err != nil {
			logf("load %s: %v", m, err)
		}
	}
	_ = os.MkdirAll(hostDir, 0o755)
	if err := syscall.Mount("envgit", hostDir, "virtiofs", 0, ""); err != nil {
		logf("mount host share: %v", err)
		poweroff()
	}
	s := &supervisor{l2mem: cmdlineInt("envgit.l2mem", 1024)}
	go egress()
	ln, err := vsock.Listen(hostPort)
	if err != nil {
		logf("listen: %v", err)
		poweroff()
	}
	logf("ready")
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
	if s.fc != nil {
		s.fc.kill()
		s.fc = nil
	}
	fc, err := startFirecracker("/tmp/fc.sock")
	if err != nil {
		return err
	}
	for _, c := range [][3]string{
		{"PUT", "/machine-config", fmt.Sprintf(`{"vcpu_count":2,"mem_size_mib":%d,"track_dirty_pages":true}`, s.l2mem)},
		{"PUT", "/boot-source", `{"kernel_image_path":"/fc/vmlinux","initrd_path":"/fc/l2-initrd.cpio","boot_args":"console=ttyS0 reboot=k panic=1 rdinit=/init"}`},
		// L1's own read-only disks (envgit-vm attaches them): L2 sees them as vda and vdb.
		{"PUT", "/drives/rootfs", `{"drive_id":"rootfs","path_on_host":"/dev/vda","is_root_device":false,"is_read_only":true}`},
		{"PUT", "/drives/layer", `{"drive_id":"layer","path_on_host":"/dev/vdb","is_root_device":false,"is_read_only":true}`},
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
	if s.base != "" {
		_ = os.RemoveAll(snapDir + "/" + s.base)
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
	if err == nil {
		err = persist(snapshot{ID: id, Parent: parent, Kind: kind})
	}
	if err == nil && kind == "Full" {
		// Firecracker wrote the base densely (1 GiB for 1 GiB of guest); the cache only needs its data.
		err = unpackMem(id, dir+"/mem")
	}
	if err != nil || kind != "Full" {
		// A diff is only needed again at restore, which reads it back from the host.
		_ = os.RemoveAll(dir)
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

// ---- snapshots on the host share ----
//
// <host>/<id>/meta.json  {"id","parent","kind"}
// <host>/<id>/state      Firecracker's microVM state
// <host>/<id>/mem.idx    little-endian uint64s: file size, then (offset, length) per data extent
// <host>/<id>/mem.dat    the extents' bytes, concatenated
//
// Memory files are sparse and a hole means "not in this diff" — different from a page that was
// written with zeros — so extents are recorded explicitly rather than trusting the share to keep holes.

func persist(sn snapshot) error {
	src := snapDir + "/" + sn.ID
	tmp := hostDir + "/.tmp-" + sn.ID
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	if err := copyPlain(src+"/state", tmp+"/state"); err != nil {
		return err
	}
	if err := packMem(src+"/mem", tmp+"/mem.idx", tmp+"/mem.dat", sn.Kind == "Full"); err != nil {
		return err
	}
	meta, _ := json.Marshal(sn)
	if err := writeSynced(tmp+"/meta.json", meta); err != nil {
		return err
	}
	return os.Rename(tmp, hostDir+"/"+sn.ID)
}

func readMeta(id string) (snapshot, error) {
	var sn snapshot
	b, err := os.ReadFile(hostDir + "/" + id + "/meta.json")
	if err != nil {
		return sn, fmt.Errorf("unknown snapshot %s", id)
	}
	return sn, json.Unmarshal(b, &sn)
}

// packMem writes src's data extents. With zerosAreHoles (a full snapshot, where an absent page reads
// as zeros anyway) all-zero pages are dropped too: Firecracker writes a full snapshot densely.
func packMem(src, idxPath, datPath string, zerosAreHoles bool) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	dat, err := os.Create(datPath)
	if err != nil {
		return err
	}
	defer dat.Close()
	w := bufio.NewWriterSize(dat, 1<<20)
	idx := binary.LittleEndian.AppendUint64(nil, uint64(st.Size()))
	// Extents are coalesced: a run continues while pages keep arriving back to back.
	var runStart, runEnd int64 = -1, -1
	emit := func(off int64, b []byte) error {
		if runEnd != off {
			if runStart >= 0 {
				idx = binary.LittleEndian.AppendUint64(idx, uint64(runStart))
				idx = binary.LittleEndian.AppendUint64(idx, uint64(runEnd-runStart))
			}
			runStart = off
		}
		runEnd = off + int64(len(b))
		_, err := w.Write(b)
		return err
	}
	const page = 4096
	buf := make([]byte, 1<<20)
	zero := make([]byte, page)
	fd := int(in.Fd())
	for off := int64(0); off < st.Size(); {
		start, err := unix.Seek(fd, off, unix.SEEK_DATA)
		if err == unix.ENXIO {
			break // no data after off
		}
		if err != nil {
			return err
		}
		end, err := unix.Seek(fd, start, unix.SEEK_HOLE)
		if err != nil {
			return err
		}
		for pos := start; pos < end; {
			n, err := in.ReadAt(buf[:min(int64(len(buf)), end-pos)], pos)
			if n == 0 && err != nil {
				return err
			}
			for p := 0; p < n; p += page {
				q := min(p+page, n)
				if zerosAreHoles && bytes.Equal(buf[p:q], zero[:q-p]) {
					continue
				}
				if err := emit(pos+int64(p), buf[p:q]); err != nil {
					return err
				}
			}
			pos += int64(n)
		}
		off = end
	}
	if runStart >= 0 {
		idx = binary.LittleEndian.AppendUint64(idx, uint64(runStart))
		idx = binary.LittleEndian.AppendUint64(idx, uint64(runEnd-runStart))
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if err := dat.Sync(); err != nil {
		return err
	}
	return writeSynced(idxPath, idx)
}

// unpackMem rebuilds a sparse memory file from a packed snapshot.
func unpackMem(id, dst string) error {
	idx, err := os.ReadFile(hostDir + "/" + id + "/mem.idx")
	if err != nil {
		return err
	}
	if len(idx) < 8 || (len(idx)-8)%16 != 0 {
		return fmt.Errorf("snapshot %s: corrupt mem.idx", id)
	}
	dat, err := os.Open(hostDir + "/" + id + "/mem.dat")
	if err != nil {
		return err
	}
	defer dat.Close()
	_ = os.Remove(dst)
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if err := out.Truncate(int64(binary.LittleEndian.Uint64(idx))); err != nil {
		return err
	}
	for p := 8; p < len(idx); p += 16 {
		off := int64(binary.LittleEndian.Uint64(idx[p:]))
		n := int64(binary.LittleEndian.Uint64(idx[p+8:]))
		if _, err := io.Copy(io.NewOffsetWriter(out, off), io.LimitReader(dat, n)); err != nil {
			return err
		}
	}
	return nil
}

func copyPlain(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return writeSynced(dst, b)
}

func writeSynced(path string, b []byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func allocated(path string) int64 {
	var st syscall.Stat_t
	if syscall.Stat(path, &st) != nil {
		return -1
	}
	return st.Size
}

// restore loads snapshot id: base memory with every diff on the way from base to id folded in.
func (s *supervisor) restore(id string) error {
	var chain []snapshot
	for cur := id; cur != ""; {
		sn, err := readMeta(cur)
		if err != nil {
			return err
		}
		chain = append([]snapshot{sn}, chain...)
		if len(chain) > 100000 {
			return fmt.Errorf("snapshot chain of %s loops", id)
		}
		cur = sn.Parent
	}
	if chain[0].Kind != "Full" {
		return fmt.Errorf("snapshot chain of %s does not start at a full snapshot", id)
	}
	base := chain[0].ID
	// The base memory stays in tmpfs while it is the root of the running chain.
	mem := snapDir + "/" + base + "/mem"
	if _, err := os.Stat(mem); err != nil {
		if s.base != "" && s.base != base {
			_ = os.RemoveAll(snapDir + "/" + s.base)
		}
		_ = os.MkdirAll(snapDir+"/"+base, 0o755)
		if err := unpackMem(base, mem); err != nil {
			return fmt.Errorf("load base memory: %v", err)
		}
	}
	if len(chain) > 1 {
		merged := "/tmp/merged.mem"
		_ = os.Remove(merged)
		if err := copyFile(mem, merged); err != nil {
			return fmt.Errorf("copy base memory: %v", err)
		}
		diff := "/tmp/diff.mem"
		for _, sn := range chain[1:] {
			if err := unpackMem(sn.ID, diff); err != nil {
				return fmt.Errorf("load diff %s: %v", sn.ID, err)
			}
			if out, err := exec.Command("/fc/rebase-snap", "--base-file", merged, "--diff-file", diff).CombinedOutput(); err != nil {
				return fmt.Errorf("rebase-snap: %v %s", err, out)
			}
		}
		_ = os.Remove(diff)
		mem = merged
	}
	state := "/tmp/state-" + id
	if err := copyPlain(hostDir+"/"+id+"/state", state); err != nil {
		return err
	}
	defer os.Remove(state)
	if s.fc != nil {
		s.fc.kill()
		s.fc = nil
	}
	fc, err := startFirecracker(fmt.Sprintf("/tmp/fc-%s.sock", id))
	if err != nil {
		return err
	}
	body := fmt.Sprintf(`{"snapshot_path":"%s","mem_backend":{"backend_type":"File","backend_path":"%s"},"track_dirty_pages":true,"resume_vm":true}`, state, mem)
	if err := fc.api("PUT", "/snapshot/load", body); err != nil {
		fc.kill()
		return err
	}
	s.fc = fc
	s.base, s.current = base, id
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
			// Keep holes: skip writing all-zero blocks (in a base, a hole and zeros mean the same).
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
	case "boot":
		s.mu.Lock()
		t0 := time.Now()
		err := s.boot()
		base := s.base
		s.mu.Unlock()
		if err != nil {
			proto.Fail(c, err)
			return
		}
		_ = proto.Write(c, proto.Msg{ID: base, Ms: ms(time.Since(t0))})
	case "exec", "export", "import", "trust", "install", "repl", "repl_kill":
		s.relay(c, m)
	case "snapshot":
		s.mu.Lock()
		if s.fc == nil {
			s.mu.Unlock()
			proto.Fail(c, fmt.Errorf("no L2 guest: boot or restore first"))
			return
		}
		t0 := time.Now()
		parent := s.current
		id, err := s.takeSnapshot("Diff", parent)
		if err == nil {
			s.current = id
		}
		s.mu.Unlock()
		if err != nil {
			proto.Fail(c, err)
			return
		}
		_ = proto.Write(c, proto.Msg{ID: id, Parent: parent, Ms: ms(time.Since(t0)), Bytes: allocated(hostDir + "/" + id + "/mem.dat")})
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

// egress forwards L2-initiated connections to the host. Firecracker turns a guest connect to
// (CID 2, port P) into a connection on "<vsock uds>_P"; the listener outlives Firecracker restarts.
func egress() {
	path := fmt.Sprintf("%s_%d", vsockUDS, proxyPort)
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		logf("egress listen: %v", err)
		return
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		go func() {
			up, err := vsock.Dial(unix.VMADDR_CID_HOST, proxyPort)
			if err != nil {
				// envgit-vm refuses while no envgit step is serving the proxy.
				splice.Refuse(c)
				return
			}
			splice.Join(c, up)
		}()
	}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
