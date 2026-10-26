// L2 agent: PID 1 inside the Firecracker guest (docs/design.md §3.6).
//
// Mounts the read-only CI rootfs under a tmpfs overlay, so every write — including /work, the
// workdir — lives in guest memory and is captured by Firecracker's memory snapshots. Serves exec,
// export and import on vsock port 1024, and reaps every orphan as PID 1.
package main

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"envgit/vm/guest/proto"
	"envgit/vm/guest/vsock"
)

const (
	port    = 1024
	root    = "/newroot"
	workdir = "/work"
	maxOut  = 1 << 20
)

func logf(f string, a ...any) { fmt.Printf("[agent] "+f+"\n", a...) }

func main() {
	if err := setup(); err != nil {
		logf("setup failed: %v", err)
	}
	go reap()
	ln, err := vsock.Listen(port)
	if err != nil {
		logf("listen: %v", err)
		select {}
	}
	logf("ready on vsock port %d", port)
	for {
		c, err := ln.Accept()
		if err != nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		go serve(c)
	}
}

func setup() error {
	mounts := []struct{ src, dst, typ, opts string }{
		{"proc", "/proc", "proc", ""},
		{"sysfs", "/sys", "sysfs", ""},
		{"devtmpfs", "/dev", "devtmpfs", ""},
	}
	for _, m := range mounts {
		_ = os.MkdirAll(m.dst, 0o755)
		if err := syscall.Mount(m.src, m.dst, m.typ, 0, m.opts); err != nil && err != syscall.EBUSY {
			logf("mount %s: %v", m.dst, err)
		}
	}
	if err := syscall.Mount("/dev/vda", "/ro", "squashfs", syscall.MS_RDONLY, ""); err != nil {
		return fmt.Errorf("mount rootfs: %w", err)
	}
	if err := syscall.Mount("tmpfs", "/rw", "tmpfs", 0, "mode=0755"); err != nil {
		return fmt.Errorf("mount tmpfs: %w", err)
	}
	_ = os.MkdirAll("/rw/upper", 0o755)
	_ = os.MkdirAll("/rw/work", 0o755)
	if err := syscall.Mount("overlay", root, "overlay", 0, "lowerdir=/ro,upperdir=/rw/upper,workdir=/rw/work"); err != nil {
		return fmt.Errorf("mount overlay: %w", err)
	}
	for _, m := range []struct{ src, dst, typ string }{{"proc", "/proc", "proc"}, {"sysfs", "/sys", "sysfs"}, {"devtmpfs", "/dev", "devtmpfs"}, {"tmpfs", "/tmp", "tmpfs"}} {
		_ = os.MkdirAll(root+m.dst, 0o755)
		if err := syscall.Mount(m.src, root+m.dst, m.typ, 0, ""); err != nil {
			logf("mount %s in root: %v", m.dst, err)
		}
	}
	return os.MkdirAll(root+workdir, 0o755)
}

// ---- process management: PID 1 reaps everything; exec waits through the reaper ----

var (
	mu      sync.Mutex
	waiters = map[int]chan syscall.WaitStatus{}
	early   = map[int]syscall.WaitStatus{}
)

func reap() {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, 0, nil)
		if err != nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		mu.Lock()
		if ch, ok := waiters[pid]; ok {
			ch <- ws
			delete(waiters, pid)
		} else {
			early[pid] = ws
		}
		mu.Unlock()
	}
}

func waitFor(pid int) chan syscall.WaitStatus {
	ch := make(chan syscall.WaitStatus, 1)
	mu.Lock()
	if ws, ok := early[pid]; ok {
		ch <- ws
		delete(early, pid)
	} else {
		waiters[pid] = ch
	}
	mu.Unlock()
	return ch
}

type capped struct {
	bytes.Buffer
	dropped bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := maxOut - c.Len(); room > 0 {
		if len(p) > room {
			c.Buffer.Write(p[:room])
			c.dropped = true
		} else {
			c.Buffer.Write(p)
		}
	} else {
		c.dropped = true
	}
	return len(p), nil
}

func (c *capped) String() string {
	if c.dropped {
		return c.Buffer.String() + "\n[output truncated]"
	}
	return c.Buffer.String()
}

func execute(m proto.Msg) proto.Msg {
	if len(m.Argv) == 0 {
		return proto.Msg{Error: "empty argv"}
	}
	outR, outW, _ := os.Pipe()
	errR, errW, _ := os.Pipe()
	devnull, _ := os.Open("/dev/null")
	attr := &syscall.ProcAttr{
		Dir:   workdir,
		Env:   []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "TERM=dumb", "LANG=C.UTF-8"},
		Files: []uintptr{devnull.Fd(), outW.Fd(), errW.Fd()},
		Sys:   &syscall.SysProcAttr{Chroot: root, Setpgid: true},
	}
	argv0 := m.Argv[0]
	if !strings.Contains(argv0, "/") {
		argv0 = lookPath(argv0)
	}
	pid, err := syscall.ForkExec(argv0, m.Argv, attr)
	outW.Close()
	errW.Close()
	devnull.Close()
	if err != nil {
		outR.Close()
		errR.Close()
		return proto.Msg{Exit: 127, Stderr: fmt.Sprintf("%s: %v", m.Argv[0], err)}
	}
	done := waitFor(pid)
	var stdout, stderr capped
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { io.Copy(&stdout, outR); outR.Close(); wg.Done() }()
	go func() { io.Copy(&stderr, errR); errR.Close(); wg.Done() }()

	timeout := time.Duration(m.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	var ws syscall.WaitStatus
	select {
	case ws = <-done:
	case <-time.After(timeout):
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		ws = <-done
		stderr.WriteString(fmt.Sprintf("\n[envgit] killed after %s", timeout))
	}
	// Background children keep the pipes open; give output a moment, then stop waiting for it.
	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(200 * time.Millisecond):
	}
	exit := ws.ExitStatus()
	if ws.Signaled() {
		exit = 128 + int(ws.Signal())
	}
	return proto.Msg{Exit: exit, Stdout: stdout.String(), Stderr: stderr.String()}
}

func lookPath(name string) string {
	for _, dir := range []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"} {
		if st, err := os.Stat(root + dir + "/" + name); err == nil && !st.IsDir() {
			return dir + "/" + name
		}
	}
	return name
}

// ---- workdir transfer as tar ----

// entry is one file or symlink under /work in an export listing. Key changes whenever the entry
// might have: ctime cannot be set from userspace, so a rewrite that restores size and mtime still shows.
type entry struct {
	Path string `json:"p"`
	Key  string `json:"k"`
}

// exportTar lists every file and symlink under /work and tars the ones whose key differs from
// `known` (what the host already has). The reply body is a 4-byte length, the listing as JSON, then
// the tar — so a step that changed one file sends one file.
func exportTar(known map[string]string) ([]byte, error) {
	var listing []entry
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	base := root + workdir
	err := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == base || d.IsDir() {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&fs.ModeSymlink != 0 {
			link, _ = os.Readlink(path)
		} else if !info.Mode().IsRegular() {
			return nil
		}
		rel, _ := filepath.Rel(base, path)
		rel = filepath.ToSlash(rel)
		st := info.Sys().(*syscall.Stat_t)
		key := fmt.Sprintf("%d:%d:%d.%d:%o", st.Ino, info.Size(), st.Ctim.Sec, st.Ctim.Nsec, uint32(info.Mode()))
		listing = append(listing, entry{Path: rel, Key: key})
		if known[rel] == key {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		hdr.Name = rel
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, f)
			f.Close()
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	idx, err := json.Marshal(listing)
	if err != nil {
		return nil, err
	}
	out := binary.BigEndian.AppendUint32(make([]byte, 0, 4+len(idx)+buf.Len()), uint32(len(idx)))
	return append(append(out, idx...), buf.Bytes()...), nil
}

func importTar(r io.Reader) error {
	base := root + workdir
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(base, filepath.Clean("/"+hdr.Name))
		if target == base {
			continue
		}
		if !strings.HasPrefix(target, base+"/") {
			return fmt.Errorf("unsafe path in tar: %s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, fs.FileMode(hdr.Mode)&0o7777|0o700); err != nil {
				return err
			}
		case tar.TypeSymlink:
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.Remove(target)
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeReg:
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.Remove(target)
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fs.FileMode(hdr.Mode)&0o7777)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
			_ = os.Chtimes(target, hdr.ModTime, hdr.ModTime)
		}
	}
}

func serve(c io.ReadWriteCloser) {
	defer c.Close()
	m, err := proto.Read(c)
	if err != nil {
		return
	}
	switch m.Op {
	case "ping":
		_ = proto.Write(c, proto.Msg{Op: "pong"})
	case "exec":
		_ = proto.Write(c, execute(m))
	case "export":
		known := map[string]string{}
		if m.Size > 0 {
			if err := json.NewDecoder(io.LimitReader(c, m.Size)).Decode(&known); err != nil {
				proto.Fail(c, err)
				return
			}
		}
		b, err := exportTar(known)
		if err != nil {
			proto.Fail(c, err)
			return
		}
		if proto.Write(c, proto.Msg{Size: int64(len(b))}) == nil {
			_, _ = c.Write(b)
		}
	case "import":
		if err := importTar(io.LimitReader(c, m.Size)); err != nil {
			proto.Fail(c, err)
			return
		}
		_ = proto.Write(c, proto.Msg{Op: "imported"})
	default:
		proto.Fail(c, fmt.Errorf("unknown op %q", m.Op))
	}
}
