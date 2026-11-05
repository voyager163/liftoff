package health

import (
	"context"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// listen serves every connection with handle until the test ends.
func listen(t *testing.T, handle func(net.Conn)) (string, *atomic.Int32) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	open := &atomic.Int32{}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			open.Add(1)
			go func() {
				defer open.Add(-1)
				defer conn.Close()
				handle(conn)
			}()
		}
	}()
	return fmt.Sprintf("postgresql://app:unused@%s/app", listener.Addr()), open
}

// Reads until the client closes the connection, never answering.
func silent(conn net.Conn) {
	buffer := make([]byte, 1024)
	for {
		if _, err := conn.Read(buffer); err != nil {
			return
		}
	}
}

func waitForClosed(t *testing.T, open *atomic.Int32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for open.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the probe left its connection open")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestProbeGivesUpOnADatabaseThatStoppedAnswering(t *testing.T) {
	url, open := listen(t, silent)
	started := time.Now()
	if err := DatabaseProbe(url, time.Second)(context.Background()); err == nil {
		t.Fatal("a silent server passed the check")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the check took %s", elapsed)
	}
	waitForClosed(t, open)
}

func TestProbeReportsAConnectionLostDuringTheCheck(t *testing.T) {
	// Completes the PostgreSQL startup handshake (AuthenticationOk, then
	// ReadyForQuery), then drops the connection when the query arrives.
	handshake := []byte{'R', 0, 0, 0, 8, 0, 0, 0, 0, 'Z', 0, 0, 0, 5, 'I'}
	url, open := listen(t, func(conn net.Conn) {
		buffer := make([]byte, 1024)
		if _, err := conn.Read(buffer); err != nil {
			return
		}
		if _, err := conn.Write(handshake); err != nil {
			return
		}
		_, _ = conn.Read(buffer)
	})
	if err := DatabaseProbe(url, 2*time.Second)(context.Background()); err == nil {
		t.Fatal("a dropped connection passed the check")
	}
	waitForClosed(t, open)
}

func TestProbeRejectsAnInvalidURL(t *testing.T) {
	if err := DatabaseProbe("not a url ::", time.Second)(context.Background()); err == nil {
		t.Fatal("an invalid URL passed the check")
	}
}
