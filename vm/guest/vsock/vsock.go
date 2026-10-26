// Package vsock is a minimal AF_VSOCK listener; Go's net package does not accept vsock fds.
package vsock

import (
	"os"

	"golang.org/x/sys/unix"
)

type Listener struct{ fd int }

func Listen(port uint32) (*Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if err := unix.Listen(fd, 16); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &Listener{fd: fd}, nil
}

// Accept blocks for the next connection and returns it as a file (Read, Write, Close).
func (l *Listener) Accept() (*os.File, error) {
	for {
		nfd, _, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return nil, err
		}
		return os.NewFile(uintptr(nfd), "vsock"), nil
	}
}
