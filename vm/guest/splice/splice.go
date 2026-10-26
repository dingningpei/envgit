// Package splice joins two byte streams full-duplex, the way the egress tunnel needs
// (docs/design.md §3.6): each direction is copied until EOF, then half-closed on the other side so
// the peer sees the end of the request while the response keeps flowing.
package splice

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// Join copies a→b and b→a until both directions end, then closes both.
func Join(a, b io.ReadWriteCloser) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { _, _ = io.Copy(b, a); closeWrite(b); wg.Done() }()
	go func() { _, _ = io.Copy(a, b); closeWrite(a); wg.Done() }()
	wg.Wait()
	a.Close()
	b.Close()
}

func closeWrite(c io.Writer) {
	switch x := c.(type) {
	case interface{ CloseWrite() error }:
		_ = x.CloseWrite()
	case *os.File:
		if rc, err := x.SyscallConn(); err == nil {
			_ = rc.Control(func(fd uintptr) { _ = unix.Shutdown(int(fd), unix.SHUT_WR) })
		}
	}
}

// Refuse answers a proxy client that has no host proxy behind it (no step is running) with an HTTP
// error whose body starts with "envgit: ", so an agent can tell policy from a broken network.
func Refuse(c net.Conn) {
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = bufio.NewReader(c).ReadString('\n') // the request line; the rest does not matter
	Unavailable(c)
}

// Unavailable is Refuse for a client whose request head was already read.
func Unavailable(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	body := "envgit: the sandbox has network access only while a step runs (envgit run)\n"
	_, _ = fmt.Fprintf(c, "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
}
