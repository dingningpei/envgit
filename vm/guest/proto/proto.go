// Package proto is the framing used between envgit, the L1 supervisor and the L2 agent
// (docs/design.md §3.6): a 4-byte big-endian length, a JSON object, and — when the object has a
// positive "size" — that many raw bytes following it.
package proto

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const maxHeader = 16 << 20

// Msg is the union of every request and reply field. Unused fields are omitted.
type Msg struct {
	Op        string   `json:"op,omitempty"`
	Error     string   `json:"error,omitempty"`
	Argv      []string `json:"argv,omitempty"`
	TimeoutMs int      `json:"timeout_ms,omitempty"`
	Exit      int      `json:"exit"`
	Stdout    string   `json:"stdout,omitempty"`
	Stderr    string   `json:"stderr,omitempty"`
	ID        string   `json:"id,omitempty"`
	Parent    string   `json:"parent,omitempty"`
	Base      string   `json:"base,omitempty"`
	Current   string   `json:"current,omitempty"`
	Ms        float64  `json:"ms,omitempty"`
	Bytes     int64    `json:"bytes,omitempty"`
	Size      int64    `json:"size,omitempty"`
}

func Write(w io.Writer, m Msg) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(b)))
	if _, err := w.Write(n[:]); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func Read(r io.Reader) (Msg, error) {
	var m Msg
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return m, err
	}
	size := binary.BigEndian.Uint32(n[:])
	if size > maxHeader {
		return m, fmt.Errorf("header too large: %d", size)
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(r, b); err != nil {
		return m, err
	}
	return m, json.Unmarshal(b, &m)
}

// Fail writes an error reply.
func Fail(w io.Writer, err error) { _ = Write(w, Msg{Error: err.Error()}) }
