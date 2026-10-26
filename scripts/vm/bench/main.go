// bench: the same workloads on the host and inside L2, to size the nested-virtualization overhead
// (docs/design.md §3.6). Build for darwin/arm64 and linux/arm64; run both; compare.
package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

func timeit(name string, f func()) {
	best := time.Duration(1<<63 - 1)
	for i := 0; i < 3; i++ {
		t0 := time.Now()
		f()
		best = min(best, time.Since(t0))
	}
	fmt.Printf("%-28s %8.1f ms\n", name, float64(best.Microseconds())/1000)
}

func main() {
	buf := make([]byte, 64<<20)
	timeit("cpu: sha256 512MB", func() {
		for i := 0; i < 8; i++ {
			sha256.Sum256(buf)
		}
	})
	timeit("mem: fault in 256MB", func() {
		// A fresh anonymous mapping each time, so every page is a first-touch fault.
		b, err := syscall.Mmap(-1, 0, 256<<20, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_ANON|syscall.MAP_PRIVATE)
		if err != nil {
			panic(err)
		}
		for i := 0; i < len(b); i += 4096 {
			b[i] = 1
		}
		_ = syscall.Munmap(b)
	})
	timeit("syscall: 1M getppid", func() {
		for i := 0; i < 1_000_000; i++ {
			syscall.Getppid()
		}
	})
	tru := "/bin/true"
	if runtime.GOOS == "darwin" {
		tru = "/usr/bin/true"
	}
	timeit("proc: 100 fork+exec", func() {
		for i := 0; i < 100; i++ {
			if err := exec.Command(tru).Run(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
	})
}
